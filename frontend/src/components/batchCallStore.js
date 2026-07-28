// ══════════════════════════════════════════════════════════════
// batchCallStore.js — module-level store for batch calling.
//
// WHY THIS FILE EXISTS: React state inside PageAgentProfiles dies
// the moment the user clicks to another page (component unmounts).
// A batch call loop mid-run would just vanish. Moving all batch
// state + the dialing loop itself into plain module-scope variables
// fixes that — this module is only evaluated once by the bundler,
// so its variables live for the whole app session regardless of
// which page is currently mounted. Components subscribe to it with
// useBatchStore() and re-render when it changes; the loop itself
// doesn't care whether anyone's listening.
//
// FIX v5 vs previous version:
// 1. No more DIALING/RINGING statuses. A row stays PENDING the whole
//    time its call is live — it's written exactly once more, with the
//    FINAL status, and that's it. "Waiting for carrier…" type
//    intermediate states are gone.
// 2. Status source is Plivo's own CDR hangup_cause (via server.py's
//    GET /api/plivo/call-status), not Supabase live_outcome. That
//    table doesn't get a row until a WS session starts, so Busy/
//    No-Answer/Rejected/Canceled calls used to hang forever — this
//    reads directly from Plivo's call log, which every call gets.
// 3. Before the NEXT row dials, the current row's status is already
//    fully resolved — dialRow() is awaited start-to-finish inside the
//    loop, so there's no "next call starts before previous status is
//    known" race to begin with.
// 4. Resume: startBatch() looks at the row the pointer was left on.
//    Since a row is now ONLY ever written with a terminal status or
//    left at PENDING (no in-between states to get confused by), "not
//    terminal" always means "never got a real outcome" — so resume
//    redials that exact row instead of skipping it. Stopped/paused
//    mid-call still lets the in-flight call finish first (control
//    flags are only checked between rows), so this never races either.
// 5. FIXED — empty-sheet bug: live write-back was building an xlsx
//    binary buffer and handing it straight to
//    FileSystemWritableFileStream.write(), which doesn't reliably
//    accept a raw typed array across browsers — if that write ever
//    failed, the file had ALREADY been truncated by createWritable(),
//    leaving an empty file on disk. Live write-back now always writes
//    plain CSV text (a string, which write() handles correctly),
//    regardless of whether the source was .csv or .xlsx. The manual
//    "Export Sheet" button is unaffected — it still exports in the
//    original format via XLSX.writeFile, a different, unaffected path.
//
// NEW DEPENDENCY — run: npm install xlsx
// ══════════════════════════════════════════════════════════════
import * as XLSX from 'xlsx'
import { useState, useEffect } from 'react'

export const COUNTRY_CODES = [
  { code: '91',  label: '🇮🇳 +91 India' },
  { code: '1',   label: '🇺🇸 +1 USA/Canada' },
  { code: '44',  label: '🇬🇧 +44 UK' },
  { code: '61',  label: '🇦🇺 +61 Australia' },
  { code: '971', label: '🇦🇪 +971 UAE' },
  { code: '65',  label: '🇸🇬 +65 Singapore' },
]

export function toE164(rawValue, defaultCountryCode) {
  let v = String(rawValue ?? '').trim()
  if (!v) return ''
  const hadPlus = v.startsWith('+')
  const digits = v.replace(/\D/g, '')
  if (hadPlus) return '+' + digits
  if (defaultCountryCode && digits.startsWith(defaultCountryCode) && digits.length > 10) {
    return '+' + digits
  }
  return '+' + defaultCountryCode + digits
}

const PHONE_HEADER_CANDIDATES = ['phone', 'phone number', 'number', 'mobile', 'contact', 'to', 'phone_number']

export const BATCH_STATUSES = {
  PENDING:   'Pending',
  CONNECTED: 'Connected',
  NO_ANSWER: 'No Answer',
  BUSY:      'Busy',
  REJECTED:  'Rejected',
  FAILED:    'Failed',
  UNKNOWN:   'Unknown', // Plivo never returned a hangup_cause in time — not the same as No Answer, don't guess
}

// Plivo's hangup_cause string, exactly as calls.get() / the console logs
// return it, aliased to our statuses. Anything not listed (Canceled,
// carrier/system/URL/XML errors, etc.) falls through to FAILED.
// Full list: plivo.com/docs/voice/troubleshooting/hangup-causes
const HANGUP_CAUSE_ALIAS = {
  'Normal Hangup':        BATCH_STATUSES.CONNECTED,
  'No Answer':            BATCH_STATUSES.NO_ANSWER,
  'Ring Timeout Reached': BATCH_STATUSES.NO_ANSWER,
  'Busy Line':            BATCH_STATUSES.BUSY,
  'Busy everywhere':      BATCH_STATUSES.BUSY,
  'Rejected':             BATCH_STATUSES.REJECTED,
  'Declined':             BATCH_STATUSES.REJECTED,
  'Forbidden':            BATCH_STATUSES.REJECTED,
}
function aliasHangupCause(rawCause) {
  return HANGUP_CAUSE_ALIAS[rawCause] || BATCH_STATUSES.FAILED
}

// ── module-scope state (the whole point) ──────────────────────
const state = {
  countryCode: '91',
  agentId: '',
  fileName: '',
  fileType: '',        // 'csv' | 'xlsx'
  columns: [],
  phoneKey: '',
  rows: [],             // [{ __row, __phone, __status, __call_uuid, __hangupCause, ...original }]
  index: -1,             // pointer row currently being dialed
  running: false,
  currentLog: null,      // single current-row entry, not an array
  fileHandle: null,      // File System Access API handle, if granted (Chromium only)
  canLiveWrite: false,
  sheetLinkUrl: '',      // Google Sheet "publish to web" CSV url, if used (read-only)
}

const control = { stopRequested: false, pause: false, loopAlive: false }
// PENDING is the ONLY non-terminal status now (no DIALING/RINGING) —
// so "not in this set" always means "never resolved", which is exactly
// what resume needs to know whether to redial a row.
const TERMINAL_STATUSES = [
  BATCH_STATUSES.CONNECTED, BATCH_STATUSES.NO_ANSWER, BATCH_STATUSES.BUSY,
  BATCH_STATUSES.REJECTED, BATCH_STATUSES.FAILED, BATCH_STATUSES.UNKNOWN,
]
const listeners = new Set()

function notify() {
  const snapshot = { ...state }
  listeners.forEach(cb => cb(snapshot))
}

export function useBatchStore() {
  const [snap, setSnap] = useState({ ...state })
  useEffect(() => {
    listeners.add(setSnap)
    setSnap({ ...state }) // catch up in case store changed while unmounted
    return () => listeners.delete(setSnap)
  }, [])
  return snap
}

// ── setters used by the UI ─────────────────────────────────────
export function setCountryCode(v) { state.countryCode = v; notify() }
export function setAgentId(v) { state.agentId = v; notify() }

// ── file loading (input[type=file] fallback path — no live write) ──
export function loadFromFileInput(file) {
  state.fileName = file.name
  state.fileType = file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'xlsx'
  state.fileHandle = null
  state.canLiveWrite = false
  state.sheetLinkUrl = ''

  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (evt) => {
      try {
        parseWorkbookBinary(evt.target.result)
        resolve()
      } catch (err) { reject(err) }
    }
    reader.onerror = reject
    reader.readAsBinaryString(file)
  })
}

// ── file loading via File System Access API — enables live write-back.
// Chromium browsers only (Chrome/Edge). Firefox/Safari: use loadFromFileInput.
export async function loadFromFilePicker() {
  if (!window.showOpenFilePicker) {
    throw new Error('Live sheet updates need Chrome or Edge (File System Access API not supported in this browser). Use the plain file picker instead — you can still export manually after the run.')
  }
  const [handle] = await window.showOpenFilePicker({
    types: [{ description: 'Spreadsheet', accept: { 'text/csv': ['.csv'], 'application/vnd.ms-excel': ['.xls', '.xlsx'] } }],
  })
  const perm = await handle.requestPermission({ mode: 'readwrite' })
  if (perm !== 'granted') throw new Error('Write permission denied — falling back to manual export only.')

  const file = await handle.getFile()
  state.fileName = file.name
  state.fileType = file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'xlsx'
  state.fileHandle = handle
  state.canLiveWrite = true
  state.sheetLinkUrl = ''

  const buf = await file.arrayBuffer()
  parseWorkbookBinary(buf)
}

function parseWorkbookBinary(binaryOrBuffer) {
  const wb = XLSX.read(binaryOrBuffer, { type: typeof binaryOrBuffer === 'string' ? 'binary' : 'array' })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  const json = XLSX.utils.sheet_to_json(sheet, { defval: '' })
  if (!json.length) throw new Error('Sheet is empty')

  const cols = Object.keys(json[0])
  const guess = cols.find(c => PHONE_HEADER_CANDIDATES.includes(c.trim().toLowerCase())) || cols[0]

  state.columns = cols
  state.phoneKey = guess
  state.rows = json.map((row, i) => ({
    __row: i + 1,
    __phone: String(row[guess] ?? ''),
    __status: BATCH_STATUSES.PENDING,
    __call_uuid: '',
    __hangupCause: '',
    ...row,
  }))
  state.index = -1
  state.currentLog = null
  notify()
}

// ── Google Sheet import (READ-ONLY) ────────────────────────────
// Requires the sheet to be published: File > Share > Publish to web > CSV.
// Live write-back to Google Sheets needs the Sheets API + OAuth (a backend
// job, not something the browser can do directly) — not implemented here.
export async function loadFromGoogleSheetCsvUrl(url) {
  if (!url.includes('output=csv') && !url.includes('/pub')) {
    throw new Error('Use the "Publish to web → CSV" link (File > Share > Publish to web), not the normal share link.')
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error('Could not fetch the sheet — check it is published and the link is correct.')
  const text = await res.text()

  state.fileName = 'google_sheet_import.csv'
  state.fileType = 'csv'
  state.fileHandle = null
  state.canLiveWrite = false // no write-back to Google Sheets — read-only
  state.sheetLinkUrl = url

  parseWorkbookBinary(text)
}

// Puts "Call Status" (and the raw hangup cause) right after the phone
// column instead of tacking them on at the end. Original columns keep
// their order otherwise.
function rowsWithStatusColumn() {
  return state.rows.map(r => {
    const { __row, __phone, __call_uuid, __status, __hangupCause, ...original } = r
    const out = {}
    for (const key of state.columns) {
      out[key] = original[key]
      if (key === state.phoneKey) {
        out['Call Status'] = __status
        out['Hangup Cause'] = __hangupCause || ''
      }
    }
    // safety net: if phoneKey somehow wasn't in columns, still include status
    if (!(state.phoneKey in out)) {
      out['Call Status'] = __status
      out['Hangup Cause'] = __hangupCause || ''
    }
    return out
  })
}

function updateRow(rowIdx, patch) {
  state.rows = state.rows.map((r, i) => i === rowIdx ? { ...r, ...patch } : r)
  notify()
}

function setCurrentLog(entry) {
  state.currentLog = { time: new Date(), ...entry }
  notify()
}

// ── live write-back after every row ────────────────────────────
// Always writes plain CSV TEXT, regardless of whether the source file
// was .csv or .xlsx — see FIX v5 note #5 at the top. A string is a
// write() type every browser's FileSystemWritableFileStream handles
// correctly; a raw xlsx binary array was the actual cause of the
// empty-sheet bug (createWritable() truncates the file immediately,
// and if the subsequent binary write ever failed, nothing replaced it).
async function writeBackIfPossible() {
  if (!state.canLiveWrite || !state.fileHandle) return
  try {
    const exportRows = rowsWithStatusColumn()
    const ws = XLSX.utils.json_to_sheet(exportRows)
    const csv = XLSX.utils.sheet_to_csv(ws)
    const writable = await state.fileHandle.createWritable()
    await writable.write(csv)
    await writable.close()
  } catch (err) {
    console.error('Live sheet write failed:', err)
  }
}

// ── resolveFinalStatus ───────────────────────────────────────────
// Polls server.py's /api/plivo/call-status (Plivo's own CDR hangup_cause)
// instead of Supabase. hangup_cause is empty the whole time the call is
// ringing/in-progress — the CDR only exists once it's completed/failed
// — so an empty response just means "keep waiting", not an error.
// This is awaited fully inside dialRow before the batch loop moves to
// the next row, so the previous row's status is always resolved before
// the next call starts.
async function resolveFinalStatus(callUuid, rowIdx, callHandlerUrl, maxAttempts = 25, intervalMs = 7000) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(res => setTimeout(res, intervalMs))
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10000) // 10s — never let one poll hang the whole batch
      let res
      try {
        res = await fetch(`${callHandlerUrl}/api/plivo/call-status?call_uuid=${encodeURIComponent(callUuid)}`, { signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }
      const data = await res.json()
      if (!data.hangup_cause) continue // call still live — CDR not written yet

      const status = aliasHangupCause(data.hangup_cause)
      updateRow(rowIdx, { __status: status, __hangupCause: data.hangup_cause })
      setCurrentLog({ row: rowIdx + 1, phone: state.rows[rowIdx]?.__phone, message: data.hangup_cause, level: status === BATCH_STATUSES.CONNECTED ? 'ok' : 'info' })
      await writeBackIfPossible()
      return
    } catch {
      // non-fatal — keep polling
    }
  }
  updateRow(rowIdx, { __status: BATCH_STATUSES.UNKNOWN })
  setCurrentLog({ row: rowIdx + 1, phone: state.rows[rowIdx]?.__phone, message: `No hangup_cause after ${maxAttempts * intervalMs / 1000}s — left as Unknown, not guessed`, level: 'err' })
  await writeBackIfPossible()
}

async function dialRow(row, rowIdx, voiceServerUrl, callHandlerUrl) {
  const to = toE164(row.__phone, state.countryCode)
  if (!to || to === '+' + state.countryCode) {
    updateRow(rowIdx, { __status: BATCH_STATUSES.FAILED })
    setCurrentLog({ row: rowIdx + 1, phone: row.__phone, message: 'No phone number in row', level: 'err' })
    await writeBackIfPossible()
    return
  }

  // No status write here — row stays PENDING until the final outcome.
  // Log line is transient UI feedback only, not a persisted state.
  setCurrentLog({ row: rowIdx + 1, phone: to, message: 'Calling…', level: 'info' })

  try {
    const res = await fetch(`${voiceServerUrl}/api/outbound-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, agent_id: state.agentId }),
    })
    const data = await res.json()

    if (!res.ok || data.error) {
      updateRow(rowIdx, { __status: BATCH_STATUSES.FAILED })
      setCurrentLog({ row: rowIdx + 1, phone: to, message: 'Failed: ' + (data.error || res.statusText), level: 'err' })
      await writeBackIfPossible()
      return
    }

    if (!data.call_uuid) {
      // server.py already waits for the answer webhook before responding;
      // still empty means the carrier rejected before Plivo ever dialed.
      updateRow(rowIdx, { __status: BATCH_STATUSES.FAILED })
      setCurrentLog({ row: rowIdx + 1, phone: to, message: 'No call_uuid — answer webhook never fired', level: 'err' })
      await writeBackIfPossible()
      return
    }

    updateRow(rowIdx, { __call_uuid: data.call_uuid })
    await resolveFinalStatus(data.call_uuid, rowIdx, callHandlerUrl)
  } catch (e) {
    updateRow(rowIdx, { __status: BATCH_STATUSES.FAILED })
    setCurrentLog({ row: rowIdx + 1, phone: to, message: 'Failed: ' + e.message, level: 'err' })
    await writeBackIfPossible()
  }
}

// ── run controls — plain functions, not tied to any component's
// lifecycle, so the loop survives page navigation.
// BUG FIX — the old version let Resume call startBatch() a second time
// while the FIRST call's loop was still alive (just parked inside
// `while (control.pause) {...}`, because pauseBatch() only flips a flag —
// it never lets the loop function return). state.running was already
// false by then (pauseBatch set it), so the `|| state.running` guard did
// nothing to stop it, and TWO loops ended up dialing at once — the
// "pause then two people ring" bug. Fix: control.loopAlive tracks
// whether the loop function itself is still on the stack, independent of
// state.running (which only means "actively dialing, not paused"). If
// the loop is already alive, startBatch() just clears the pause flag and
// returns — it does NOT start a second loop.
export async function startBatch(voiceServerUrl, callHandlerUrl) {
  if (!state.rows.length || !state.agentId) return

  if (control.loopAlive) {
    // Loop already running (parked on pause) — resume in place.
    control.pause = false
    control.stopRequested = false
    state.running = true
    notify()
    return
  }

  control.loopAlive = true
  control.stopRequested = false
  control.pause = false
  state.running = true
  notify()

  // Resume: if the pointer is sitting on a row that's still PENDING
  // (the only non-terminal status now — no DIALING/RINGING to get
  // confused by), a previous Stop/Pause landed mid-call on it, so
  // redial that exact row. Otherwise it already resolved — move on.
  let startFrom
  if (state.index >= 0 && state.index < state.rows.length) {
    const cur = state.rows[state.index]
    startFrom = TERMINAL_STATUSES.includes(cur.__status) ? state.index + 1 : state.index
  } else {
    startFrom = 0
  }

  for (let i = startFrom; i < state.rows.length; i++) {
    // BUG FIX — this used to only check control.pause, so a Stop sent
    // while paused was invisible until someone unpaused first. Now Stop
    // breaks out immediately even mid-pause.
    while (control.pause && !control.stopRequested) {
      await new Promise(res => setTimeout(res, 500))
    }
    if (control.stopRequested) break

    state.index = i
    notify()
    // dialRow always runs to completion — including resolveFinalStatus —
    // before stopRequested/pause is checked again below. "Stop"/"Pause"
    // let the in-flight call resolve rather than abandoning it mid-ring.
    await dialRow(state.rows[i], i, voiceServerUrl, callHandlerUrl)

    if (control.stopRequested) break
    await new Promise(res => setTimeout(res, 1500))
  }

  control.loopAlive = false
  state.running = false
  // Pointer intentionally NOT reset to -1 here — it stays on the last
  // row touched so a later Start resumes correctly.
  notify()
}

export function pauseBatch() {
  control.pause = true
  state.running = false
  notify()
}

// Graceful stop: does not abort the in-flight call. It flips a flag the
// loop checks only between rows, so whatever call is currently ringing
// finishes and gets its real outcome before the batch actually halts.
// Works even if currently paused (see the loop's while-check above).
export function stopBatch() {
  control.stopRequested = true
  control.pause = false
  notify()
}

export function exportBatchSheet() {
  if (!state.rows.length) return
  const exportRows = rowsWithStatusColumn()
  const ws = XLSX.utils.json_to_sheet(exportRows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Calls')
  const base = state.fileName ? state.fileName.replace(/\.[^.]+$/, '') : 'batch_calls'
  XLSX.writeFile(wb, `${base}_status.xlsx`)
}