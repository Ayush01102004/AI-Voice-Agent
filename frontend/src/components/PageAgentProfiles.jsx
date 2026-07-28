// ══════════════════════════════════════════════════════════════
// PAGE: Agent Profiles
// ══════════════════════════════════════════════════════════════
//
// NEW — batch calling state/logic now lives in batchCallStore.js
// (module-level, survives page navigation). This file only renders
// against that store. Adjust the import path to wherever you place
// batchCallStore.js relative to this file.
import {
  useBatchStore, COUNTRY_CODES, toE164, BATCH_STATUSES,
  setCountryCode as setBatchCountryCodeStore, setAgentId as setBatchAgentIdStore,
  loadFromFileInput, loadFromFilePicker, loadFromGoogleSheetCsvUrl,
  startBatch, pauseBatch, stopBatch, exportBatchSheet,
} from './batchCallStore'

// NEW: base URL for the voice server (server.py) — separate from
// CALL_HANDLER_URL (call_handler.py). Set this in your env/config,
// e.g. const VOICE_SERVER_URL = import.meta.env.VITE_VOICE_SERVER_URL
const VOICE_SERVER_URL = import.meta.env.VITE_VOICE_SERVER_URL || 'http://localhost:8080'

function PageAgentProfiles({ showToast }) {
  const [agents, setAgents] = useState([])
  const [agentsLoading, setAgentsLoading] = useState(true)
  const [selectedId, setSelectedId] = useState('')

  const [name, setName] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [prompt, setPrompt] = useState('')
  const [promptLoading, setPromptLoading] = useState(false)
  const [savingPrompt, setSavingPrompt] = useState(false)
  const [dirty, setDirty] = useState(false)

  const [showCreate, setShowCreate] = useState(false)
  const [newId, setNewId] = useState('')
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  const [rollback, setRollback] = useState([])
  const [hoveredLogId, setHoveredLogId] = useState(null)

  const [plivoNumbers, setPlivoNumbers] = useState([])
  const [plivoLoading, setPlivoLoading] = useState(false)
  const [plivoError, setPlivoError] = useState('')
  const [linkingNumber, setLinkingNumber] = useState(null)

  async function loadPlivoNumbers() {
    setPlivoLoading(true)
    setPlivoError('')
    try {
      const res = await fetch(`${CALL_HANDLER_URL}/api/plivo/numbers`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Failed to fetch numbers')
      setPlivoNumbers(data.numbers || [])
    } catch (e) {
      setPlivoError(e.message)
    }
    setPlivoLoading(false)
  }

  useEffect(() => { loadPlivoNumbers() }, [])

  async function linkNumberToSelected(number, region) {
    if (!selectedId) return
    setLinkingNumber(number)
    try {
      const res = await fetch(`${CALL_HANDLER_URL}/api/plivo/link-number`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: selectedId, number, region }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Link failed')
      showToast(`${number} → ${name || selectedId} ✓`)
      await loadPlivoNumbers()
    } catch (e) {
      showToast('Link failed: ' + e.message, 'err')
    }
    setLinkingNumber(null)
  }

  async function unlinkNumber(number) {
    setLinkingNumber(number)
    try {
      const res = await fetch(`${CALL_HANDLER_URL}/api/plivo/unlink-number`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Unlink failed')
      showToast(`${number} unlinked`)
      await loadPlivoNumbers()
    } catch (e) {
      showToast('Unlink failed: ' + e.message, 'err')
    }
    setLinkingNumber(null)
  }

  const [togglingActive, setTogglingActive] = useState(false)
  const [activeCount, setActiveCount] = useState(null)

  async function loadActiveCount() {
    try {
      const res = await fetch(`${CALL_HANDLER_URL}/api/agents/active-count`)
      const data = await res.json()
      if (res.ok) setActiveCount(data)
    } catch (e) {
      // non-fatal
    }
  }

  useEffect(() => { loadActiveCount() }, [])

  async function toggleAgentActive(nextValue) {
    if (!selectedId) return
    setTogglingActive(true)
    try {
      const res = await fetch(`${CALL_HANDLER_URL}/api/agents/${selectedId}/toggle`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: nextValue }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Toggle failed')

      setAgents(prev => prev.map(a => a.agent_id === selectedId ? { ...a, is_active: nextValue } : a))
      showToast(`${name || selectedId} ${nextValue ? 'activated' : 'deactivated'} ✓`)
      await loadActiveCount()
    } catch (e) {
      showToast('Toggle failed: ' + e.message, 'err')
    }
    setTogglingActive(false)
  }

  async function loadAgents(selectAfter) {
    setAgentsLoading(true)
    const { data, error } = await supabase
      .from('agents')
      .select('agent_id, name, phone_number, is_active')
      .order('created_at', { ascending: true })

    if (error) {
      showToast('Failed to load agents: ' + error.message, 'err')
      setAgentsLoading(false)
      return
    }

    const list = data || []
    setAgents(list)
    setAgentsLoading(false)

    if (selectAfter) {
      setSelectedId(selectAfter)
    } else if (!selectedId && list.length) {
      setSelectedId(list[0].agent_id)
    }
  }

  useEffect(() => { loadAgents() }, [])

  useEffect(() => {
    if (!selectedId) return

    const a = agents.find(x => x.agent_id === selectedId)
    setName(a?.name || '')
    setPhoneNumber(a?.phone_number || '')

    setPromptLoading(true)
    setDirty(false)

    supabase
      .from('agent_config')
      .select('value')
      .eq('agent_id', selectedId)
      .eq('key', 'system_prompt')
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) {
          showToast('Failed to load prompt: ' + error.message, 'err')
        }
        setPrompt(data?.value || '')
        setPromptLoading(false)
      })

    supabase
      .from('prompt_versions')
      .select('id, prompt_value, rollback_note, created_at')
      .eq('agent_id', selectedId)
      .order('created_at', { ascending: false })
      .limit(10)
      .then(({ data, error }) => {
        if (!error) setRollback(data || [])
      })
  }, [selectedId, agents])

  async function saveField(field, value) {
    const { error } = await supabase
      .from('agents')
      .update({ [field]: value || null })
      .eq('agent_id', selectedId)

    if (error) {
      showToast('Save failed: ' + error.message, 'err')
      return
    }
    setAgents(prev => prev.map(a => a.agent_id === selectedId ? { ...a, [field]: value || null } : a))
  }

  async function savePrompt() {
    setSavingPrompt(true)

    const { error } = await supabase
      .from('agent_config')
      .upsert(
        { agent_id: selectedId, key: 'system_prompt', value: prompt, updated_at: new Date().toISOString() },
        { onConflict: 'agent_id,key' }
      )

    if (error) {
      setSavingPrompt(false)
      showToast('Prompt save failed: ' + error.message, 'err')
      return
    }

    await supabase.from('prompt_versions').insert({
      agent_id: selectedId,
      prompt_key: 'system_prompt',
      prompt_value: prompt,
      rollback_note: 'Manual update',
    })

    setSavingPrompt(false)
    setDirty(false)
    showToast('Prompt saved ✓')

    const { data } = await supabase
      .from('prompt_versions')
      .select('id, prompt_value, rollback_note, created_at')
      .eq('agent_id', selectedId)
      .order('created_at', { ascending: false })
      .limit(10)
    setRollback(data || [])
  }

  async function rollbackTo(value) {
    setPrompt(value)
    setDirty(true)
  }

  async function createAgent() {
    const id = newId.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
    if (!id || !newName.trim()) {
      showToast('Agent ID and name are required', 'err')
      return
    }

    setCreating(true)

    const { error: agentErr } = await supabase
      .from('agents')
      .insert({ agent_id: id, name: newName.trim() })

    if (agentErr) {
      setCreating(false)
      showToast('Create failed: ' + agentErr.message, 'err')
      return
    }

    const { error: cfgErr } = await supabase
      .from('agent_config')
      .insert({ agent_id: id, key: 'system_prompt', value: '', updated_at: new Date().toISOString() })

    if (cfgErr) {
      setCreating(false)
      showToast('Agent created, but prompt row failed: ' + cfgErr.message, 'err')
    } else {
      showToast(`Agent "${newName.trim()}" created ✓ — assign a number below`)
    }

    setCreating(false)
    setShowCreate(false)
    setNewId(''); setNewName('')
    await loadAgents(id)
    await loadActiveCount()
  }

  async function deleteAgent() {
    if (selectedId === 'default') { showToast('Cannot delete the default agent', 'err'); return }
    if (!window.confirm(`Delete agent "${name || selectedId}"? This removes its prompt and any numbers assigned to it.`)) return

    await supabase.from('agent_config').delete().eq('agent_id', selectedId)
    await supabase.from('prompt_versions').delete().eq('agent_id', selectedId)
    await supabase.from('agent_numbers').delete().eq('agent_id', selectedId)
    const { error } = await supabase.from('agents').delete().eq('agent_id', selectedId)

    if (error) {
      showToast('Delete failed: ' + error.message, 'err')
      return
    }

    showToast('Agent deleted')
    await loadAgents('default')
    await loadActiveCount()
    await loadPlivoNumbers()
  }

  // ────────────────────────────────────────────────────────────
  // NEW: dashboard voice-server client — outbound call trigger.
  // Hits server.py's POST /api/outbound-call directly (to, agent_id).
  // Tracks only the current dial attempt's status, not a growing log.
  // ────────────────────────────────────────────────────────────
  const [dialCountryCode, setDialCountryCode] = useState('91') // NEW
  const [dialTo, setDialTo] = useState('')
  const [dialAgentId, setDialAgentId] = useState('')
  const [dialing, setDialing] = useState(false)
  const [callStatus, setCallStatus] = useState(null) // { status, message, time }

  useEffect(() => {
    if (!dialAgentId && agents.length) setDialAgentId(agents[0].agent_id)
  }, [agents, dialAgentId])

  async function placeCall() {
    const to = toE164(dialTo, dialCountryCode) // NEW — prefix applied here
    if (!dialTo.trim()) { showToast('Enter a phone number to call', 'err'); return }
    if (!dialAgentId) { showToast('Select an agent', 'err'); return }

    const agentLabel = agents.find(a => a.agent_id === dialAgentId)?.name || dialAgentId

    setDialing(true)
    setCallStatus({ status: 'dialing', message: `Dialing ${to} via ${agentLabel}…`, time: new Date() })

    try {
      const res = await fetch(`${VOICE_SERVER_URL}/api/outbound-call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, agent_id: dialAgentId }),
      })
      const data = await res.json()

      if (!res.ok || data.error) {
        setCallStatus({ status: 'failed', message: data.error || 'Call failed', time: new Date() })
        showToast('Call failed: ' + (data.error || res.statusText), 'err')
      } else {
        setCallStatus({
          status: 'placed',
          message: `Call placed ✓ from=${data.from || '—'} call_uuid=${data.call_uuid || '—'}`,
          time: new Date(),
        })
        showToast(`Call to ${to} placed ✓`)
        setTimeout(() => setCallStatus(null), 30000)
      }
    } catch (e) {
      setCallStatus({ status: 'failed', message: e.message, time: new Date() })
      showToast('Call failed: ' + e.message, 'err')
    }

    setDialing(false)
  }

  const statusColor = {
    dialing: 'var(--accent)',
    placed: '#4ade80',
    failed: 'var(--hot)',
  }

  // ────────────────────────────────────────────────────────────
  // NEW: BATCH CALLING — everything reads from batchCallStore.js.
  // No local state, no local loop — this component just renders
  // the current store snapshot and calls the store's functions.
  // ────────────────────────────────────────────────────────────
  const batch = useBatchStore()
  const [sheetLinkInput, setSheetLinkInput] = useState('')
  const [sheetLinkLoading, setSheetLinkLoading] = useState(false)
  const fileInputRef = useRef(null)

  useEffect(() => {
    if (!batch.agentId && agents.length) setBatchAgentIdStore(agents[0].agent_id)
  }, [agents, batch.agentId])

  async function handleBatchFileInput(e) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      await loadFromFileInput(file)
      showToast(`Loaded ${file.name} (no live write-back on this upload path — export manually when done)`)
    } catch (err) {
      showToast('Failed to parse file: ' + err.message, 'err')
    }
  }

  async function handleBatchFilePicker() {
    try {
      await loadFromFilePicker()
      showToast('Loaded — status will write back to this file after every call ✓')
    } catch (err) {
      showToast(err.message, 'err')
    }
  }

  async function handleSheetLink() {
    if (!sheetLinkInput.trim()) return
    setSheetLinkLoading(true)
    try {
      await loadFromGoogleSheetCsvUrl(sheetLinkInput.trim())
      showToast('Sheet loaded (read-only — export locally to save status, no write-back to Google Sheets)')
    } catch (err) {
      showToast(err.message, 'err')
    }
    setSheetLinkLoading(false)
  }

  function handleStartBatch() {
    if (!batch.rows.length) { showToast('Upload a sheet first', 'err'); return }
    if (!batch.agentId) { showToast('Select an agent', 'err'); return }
    startBatch(VOICE_SERVER_URL, CALL_HANDLER_URL)
    showToast(batch.index >= 0 ? 'Resuming batch…' : 'Batch calling started')
  }

  function handlePauseBatch() {
    pauseBatch()
    showToast('Batch paused')
  }

  function handleStopBatch() {
    stopBatch()
    showToast('Stopping — letting the current call finish first…')
  }

  function handleExportBatch() {
    if (!batch.rows.length) { showToast('Nothing to export', 'err'); return }
    exportBatchSheet()
    showToast('Sheet exported ✓')
  }

  const batchStatusColor = {
    [BATCH_STATUSES.PENDING]:   'var(--text3)',
    [BATCH_STATUSES.CONNECTED]: '#4ade80',
    [BATCH_STATUSES.NO_ANSWER]: 'var(--warm, #f5a623)',
    [BATCH_STATUSES.BUSY]:      'var(--warm, #f5a623)',
    [BATCH_STATUSES.REJECTED]:  'var(--hot)',
    [BATCH_STATUSES.FAILED]:    'var(--hot)',
    [BATCH_STATUSES.UNKNOWN]:   'var(--text3)',
  }

  const inputStyle = {
    width: '100%', background: 'var(--bg3)', border: '0.5px solid var(--border)',
    borderRadius: 7, padding: '8px 10px', color: 'var(--text1)', fontSize: 13, outline: 'none',
  }

  const selectedAgentObj = agents.find(a => a.agent_id === selectedId)
  const isActive = selectedAgentObj?.is_active ?? true

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {activeCount && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text2)' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: activeCount.count > 0 ? '#4ade80' : 'var(--hot)' }} />
          <strong style={{ color: 'var(--text1)' }}>{activeCount.count} of {activeCount.total}</strong> agents active in the call pool
        </div>
      )}

      {/* DIALER CARD — call directly from the dashboard via server.py */}
      <div style={{ background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Place Call
        </span>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '0 0 150px' }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
              Country
            </label>
            <select value={dialCountryCode} onChange={e => setDialCountryCode(e.target.value)} style={inputStyle}>
              {COUNTRY_CODES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
          </div>

          <div style={{ flex: '1 1 220px' }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
              Phone Number
            </label>
            <input
              value={dialTo}
              onChange={e => setDialTo(e.target.value)}
              placeholder="e.g. 9876543210"
              style={inputStyle}
            />
          </div>

          <div style={{ flex: '1 1 220px' }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
              Agent
            </label>
            <select
              value={dialAgentId}
              onChange={e => setDialAgentId(e.target.value)}
              disabled={agentsLoading}
              style={inputStyle}
            >
              {agentsLoading && <option>Loading…</option>}
              {!agentsLoading && agents.length === 0 && <option>No agents found</option>}
              {agents.map(a => (
                <option key={a.agent_id} value={a.agent_id}>
                  {a.name || '—'} ({a.agent_id}){a.is_active === false ? ' — inactive' : ''}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={placeCall}
            disabled={dialing || !dialTo.trim() || !dialAgentId}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px',
              background: dialing ? 'var(--bg3)' : 'var(--accent)', border: 'none', borderRadius: 8,
              color: dialing ? 'var(--text3)' : '#fff', fontSize: 13, fontWeight: 600,
              cursor: dialing ? 'default' : 'pointer', opacity: (!dialTo.trim() || !dialAgentId) ? 0.6 : 1,
            }}
          >
            <PhoneCall size={14} /> {dialing ? 'Dialing…' : 'Call'}
          </button>
        </div>

        {dialTo.trim() && (
          <p style={{ fontSize: 11, color: 'var(--text3)', margin: 0 }}>
            Will dial as: <span style={{ fontFamily: 'monospace', color: 'var(--text2)' }}>{toE164(dialTo, dialCountryCode)}</span>
          </p>
        )}

        {/* CURRENT CALL STATUS — clears itself after the call is placed */}
        {callStatus && (
          <div style={{ borderTop: '0.5px solid var(--border)', paddingTop: 10, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor[callStatus.status] || 'var(--text3)', flexShrink: 0 }} />
            <span style={{ color: 'var(--text3)' }}>{callStatus.time.toLocaleTimeString()}</span>
            <span style={{ color: 'var(--text1)' }}>{callStatus.message}</span>
          </div>
        )}
      </div>

      {/* NEW: BATCH CALLING CARD — reads/writes batchCallStore.js */}
      <div style={{ background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Batch Calling
          </span>
          {batch.rows.length > 0 && (
            <span style={{
              fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 10,
              background: batch.canLiveWrite ? 'rgba(74,222,128,0.15)' : 'rgba(245,166,35,0.15)',
              color: batch.canLiveWrite ? '#4ade80' : 'var(--warm, #f5a623)',
            }}>
              {batch.canLiveWrite ? 'Live write ✓' : 'Manual export only'}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '0 0 150px' }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
              Country
            </label>
            <select value={batch.countryCode} onChange={e => setBatchCountryCodeStore(e.target.value)} style={inputStyle} disabled={batch.running}>
              {COUNTRY_CODES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
          </div>

          <div style={{ flex: '1 1 220px' }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
              Agent
            </label>
            <select value={batch.agentId} onChange={e => setBatchAgentIdStore(e.target.value)} style={inputStyle} disabled={batch.running || agentsLoading}>
              {agentsLoading && <option>Loading…</option>}
              {agents.map(a => (
                <option key={a.agent_id} value={a.agent_id}>{a.name || '—'} ({a.agent_id})</option>
              ))}
            </select>
          </div>
        </div>

        {/* NEW — two ways in: pick a file with live write-back (Chrome/Edge), or plain
            upload (works everywhere, export manually when done) */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            onClick={handleBatchFilePicker}
            disabled={batch.running}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', background: 'var(--accent)', border: 'none', borderRadius: 8, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: batch.running ? 0.6 : 1 }}
          >
            <Upload size={13} /> Choose Sheet (live-write)
          </button>
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>or</span>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={handleBatchFileInput}
            disabled={batch.running}
            style={{ ...inputStyle, padding: '6px', width: 220 }}
          />
        </div>

        {/* NEW — Google Sheet import (read-only, needs Publish to web CSV link) */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={sheetLinkInput}
            onChange={e => setSheetLinkInput(e.target.value)}
            placeholder="Google Sheet 'Publish to web → CSV' link (read-only import)"
            style={{ ...inputStyle, flex: '1 1 320px' }}
            disabled={batch.running}
          />
          <button
            onClick={handleSheetLink}
            disabled={batch.running || sheetLinkLoading || !sheetLinkInput.trim()}
            style={{ padding: '7px 14px', background: 'var(--bg3)', border: '0.5px solid var(--border)', borderRadius: 8, color: 'var(--text1)', fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: (!sheetLinkInput.trim() || sheetLinkLoading) ? 0.6 : 1 }}
          >
            {sheetLinkLoading ? 'Loading…' : 'Load Sheet'}
          </button>
        </div>
        <p style={{ fontSize: 10, color: 'var(--text3)', margin: 0 }}>
          Google Sheets import is read-only — status won't write back to the live sheet (needs Sheets API + OAuth, a backend addition). Export locally instead once the run is done.
        </p>

        {batch.rows.length > 0 && (
          <p style={{ fontSize: 11, color: 'var(--text3)', margin: 0 }}>
            {batch.fileName} — {batch.rows.length} rows — phone column detected: <span style={{ color: 'var(--text2)', fontFamily: 'monospace' }}>{batch.phoneKey}</span>
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {!batch.running ? (
            <button
              onClick={handleStartBatch}
              disabled={!batch.rows.length || !batch.agentId}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: 'var(--accent)', border: 'none', borderRadius: 8, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: (!batch.rows.length || !batch.agentId) ? 0.6 : 1 }}
            >
              <Play size={14} /> {batch.index >= 0 ? 'Resume' : 'Start'} Calling
            </button>
          ) : (
            <button
              onClick={handlePauseBatch}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: 'var(--bg3)', border: '0.5px solid var(--border)', borderRadius: 8, color: 'var(--text1)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
            >
              <Pause size={14} /> Pause
            </button>
          )}
          <button
            onClick={handleStopBatch}
            disabled={!batch.running && batch.index < 0}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: 'transparent', border: '0.5px solid var(--border)', borderRadius: 8, color: 'var(--hot)', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: (!batch.running && batch.index < 0) ? 0.5 : 1 }}
          >
            <Square size={14} /> Stop
          </button>
          <button
            onClick={handleExportBatch}
            disabled={!batch.rows.length}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: 'var(--bg3)', border: '0.5px solid var(--border)', borderRadius: 8, color: 'var(--text1)', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: !batch.rows.length ? 0.5 : 1, marginLeft: 'auto' }}
          >
            <Download size={14} /> Export Sheet
          </button>
        </div>

        {/* ROWS TABLE — current row pointer + per-row status
            FIXED SCROLLBAR: in a flex-column parent, a child div's default
            min-height is "auto", which lets it grow to fit content and
            overrides maxHeight — the box never scrolls, the whole page does
            instead. minHeight: 0 removes that override. */}
        {batch.rows.length > 0 && (
          <div style={{ maxHeight: 320, minHeight: 0, overflowY: 'auto', border: '0.5px solid var(--border)', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--bg3)' }}>
                <tr>
                  <th style={{ padding: '6px 8px', textAlign: 'left', width: 24 }}></th>
                  <th style={{ padding: '6px 8px', textAlign: 'left' }}>#</th>
                  <th style={{ padding: '6px 8px', textAlign: 'left' }}>Phone</th>
                  <th style={{ padding: '6px 8px', textAlign: 'left' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {batch.rows.map((r, i) => (
                  <tr key={i} style={{ background: i === batch.index ? 'var(--bg3)' : 'transparent' }}>
                    <td style={{ padding: '6px 8px' }}>{i === batch.index && <ArrowRight size={13} color="var(--accent)" />}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--text3)' }}>{r.__row}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: 'var(--text1)' }}>{toE164(r.__phone, batch.countryCode)}</td>
                    <td style={{ padding: '6px 8px' }}>
                      <span style={{ color: batchStatusColor[r.__status] || 'var(--text3)', fontWeight: 600 }}>{r.__status}</span>
                      {r.__hangupCause && (
                        <span style={{ color: 'var(--text3)', marginLeft: 6, fontWeight: 400 }}>({r.__hangupCause})</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* NEW — single current-row log line, not a growing list */}
        {batch.currentLog && (
          <div style={{ display: 'flex', gap: 8, fontSize: 12, padding: '8px 10px', background: 'var(--bg3)', borderRadius: 8, alignItems: 'center' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: batch.currentLog.level === 'err' ? 'var(--hot)' : batch.currentLog.level === 'ok' ? '#4ade80' : 'var(--accent)' }} />
            <span style={{ color: 'var(--text3)', flexShrink: 0 }}>{batch.currentLog.time.toLocaleTimeString()}</span>
            <span style={{ color: 'var(--text3)', flexShrink: 0 }}>row {batch.currentLog.row}</span>
            <span style={{ color: 'var(--text1)' }}>{batch.currentLog.message}</span>
          </div>
        )}
      </div>

      {/* PROFILE SELECTOR */}
      <div style={{ background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Profile
          </span>

          <select
            value={selectedId}
            onChange={e => setSelectedId(e.target.value)}
            disabled={agentsLoading}
            style={{ ...inputStyle, width: 'auto', minWidth: 220 }}
          >
            {agentsLoading && <option>Loading…</option>}
            {!agentsLoading && agents.length === 0 && <option>No agents found</option>}
            {agents.map(a => (
              <option key={a.agent_id} value={a.agent_id}>
                {a.is_active === false ? '○ ' : '● '}{a.name || a.agent_id}
              </option>
            ))}
          </select>

          <div style={{ flex: 1 }} />

          <button
            onClick={() => setShowCreate(p => !p)}
            style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', background: 'var(--bg3)', border: '0.5px solid var(--border)', borderRadius: 8, color: 'var(--text2)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
          >
            <Plus size={13} /> New Agent
          </button>

          {selectedId && selectedId !== 'default' && (
            <button
              onClick={deleteAgent}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px', background: 'none', border: '0.5px solid var(--border)', borderRadius: 8, color: 'var(--hot)', fontSize: 12, cursor: 'pointer' }}
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>

        {!agentsLoading && agents.length === 0 && (
          <p style={{ fontSize: 12, color: 'var(--hot)', margin: 0 }}>
            No agents found in the database. Check that final_schema.sql has been run against this
            Supabase project, and that this browser can reach it (check .env / VITE_SUPABASE_URL).
          </p>
        )}

        {selectedId && (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24, flexWrap: 'wrap' }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
                Name
              </label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                onBlur={e => saveField('name', e.target.value.trim())}
                placeholder="e.g. Alex"
                style={{ ...inputStyle, maxWidth: 320 }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
                Phone Number
              </label>
              <input
                value={phoneNumber}
                onChange={e => setPhoneNumber(e.target.value)}
                onBlur={e => saveField('phone_number', e.target.value.trim())}
                placeholder={
                  plivoNumbers.find(n => n.assigned_agent_id === selectedId)?.number
                    ? `Linked: ${plivoNumbers.find(n => n.assigned_agent_id === selectedId).number}`
                    : 'e.g. +14155550123'
                }
                style={{ ...inputStyle, maxWidth: 220 }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
                Call Pool
              </label>
              <button
                onClick={() => toggleAgentActive(!isActive)}
                disabled={togglingActive}
                className={isActive ? styles.filterActive : ''}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px',
                  borderRadius: 20, border: '0.5px solid var(--border)',
                  background: isActive ? undefined : 'transparent',
                  color: isActive ? undefined : 'var(--text2)',
                  fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  opacity: togglingActive ? 0.6 : 1,
                }}
              >
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: isActive ? '#4ade80' : 'var(--text3)' }} />
                {isActive ? 'Active' : 'Inactive'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* PLIVO NUMBERS CARD */}
      <div style={{ background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Plivo Numbers
          </span>
          <div style={{ flex: 1 }} />
          <button
            onClick={loadPlivoNumbers}
            disabled={plivoLoading}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'var(--bg3)', border: '0.5px solid var(--border)', borderRadius: 8, color: 'var(--text1)', fontSize: 12, cursor: 'pointer', opacity: plivoLoading ? 0.6 : 1 }}
          >
            <RefreshCw size={13} className={plivoLoading ? styles.spin : ''} /> Refresh
          </button>
        </div>

        {plivoError && (
          <p style={{ fontSize: 12, color: 'var(--hot)', margin: 0 }}>{plivoError}</p>
        )}

        {!plivoError && plivoLoading && plivoNumbers.length === 0 && (
          <p style={{ fontSize: 12, color: 'var(--text3)', margin: 0 }}>Loading numbers…</p>
        )}

        {!plivoLoading && !plivoError && plivoNumbers.length === 0 && (
          <p style={{ fontSize: 12, color: 'var(--text3)', margin: 0 }}>No numbers found on this Plivo account.</p>
        )}

        {plivoNumbers.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {plivoNumbers.map(n => (
              <div key={n.number} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', background: 'var(--bg3)', borderRadius: 8, fontSize: 13 }}>
                <span style={{ fontFamily: 'monospace', color: 'var(--text1)', minWidth: 140 }}>{n.number}</span>
                <span style={{ fontSize: 11, color: 'var(--text3)' }}>{n.region || '—'}</span>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 11, color: n.assigned_agent_name ? 'var(--accent)' : 'var(--text3)' }}>
                  {n.assigned_agent_name ? `→ ${n.assigned_agent_name}` : 'Unassigned'}
                </span>
                {selectedId && n.assigned_agent_id !== selectedId && (
                  <button
                    onClick={() => linkNumberToSelected(n.number, n.region)}
                    disabled={linkingNumber === n.number}
                    style={{ padding: '5px 10px', background: 'var(--accent)', border: 'none', borderRadius: 6, color: '#fff', fontSize: 11, fontWeight: 600, cursor: 'pointer', opacity: linkingNumber === n.number ? 0.6 : 1 }}
                  >
                    {linkingNumber === n.number ? '…' : `Assign to ${name || selectedId}`}
                  </button>
                )}
                {n.assigned_agent_id === selectedId && (
                  <button
                    onClick={() => unlinkNumber(n.number)}
                    disabled={linkingNumber === n.number}
                    style={{ padding: '5px 10px', background: 'transparent', border: '0.5px solid var(--border)', borderRadius: 6, color: 'var(--hot)', fontSize: 11, cursor: 'pointer', opacity: linkingNumber === n.number ? 0.6 : 1 }}
                  >
                    Unlink
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* CREATE FORM */}
      {showCreate && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--bg2)', border: '0.5px solid var(--accent)', borderRadius: 12, padding: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <input value={newId} onChange={e => setNewId(e.target.value)} placeholder="agent_id (e.g. alex)" style={inputStyle} />
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Display name" style={inputStyle} />
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setShowCreate(false)} style={{ padding: '7px 12px', background: 'transparent', border: 'none', color: 'var(--text2)', fontSize: 12, cursor: 'pointer' }}>
              Cancel
            </button>
            <button
              onClick={createAgent}
              disabled={creating}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', background: 'var(--accent)', border: 'none', borderRadius: 7, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: creating ? 0.6 : 1 }}
            >
              <Plus size={13} /> {creating ? 'Creating…' : 'Create Agent'}
            </button>
          </div>
        </div>
      )}

      {/* PROMPT EDITOR */}
      {selectedId && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 20 }}>
          <div>
            <textarea
              value={prompt}
              onChange={e => { setPrompt(e.target.value); setDirty(true) }}
              disabled={promptLoading}
              placeholder={promptLoading ? 'Loading prompt…' : 'System prompt for this agent…'}
              style={{
                width: '100%', minHeight: 420, background: 'var(--bg2)', border: '0.5px solid var(--border)',
                borderRadius: 10, padding: 14, color: 'var(--text1)', fontSize: 13, fontFamily: 'monospace',
                lineHeight: 1.5, resize: 'vertical', outline: 'none',
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <button
                onClick={savePrompt}
                disabled={!dirty || savingPrompt || promptLoading}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px',
                  background: dirty ? 'var(--accent)' : 'var(--bg3)', border: 'none', borderRadius: 8,
                  color: dirty ? '#fff' : 'var(--text3)', fontSize: 13, fontWeight: 600,
                  cursor: dirty ? 'pointer' : 'default', opacity: savingPrompt ? 0.6 : 1,
                }}
              >
                <Save size={14} /> {savingPrompt ? 'Saving…' : 'Save Prompt'}
              </button>
              <span style={{ fontSize: 11, color: 'var(--text3)' }}>
                {Math.round((prompt || '').length / 4)} tokens (approx)
              </span>
            </div>
          </div>

          <div>
            <h3 style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 10px 0' }}>
              History
            </h3>
            {rollback.length === 0 && (
              <p style={{ fontSize: 12, color: 'var(--text3)' }}>No saved versions yet.</p>
            )}
            {rollback.map(log => (
              <div
                key={log.id}
                onMouseEnter={() => setHoveredLogId(log.id)}
                onMouseLeave={() => setHoveredLogId(null)}
                style={{ position: 'relative', background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 8, cursor: 'default' }}
              >
                <p style={{ color: 'var(--text3)', margin: '0 0 4px 0', fontSize: 11 }}>
                  {new Date(log.created_at).toLocaleString()}
                </p>
                <button
                  onClick={() => rollbackTo(log.prompt_value)}
                  style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: 11, fontWeight: 500 }}
                >
                  Load this version →
                </button>

                {hoveredLogId === log.id && (
                  <div
                    style={{
                      position: 'absolute', right: '100%', top: 0, marginRight: 10,
                      width: 380, maxHeight: 320, overflowY: 'auto',
                      background: 'var(--bg3)', border: '0.5px solid var(--border)', borderRadius: 8,
                      padding: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.45)', zIndex: 100,
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      fontSize: 11, fontFamily: 'monospace', lineHeight: 1.5,
                      color: 'var(--text1)', pointerEvents: 'none',
                    }}
                  >
                    {log.prompt_value || '(empty prompt)'}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}