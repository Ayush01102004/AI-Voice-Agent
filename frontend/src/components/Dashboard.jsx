// src/components/Dashboard.jsx
import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import PageSettings from './PageSettings'
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import {
  Phone, TrendingUp, Flame, Users, RefreshCw, Eye,
  PhoneCall, Copy, CheckCircle2, CheckCircle, AlertCircle, Radio, Search,
  Clock, Activity, BarChart2, FileText, Download, X, History,
  ClipboardList, Settings, Zap, MessageSquare, Calendar,
  Handshake, StickyNote, ChevronDown, Send, Save, ArrowLeftRight,
  Plus, Trash2, Play, Pause, Square, ArrowRight
} from 'lucide-react'
import { supabase } from '../supabaseClient'
import styles from './Dashboard.module.css'
const GOOGLE_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSdSOD2Wrt-Nfk-6YrzUjIO9HyCRRCFzHz8a5uku43Z4fhhaHA/viewform?usp=dialog'
// call_handler.py's base URL — holds the Plivo credentials, so the
// dashboard talks to it for anything Plivo (numbers list, linking a
// number to an agent) rather than calling Plivo's API directly.
const CALL_HANDLER_URL = import.meta.env.VITE_CALL_HANDLER_URL || 'http://localhost:8000'

// ── DB adapter ────────────────────────────────────────────────
function normalizeRow(row) {
  const ex = row.extracted || {}
  return {
    ...row,
    lead_category: row.lead_category || 'COLD',
    timestamp: row.created_at,
    summary: ex.summary ?? null,
    next_action: ex.next_action ?? null,
    name: ex.name ?? null,
    pain_points: Array.isArray(ex.pain_points) ? ex.pain_points : [],
    interested_services: Array.isArray(ex.interested_services) ? ex.interested_services : [],
    budget: ex.budget ?? null,
    timeline: ex.timeline ?? null,
    decision_makers: ex.decision_makers ?? null,
  }
}

function parseTranscript(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string' && raw.trim()) {
    try { return JSON.parse(raw) } catch { return [{ role: 'Agent', text: raw }] }
  }
  return []
}

async function fetchLeadsFromSupabase() {
  const { data, error } = await supabase
    .from('calls')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) throw new Error(error.message)
  return (data || []).map(normalizeRow)
}

async function fetchTranscriptFromSupabase(callSid) {
  const { data, error } = await supabase
    .from('calls')
    .select('call_sid, transcript, extracted, to_number, lead_category, created_at, duration_sec')
    .eq('call_sid', callSid)
    .single()
  if (error) throw new Error(error.message)
  const norm = normalizeRow(data)
  return { ...norm, transcript: parseTranscript(data.transcript) }
}

function computeStats(records) {
  const total = records.length
  const hot = records.filter(r => r.lead_category === 'HOT').length
  const warm = records.filter(r => r.lead_category === 'WARM').length
  const cold = records.filter(r => r.lead_category === 'COLD').length
  const avg = total
    ? (records.reduce((s, r) => s + (r.lead_score || 0), 0) / total).toFixed(1)
    : '0'
  return {
    total_calls: total, hot, warm, cold,
    avg_lead_score: avg,
    conversion_rate: total ? Math.round(hot / total * 100) : 0,
  }
}

// ── constants ─────────────────────────────────────────────────
const CATEGORY_COLOR = { HOT: '#ff6b4a', WARM: '#f5a623', COLD: '#5b9cf6', CLOSED: '#4ade80' }
const SCORE_COLOR = s => s >= 8 ? '#ff6b4a' : s >= 5 ? '#f5a623' : '#5b9cf6'
const PIE_COLORS = ['#ff6b4a', '#f5a623', '#5b9cf6']
const SOURCE_COLORS = ['#6c63ff', '#4ade80', '#f5a623', '#5b9cf6', '#ff6b4a']
const ALL_CATS = ['ALL', 'HOT', 'WARM', 'COLD', 'CLOSED']

// ── helpers ───────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}
/*function fmtDuration(sec) {
  if (!sec) return '—'
  return `${Math.floor(sec / 60)}m ${sec % 60}s`
}*/

function fmtDuration(sec) {
  if (sec == null) return '—';

  const minutes = Math.floor(sec / 60);
  const seconds = (sec % 60).toFixed(2);

  return `${minutes}m ${seconds}s`;
}
function fmtTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
}
function fmtDateTime(iso) {
  if (!iso) return '—'
  return `${fmtDate(iso)} ${fmtTime(iso)}`
}

// ── toast ─────────────────────────────────────────────────────
function useToast() {
  const [toast, setToast] = useState(null)
  const t = useRef(null)
  function show(msg, type = 'ok') {
    clearTimeout(t.current)
    setToast({ msg, type })
    t.current = setTimeout(() => setToast(null), 2500)
  }
  return { toast, show }
}
function Toast({ toast }) {
  if (!toast) return null
  const ok = toast.type === 'ok'
  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24, zIndex: 999,
      background: ok ? 'rgba(74,222,128,0.12)' : 'rgba(255,107,74,0.12)',
      border: `0.5px solid ${ok ? 'rgba(74,222,128,0.35)' : 'rgba(255,107,74,0.35)'}`,
      color: ok ? 'var(--green)' : 'var(--hot)',
      borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 500,
      boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
    }}>{toast.msg}</div>
  )
}

// ── export CSV ────────────────────────────────────────────────
function exportCSV(records, columns, filename) {
  const rows = records.map(r => columns.map(c => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','))
  const blob = new Blob([[columns.join(','), ...rows].join('\n')], { type: 'text/csv' })
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${filename}_${new Date().toISOString().slice(0, 10)}.csv` })
  a.click(); URL.revokeObjectURL(a.href)
}

// ── Empty State ───────────────────────────────────────────────
function VisualEmptyState({ message }) {
  return (
    <div style={{ padding: '3rem 1rem', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}>
        <circle cx="12" cy="12" r="10" />
        <path d="M16 16s-1.5-2-4-2-4 2-4 2" />
        <line x1="9" y1="9" x2="9.01" y2="9" />
        <line x1="15" y1="9" x2="15.01" y2="9" />
      </svg>
      <p style={{ color: 'var(--text2)', fontSize: 13, margin: 0 }}>{message}</p>
    </div>
  )
}

// ── Shared Sub-Components ─────────────────────────────────────
function StarScore({ score }) {
  const filled = Math.round((score / 10) * 5)
  return (
    <span style={{ color: SCORE_COLOR(score), letterSpacing: 1, fontSize: 13 }}>
      {'★'.repeat(filled)}{'☆'.repeat(5 - filled)}
      <span style={{ color: 'var(--text2)', marginLeft: 5, fontSize: 12 }}>{score}/10</span>
    </span>
  )
}

function Badge({ category }) {
  const map = {
    HOT: { bg: 'var(--hot-bg)', color: 'var(--hot)' },
    WARM: { bg: 'var(--warm-bg)', color: 'var(--warm)' },
    COLD: { bg: 'var(--cold-bg)', color: 'var(--cold)' },
    CLOSED: { bg: 'rgba(74,222,128,0.15)', color: '#4ade80' }
  }
  const c = map[category] || map.COLD
  return (
    <span style={{ background: c.bg, color: c.color, fontSize: 10, fontWeight: 600, padding: '3px 9px', borderRadius: 20, letterSpacing: 0.5 }}>
      {category || 'COLD'}
    </span>
  )
}

function MetricCard({ icon: Icon, label, value, sub, color }) {
  return (
    <div className={styles.metricCard}>
      <div className={styles.metricIcon} style={{ color: color || 'var(--accent)' }}><Icon size={18} /></div>
      <div>
        <p className={styles.metricLabel}>{label}</p>
        <p className={styles.metricValue} style={{ color: color || 'var(--text1)' }}>{value}</p>
        {sub && <p className={styles.metricSub}>{sub}</p>}
      </div>
    </div>
  )
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--bg3)', border: '0.5px solid var(--border2)', borderRadius: 8, padding: '8px 14px', fontSize: 12, color: 'var(--text1)' }}>
      <p style={{ color: 'var(--text2)', marginBottom: 4 }}>{label}</p>
      {payload.map((p, i) => <p key={i} style={{ color: p.color }}>{p.name}: <b>{p.value}</b></p>)}
    </div>
  )
}

function FilterBar({ value, onChange, cats = ['ALL', 'HOT', 'WARM', 'COLD', 'CLOSED'] }) {
  return (
    <div className={styles.filters}>
      {cats.map(f => (
        <button key={f} onClick={() => onChange(f)}
          className={`${styles.filterBtn} ${value === f ? styles.filterActive : ''}`}
          style={value === f && f !== 'ALL' ? { color: CATEGORY_COLOR[f] } : {}}>
          {f}
        </button>
      ))}
    </div>
  )
}

function buildWeeklyData(records) {
  const map = {}
  records.forEach(r => {
    const d = r.timestamp ? new Date(r.timestamp) : new Date()
    const key = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
    if (!map[key]) map[key] = { date: key, calls: 0, hot: 0, warm: 0, cold: 0 }
    map[key].calls++
    const cat = (r.lead_category || 'COLD').toUpperCase()
    if (cat === 'HOT') map[key].hot++
    if (cat === 'WARM') map[key].warm++
    if (cat === 'COLD') map[key].cold++
  })
  return Object.values(map).slice(-10)
}

function buildSourceData(records) {
  const map = {}
  records.forEach(r => {
    const s = r.source || 'Unknown'
    map[s] = (map[s] || 0) + 1
  })
  return Object.entries(map).map(([name, value]) => ({ name, value }))
}

// ══════════════════════════════════════════════════════════════
// PAGE: DASHBOARD
// ══════════════════════════════════════════════════════════════
function PageDashboard({ records, stats, loading, filter, setFilter, openTranscript, showToast, globalSearch }) {
  const total = stats?.total_calls ?? records.length
  const hot = stats?.hot ?? records.filter(r => r.lead_category === 'HOT').length
  const warm = stats?.warm ?? records.filter(r => r.lead_category === 'WARM').length
  const cold = stats?.cold ?? records.filter(r => r.lead_category === 'COLD').length
  const avgScore = stats?.avg_lead_score ?? (records.length ? (records.reduce((s, r) => s + (r.lead_score || 0), 0) / records.length).toFixed(1) : '0')
  const convRate = stats?.conversion_rate ?? (total ? Math.round(hot / total * 100) : 0)

  // NEW — pagination state
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const filteredRecords = useMemo(() => {
    return records
      .filter(r => filter === 'ALL' || r.lead_category === filter)
      .filter(r => !globalSearch ||
        (r.to_number || '').includes(globalSearch) ||
        (r.name || '').toLowerCase().includes(globalSearch.toLowerCase()) ||
        (r.summary || '').toLowerCase().includes(globalSearch.toLowerCase()))
  }, [records, filter, globalSearch])

  // NEW — reset to page 1 whenever filters/search/pageSize change
  useEffect(() => {
    setPage(1)
  }, [filter, globalSearch, pageSize])

  // NEW — sliced page of records for the table
  const totalPages = Math.max(1, Math.ceil(filteredRecords.length / pageSize))
  const pagedRecords = useMemo(() => {
    const start = (page - 1) * pageSize
    return filteredRecords.slice(start, start + pageSize)
  }, [filteredRecords, page, pageSize])

  // NEW — CSV export (exports currently filtered set, not just current page)
  const exportCsv = () => {
    if (!filteredRecords.length) {
      showToast?.('No records to export')
      return
    }
    const headers = ['Phone', 'Lead Status', 'Score', 'Duration', 'Summary', 'Date', 'Last Contacted', 'Call Status']
    const rows = filteredRecords.map(r => [
      r.to_number || '',
      r.lead_category || '',
      r.lead_score || '',
      fmtDuration(r.duration_sec),
      (r.summary || '').replace(/"/g, '""'),
      fmtDate(r.timestamp),
      r.last_contacted_at ? fmtDateTime(r.last_contacted_at) : fmtDateTime(r.timestamp),
      r.live_outcome || '',
    ])
    const csv = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell)}"`).join(','))
      .join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `leads_export_${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    showToast?.('CSV exported')
  }

  const weeklyData = buildWeeklyData(records)
  const pieData = [
    { name: 'Hot', value: hot, pct: total ? Math.round(hot / total * 100) : 0 },
    { name: 'Warm', value: warm, pct: total ? Math.round(warm / total * 100) : 0 },
    { name: 'Cold', value: cold, pct: total ? Math.round(cold / total * 100) : 0 },
  ]
  const sourceData = buildSourceData(records)


  return (
    <>
      <div className={styles.metricsRow}>
        <MetricCard icon={Users} label="Total leads" value={loading ? '…' : total} sub="all time" />
        <MetricCard icon={Flame} label="Hot leads" value={loading ? '…' : hot} sub={`${Math.round(hot / Math.max(total, 1) * 100)}% of total`} color="var(--hot)" />
        <MetricCard icon={Phone} label="Total calls" value={loading ? '…' : total} sub="processed" color="var(--accent)" />
        <MetricCard icon={TrendingUp} label="Conversion" value={loading ? '…' : `${convRate}%`} sub="hot / total" color="var(--green)" />
        <MetricCard icon={CheckCircle2} label="Avg score" value={loading ? '…' : avgScore} sub="out of 10" color="var(--warm)" />
      </div>

      <div className={styles.chartsRow}>
        <div className={styles.chartCard}>
          <h3 className={styles.chartTitle}>Calls over time</h3>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={weeklyData} margin={{ top: 5, right: 10, bottom: 0, left: -20 }}>
              <defs>
                <linearGradient id="gHot" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#ff6b4a" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#ff6b4a" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gWarm" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f5a623" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#f5a623" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="date" tick={{ fill: 'var(--text2)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: 'var(--text2)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="hot" name="Hot" stroke="#ff6b4a" fill="url(#gHot)" strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="warm" name="Warm" stroke="#f5a623" fill="url(#gWarm)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className={styles.chartCard}>
          <h3 className={styles.chartTitle}>Lead breakdown</h3>
          <ResponsiveContainer width="100%" height={160}>
            <PieChart>
              <Pie data={pieData} cx="50%" cy="50%" innerRadius={45} outerRadius={70} dataKey="value" paddingAngle={3}>
                {pieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i]} />)}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
            </PieChart>
          </ResponsiveContainer>
          <div className={styles.pieLegend}>
            {pieData.map((d, i) => (
              <span key={i} className={styles.legItem}>
                <span className={styles.legDot} style={{ background: PIE_COLORS[i] }} />
                {d.name} {d.pct}%
              </span>
            ))}
          </div>
        </div>

        <div className={styles.chartCard}>
          <h3 className={styles.chartTitle}>Top sources</h3>
          {sourceData.length === 0 ? (
            <VisualEmptyState message="No source data found" />
          ) : (
            <>
              <ResponsiveContainer width="100%" height={160}>
                <PieChart>
                  <Pie data={sourceData} cx="50%" cy="50%" innerRadius={45} outerRadius={70} dataKey="value" paddingAngle={3}>
                    {sourceData.map((_, i) => <Cell key={i} fill={SOURCE_COLORS[i % SOURCE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip content={<CustomTooltip />} />
                </PieChart>
              </ResponsiveContainer>
              <div className={styles.pieLegend}>
                {sourceData.map((d, i) => (
                  <span key={i} className={styles.legItem}>
                    <span className={styles.legDot} style={{ background: SOURCE_COLORS[i % SOURCE_COLORS.length] }} />
                    {d.name}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className={styles.tableCard}>
        <div className={styles.tableHeader}>
          <h3 className={styles.chartTitle} style={{ margin: 0 }}>Recent leads</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <FilterBar value={filter} onChange={setFilter} cats={['ALL', 'HOT', 'WARM', 'COLD', 'CLOSED']} />
            {/* NEW — page size dropdown */}
            <select
              value={pageSize}
              onChange={e => setPageSize(Number(e.target.value))}
              style={{
                background: 'var(--bg2, #1a1a24)',
                color: 'var(--text2)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 8,
                padding: '6px 10px',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              <option value={10}>10 per page</option>
              <option value={25}>25 per page</option>
              <option value={50}>50 per page</option>
              <option value={100}>100 per page</option>
            </select>
            {/* NEW — export CSV button */}
            <button
              onClick={exportCsv}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: 'var(--bg2, #1a1a24)',
                color: 'var(--text2)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 8,
                padding: '6px 12px',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              <Download size={14} />
              Export CSV
            </button>
          </div>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Phone</th>
                <th>Lead Status</th>
                <th>Score</th>
                <th>Duration</th>
                <th>Summary</th>
                <th>Date</th>
                <th>Last Contacted</th>
                <th>Call Status</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className={styles.emptyRow}>Loading…</td></tr>
              ) : pagedRecords.length === 0 ? (
                <tr><td colSpan={8}><VisualEmptyState message="No matching recent records found" /></td></tr>
              ) : pagedRecords.map(r => (
                <tr key={r.call_sid} className={styles.tableRow}>
                  <td className={styles.mono}>{r.to_number || '—'}</td>
                  <td><Badge category={r.lead_category} /></td>
                  <td><StarScore score={r.lead_score || 1} /></td>
                  <td style={{ color: 'var(--text2)' }}>{fmtDuration(r.duration_sec)}</td>
                  <td className={styles.summaryCell}>{r.summary || '—'}</td>
                  <td style={{ color: 'var(--text2)', whiteSpace: 'nowrap' }}>{fmtDate(r.timestamp)}</td>
                  <td style={{ color: 'var(--text2)', fontSize: 12 }}>{r.last_contacted_at ? fmtDateTime(r.last_contacted_at) : fmtDateTime(r.timestamp)}</td>

                  <td className={styles.mono} >{r.live_outcome || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* NEW — footer w/ pagination controls */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <p className={styles.tableFooter} style={{ margin: 0 }}>
            Showing {pagedRecords.length ? (page - 1) * pageSize + 1 : 0}–{Math.min(page * pageSize, filteredRecords.length)} of {filteredRecords.length} records
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              style={{
                background: 'transparent', color: 'var(--text2)',
                border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6,
                padding: '4px 10px', fontSize: 12,
                cursor: page <= 1 ? 'not-allowed' : 'pointer',
                opacity: page <= 1 ? 0.4 : 1,
              }}
            >
              Prev
            </button>
            <span style={{ color: 'var(--text2)', fontSize: 12 }}>Page {page} of {totalPages}</span>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              style={{
                background: 'transparent', color: 'var(--text2)',
                border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6,
                padding: '4px 10px', fontSize: 12,
                cursor: page >= totalPages ? 'not-allowed' : 'pointer',
                opacity: page >= totalPages ? 0.4 : 1,
              }}
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
// ══════════════════════════════════════════════════════════════
// PAGE: LEADS
// ══════════════════════════════════════════════════════════════
function PageLeads({ records, loading, openTranscript, showToast, fetchAll, agentConfig, globalSearch }) {
  const [catFilter, setCatFilter] = useState('ALL')
  const [sortKey, setSortKey] = useState('timestamp')
  const [sortDir, setSortDir] = useState('desc')
  const [pageSize, setPageSize] = useState(10)
  const [detail, setDetail] = useState(null)
  const [notes, setNotes] = useState([])
  const [noteInput, setNoteInput] = useState('')
  const [notesLoading, setNotesLoading] = useState(false)
  const [statusSaving, setStatusSaving] = useState(false)
  const [noteAuthor, setNoteAuthor] = useState('Sales Team')

  const calendlyLink = agentConfig?.calendly_link || 'https://calendly.com'

  const filtered = useMemo(() => {
    return records
      .filter(r => catFilter === 'ALL' || r.lead_category === catFilter)
      .filter(r => !globalSearch ||
        (r.to_number || '').includes(globalSearch) ||
        (r.name || '').toLowerCase().includes(globalSearch.toLowerCase()) ||
        (r.summary || '').toLowerCase().includes(globalSearch.toLowerCase()))
      .sort((a, b) => {
        let av = a[sortKey], bv = b[sortKey]
        if (sortKey === 'timestamp') { av = new Date(av || 0); bv = new Date(bv || 0) }
        if (sortKey === 'lead_score') { av = Number(av); bv = Number(bv) }
        return sortDir === 'asc' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1)
      })
  }, [records, catFilter, globalSearch, sortKey, sortDir])

  const paged = useMemo(() => filtered.slice(0, pageSize), [filtered, pageSize])

  function toggleSort(key) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  const SortBtn = ({ k, label }) => (
    <span onClick={() => toggleSort(k)} style={{ cursor: 'pointer', userSelect: 'none' }}>
      {label} {sortKey === k ? (sortDir === 'asc' ? '↑' : '↓') : ''}
    </span>
  )

  async function loadNotes(callSid) {
    if (!callSid) { setNotes([]); return }
    setNotesLoading(true)
    const { data, error } = await supabase.from('lead_notes')
      .select('*')
      .eq('call_sid', callSid)
      .order('created_at', { ascending: true })
    // FIX: was silently swallowing error; now surface it
    if (error) console.error('[loadNotes]', error.message)
    setNotes(data || [])
    setNotesLoading(false)
  }

  useEffect(() => {
    loadNotes(detail?.call_sid)
  }, [detail?.call_sid])

  async function updateStatus(callSid, newCategory) {
    setStatusSaving(true)
    const now = new Date().toISOString()
    // FIX: was doing 2 separate .update() calls → race condition + double RLS check
    // Merge into single update
    const { error } = await supabase.from('calls')
      .update({ lead_category: newCategory, last_contacted_at: now })
      .eq('call_sid', callSid)
    setStatusSaving(false)
    if (error) { showToast('Error updating status', 'err'); return }
    showToast(`Status → ${newCategory}`)
    setDetail(d => d ? { ...d, lead_category: newCategory, last_contacted_at: now } : d)
    fetchAll()
  }

  async function markFollowUp(callSid) {
    const now = new Date().toISOString()
    const { error } = await supabase.from('calls')
      .update({ last_contacted_at: now })
      .eq('call_sid', callSid)
    if (error) { showToast('Error updating contact time', 'err'); return }
    showToast('Last contacted updated ✓')
    setDetail(d => d ? { ...d, last_contacted_at: now } : d)
    fetchAll()
  }

  async function addNote() {
    if (!noteInput.trim() || !detail?.call_sid) return
    const { error } = await supabase.from('lead_notes').insert({
      call_sid: detail.call_sid,
      note: noteInput.trim(),
      author: noteAuthor.trim() || 'Sales Team',
    })
    if (error) { showToast('Error saving note', 'err'); return }
    setNoteInput('')
    showToast('Note saved')
    loadNotes(detail.call_sid)
  }

  async function deleteNote(noteId) {
    const { error } = await supabase.from('lead_notes').delete().eq('id', noteId)
    if (error) { showToast('Error deleting note', 'err'); return }
    showToast('Note deleted')
    // FIX: was calling loadNotes(detail.call_sid) but detail could be stale closure
    // use functional update pattern
    setNotes(prev => prev.filter(n => n.id !== noteId))
  }

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 10, marginBottom: 14, justifyContent: 'flex-end', alignItems: 'center' }}>
          <FilterBar value={catFilter} onChange={setCatFilter} cats={['ALL', 'HOT', 'WARM', 'COLD', 'CLOSED']} />
          <select
            value={pageSize}
            onChange={e => setPageSize(Number(e.target.value))}
            style={{ background: 'var(--bg3)', border: '0.5px solid var(--border2)', borderRadius: 8, padding: '6px 10px', color: 'var(--text1)', fontSize: 12, cursor: 'pointer', outline: 'none' }}>
            {[10, 20, 30, 40].map(n => <option key={n} value={n}>{n} per page</option>)}
          </select>
          <button onClick={() => { exportCSV(filtered, ['name', 'to_number', 'lead_category', 'lead_score', 'duration_sec', 'budget', 'decision_makers', 'timestamp', 'last_contacted_at'], 'leads'); showToast(`Exported ${filtered.length} rows`) }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', background: 'var(--bg3)', border: '0.5px solid var(--border2)', borderRadius: 8, color: 'var(--text1)', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <Download size={13} /> Export CSV
          </button>
        </div>

        <div className={styles.tableCard}>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th><SortBtn k="name" label="Name" /></th>
                  <th><SortBtn k="to_number" label="Phone" /></th>
                  <th><SortBtn k="lead_category" label="Status" /></th>
                  <th><SortBtn k="lead_score" label="Score" /></th>
                  <th>Budget</th>
                  <th>Call Status</th>
                  <th>Last Contacted</th>
                  <th><SortBtn k="timestamp" label="Date" /></th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={9} className={styles.emptyRow}>Loading…</td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={9}><VisualEmptyState message="No matching leads discovered" /></td></tr>
                ) : paged.map(r => (
                  <tr key={r.call_sid} className={styles.tableRow}
                    style={{ cursor: 'pointer', background: detail?.call_sid === r.call_sid ? 'var(--bg3)' : '' }}
                    onClick={() => setDetail(detail?.call_sid === r.call_sid ? null : r)}>
                    <td style={{ fontWeight: 500 }}>{r.name || '—'}</td>
                    <td className={styles.mono}>{r.to_number || '—'}</td>
                    <td><Badge category={r.lead_category} /></td>
                    <td><StarScore score={r.lead_score || 1} /></td>
                    <td style={{ fontWeight: 500, color: 'var(--green)' }}>{r.budget || '—'}</td>
                    
                  <td className={styles.mono} >{r.live_outcome || '—'}</td>
                    <td style={{ color: 'var(--text2)', fontSize: 12 }}>{r.last_contacted_at ? fmtDateTime(r.last_contacted_at) : fmtDateTime(r.timestamp)}</td>
                    <td style={{ color: 'var(--text2)', whiteSpace: 'nowrap' }}>{fmtDate(r.timestamp)}</td>
                    <td onClick={e => e.stopPropagation()}>
                      <div className={styles.actions}>
                        {/* <button className={styles.iconBtn} title={`Call ${r.to_number}`} onClick={e => { e.stopPropagation(); window.open(`tel:${r.to_number}`) }}><PhoneCall size={14} /></button> */}
                        <button className={styles.iconBtn} title="Copy number" onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(r.to_number || ''); showToast(`Copied ${r.to_number}`) }}><Copy size={14} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.tableFooter}>{paged.length} of {filtered.length} leads ({records.length} total)</p>
        </div>
      </div>

      {detail && (
        <div style={{ width: 300, flexShrink: 0, background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: 14, padding: '1rem', fontSize: 13, maxHeight: 'calc(100vh - 120px)', overflowY: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontWeight: 600 }}>Lead detail</span>
            <button className={styles.iconBtn} onClick={() => setDetail(null)}><X size={14} /></button>
          </div>

          <p style={{ fontWeight: 600, fontSize: 15, marginBottom: 2 }}>{detail.name || 'Unknown'}</p>
          <p className={styles.mono} style={{ color: 'var(--text2)', marginBottom: 10 }}>{detail.to_number || '—'}</p>

          <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: '8px 10px', marginBottom: 12, fontSize: 12 }}>
            <p style={{ color: 'var(--text3)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>Last Contacted</p>
            <p style={{ color: 'var(--text1)' }}>
              {detail.last_contacted_at ? fmtDateTime(detail.last_contacted_at) : fmtDateTime(detail.timestamp)}
            </p>
          </div>

          <p style={{ color: 'var(--text2)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Status</p>
          <div style={{ position: 'relative', marginBottom: 12 }}>
            <select
              value={detail.lead_category || 'COLD'}
              disabled={statusSaving}
              onChange={async e => await updateStatus(detail.call_sid, e.target.value)}
              style={{
                width: '100%', padding: '6px 28px 6px 10px',
                background: 'var(--bg3)', border: '0.5px solid var(--border2)',
                borderRadius: 8, color: CATEGORY_COLOR[detail.lead_category] || 'var(--text1)',
                fontSize: 13, fontWeight: 600, cursor: 'pointer', appearance: 'none', outline: 'none',
              }}>
              <option value="HOT" style={{ color: '#ff6b4a' }}>🔥 HOT</option>
              <option value="WARM" style={{ color: '#f5a623' }}>🌤 WARM</option>
              <option value="COLD" style={{ color: '#5b9cf6' }}>❄️ COLD</option>
              <option value="CLOSED" style={{ color: '#4ade80' }}>🎉 CLOSED</option>
            </select>
            <ChevronDown size={12} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text2)', pointerEvents: 'none' }} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
            <div>
              <p style={{ color: 'var(--text2)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Score</p>
              <StarScore score={detail.lead_score || 1} />
            </div>
            <div>
              <p style={{ color: 'var(--text2)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Duration</p>
              <p>{fmtDuration(detail.duration_sec)}</p>
            </div>
          </div>

          {detail.budget && (
            <div style={{ marginBottom: 12 }}>
              <p style={{ color: 'var(--text2)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Budget</p>
              <p style={{ color: 'var(--green)', fontWeight: 600 }}>{detail.budget}</p>
            </div>
          )}

          {detail.summary && (
            <div style={{ marginBottom: 12 }}>
              <p style={{ color: 'var(--text2)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Summary</p>
              <p style={{ lineHeight: 1.6, color: 'var(--text1)', fontSize: 12 }}>{detail.summary}</p>
            </div>
          )}

          {detail.pain_points?.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <p style={{ color: 'var(--text2)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Pain points</p>
              <ul style={{ paddingLeft: 16, color: 'var(--text1)', lineHeight: 1.8, margin: 0, fontSize: 12 }}>
                {detail.pain_points.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            </div>
          )}

          {detail.decision_makers && (
            <div style={{ marginBottom: 12 }}>
              <p style={{ color: 'var(--text2)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Decision Maker</p>
              <p style={{ fontSize: 12 }}>{detail.decision_makers}</p>
            </div>
          )}

          <p style={{ color: 'var(--text2)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Sales actions</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
            <button
              onClick={async () => { window.open(`tel:${detail.to_number}`); await markFollowUp(detail.call_sid) }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--bg3)', border: '0.5px solid var(--border)', borderRadius: 8, color: 'var(--green)', fontSize: 12, cursor: 'pointer', textAlign: 'left' }}>
              <PhoneCall size={13} /> Follow-up Call
            </button>
            <button
              onClick={async () => { await updateStatus(detail.call_sid, 'CLOSED'); showToast('Deal closed! 🎉') }}
              disabled={detail.lead_category === 'CLOSED' || statusSaving}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: detail.lead_category === 'CLOSED' ? 'rgba(74,222,128,0.08)' : 'var(--bg3)', border: `0.5px solid ${detail.lead_category === 'CLOSED' ? 'rgba(74,222,128,0.4)' : 'var(--border)'}`, borderRadius: 8, color: detail.lead_category === 'CLOSED' ? '#4ade80' : 'var(--hot)', fontSize: 12, cursor: detail.lead_category === 'CLOSED' ? 'default' : 'pointer', textAlign: 'left', opacity: detail.lead_category === 'CLOSED' ? 0.7 : 1 }}>
              <Handshake size={13} /> {detail.lead_category === 'CLOSED' ? 'Deal Closed ✓' : 'Close Deal'}
            </button>
            <button
              onClick={() => {
                // FIX: was using undefined `calendlyLink` in outer scope — now correctly uses local var
                window.open(calendlyLink || 'https://calendly.com', '_blank')
              }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--bg3)', border: '0.5px solid var(--border)', borderRadius: 8, color: 'var(--accent)', fontSize: 12, cursor: 'pointer', textAlign: 'left' }}>
              <Calendar size={13} /> Schedule Meeting
            </button>
          </div>

          <p style={{ color: 'var(--text2)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Notes & activity</p>

          <input
            value={noteAuthor}
            onChange={e => setNoteAuthor(e.target.value)}
            placeholder="Your name…"
            style={{ width: '100%', background: 'var(--bg3)', border: '0.5px solid var(--border)', borderRadius: 8, padding: '5px 10px', color: 'var(--text2)', fontSize: 11, outline: 'none', marginBottom: 6, boxSizing: 'border-box' }}
          />

          {notesLoading ? (
            <p style={{ color: 'var(--text3)', fontSize: 12, marginBottom: 8 }}>Loading…</p>
          ) : notes.length === 0 ? (
            <p style={{ color: 'var(--text3)', fontSize: 12, marginBottom: 8 }}>No notes yet. Add one below.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
              {notes.map(n => (
                <div key={n.id} style={{ background: 'var(--bg3)', borderRadius: 8, padding: '8px 10px', fontSize: 12, position: 'relative' }}>
                  <p style={{ color: 'var(--text1)', marginBottom: 2, paddingRight: 20 }}>{n.note}</p>
                  <p style={{ color: 'var(--text3)', fontSize: 10 }}>{n.author || 'Sales Team'} · {fmtDateTime(n.created_at)}</p>
                  <button
                    onClick={() => deleteNote(n.id)}
                    style={{ position: 'absolute', top: 6, right: 6, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 2, display: 'flex', alignItems: 'center' }}
                    title="Delete note">
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={noteInput}
              onChange={e => setNoteInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addNote()}
              placeholder="Add a note…"
              style={{ flex: 1, background: 'var(--bg3)', border: '0.5px solid var(--border)', borderRadius: 8, padding: '7px 10px', color: 'var(--text1)', fontSize: 12, outline: 'none' }}
            />
            <button onClick={addNote} className={styles.iconBtn} title="Add note" disabled={!noteInput.trim()}>
              <Send size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// PAGE: CONVERSATIONS
// ══════════════════════════════════════════════════════════════
function PageConversations({ records, loading, openTranscript, globalSearch }) {
  const [selected, setSelected] = useState(null)
  const [txData, setTxData] = useState(null)
  const [txLoading, setTxLoading] = useState(false)

  // NEW — pagination state
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const filtered = useMemo(() => {
    return records.filter(r =>
      !globalSearch ||
      (r.to_number || '').includes(globalSearch) ||
      (r.name || '').toLowerCase().includes(globalSearch.toLowerCase()) ||
      (r.summary || '').toLowerCase().includes(globalSearch.toLowerCase())
    )
  }, [records, globalSearch])

  // NEW — reset to page 1 when search/pageSize changes
  useEffect(() => {
    setPage(1)
  }, [globalSearch, pageSize])

  // NEW — sliced page of list
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const paged = useMemo(() => {
    const start = (page - 1) * pageSize
    return filtered.slice(start, start + pageSize)
  }, [filtered, page, pageSize])

  async function loadTranscript(r) {
    setSelected(r)
    setTxData(null)
    setTxLoading(true)
    try {
      const data = await fetchTranscriptFromSupabase(r.call_sid)
      console.log('RAW TRANSCRIPT:', JSON.stringify(data?.transcript)) // debug — check for \n chars
      setTxData(data)
    } catch (e) {
      setTxData({ error: e.message, transcript: '' })
    } finally {
      setTxLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 140px)' }}>
      <div style={{ width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden' }}>
        {/* NEW — page size dropdown above the list */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 2 }}>
          <select
            value={pageSize}
            onChange={e => setPageSize(Number(e.target.value))}
            style={{
              background: 'var(--bg2)',
              color: 'var(--text2)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '4px 8px',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            <option value={10}>10 per page</option>
            <option value={25}>25 per page</option>
            <option value={50}>50 per page</option>
            <option value={100}>100 per page</option>
          </select>
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto' }}>
          {loading && <p style={{ color: 'var(--text2)', textAlign: 'center', padding: '2rem', fontSize: 13 }}>Loading…</p>}
          {paged.map(r => (
            <div key={r.call_sid}
              onClick={() => loadTranscript(r)}
              style={{
                background: selected?.call_sid === r.call_sid ? 'var(--bg3)' : 'var(--bg2)',
                border: `0.5px solid ${selected?.call_sid === r.call_sid ? 'var(--border2)' : 'var(--border)'}`,
                borderRadius: 10, padding: '10px 12px', cursor: 'pointer',
              }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontWeight: 500 }}>{r.name || r.to_number || '—'}</span>
                <Badge category={r.lead_category} />
              </div>
              <p style={{ fontSize: 12, color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.summary || 'No summary'}
              </p>
              <p style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>{fmtDate(r.timestamp)} · {fmtDuration(r.duration_sec)}</p>
            </div>
          ))}
          {!loading && filtered.length === 0 && (
            <VisualEmptyState message="No matching conversation records" />
          )}
        </div>

        {/* NEW — pager footer under the list */}
        {!loading && filtered.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 4 }}>
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              style={{
                background: 'transparent', color: 'var(--text2)',
                border: '1px solid var(--border)', borderRadius: 6,
                padding: '4px 10px', fontSize: 11,
                cursor: page <= 1 ? 'not-allowed' : 'pointer',
                opacity: page <= 1 ? 0.4 : 1,
              }}
            >
              Prev
            </button>
            <span style={{ color: 'var(--text2)', fontSize: 11 }}>Page {page} of {totalPages}</span>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              style={{
                background: 'transparent', color: 'var(--text2)',
                border: '1px solid var(--border)', borderRadius: 6,
                padding: '4px 10px', fontSize: 11,
                cursor: page >= totalPages ? 'not-allowed' : 'pointer',
                opacity: page >= totalPages ? 0.4 : 1,
              }}
            >
              Next
            </button>
          </div>
        )}
      </div>

      <div style={{ flex: 1, background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: 14, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!selected ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <VisualEmptyState message="Select a conversation to load transcript" />
          </div>
        ) : (
          <>
            <div style={{ padding: '1rem 1.25rem', borderBottom: '0.5px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ fontWeight: 600 }}>{selected.name || selected.to_number || '—'}</span>
                <span style={{ marginLeft: 10 }}><Badge category={selected.lead_category} /></span>
              </div>
              <span style={{ fontSize: 12, color: 'var(--text2)' }}>{fmtDate(selected.timestamp)} · {fmtDuration(selected.duration_sec)}</span>
            </div>
            {selected.summary && (
              <div style={{ margin: '12px 1.25rem 0', padding: '10px 14px', background: 'var(--accent-dim)', borderLeft: '2px solid var(--accent)', borderRadius: '0 8px 8px 0', fontSize: 13 }}>
                <p style={{ fontSize: 10, textTransform: 'uppercase', color: 'var(--accent)', marginBottom: 4 }}>AI Summary</p>
                <p>{selected.summary}</p>
              </div>
            )}
            <div style={{ flex: 1, overflowY: 'auto', padding: '1rem 1.25rem' }}>
              {txLoading && <p style={{ color: 'var(--text2)', textAlign: 'center', padding: '2rem', fontSize: 13 }}>Loading transcript…</p>}
              {txData?.error && <p style={{ color: 'var(--hot)', padding: '1rem', fontSize: 13 }}>Error: {txData.error}</p>}
              {!txLoading && (!txData?.transcript || txData.transcript.length === 0) && !txData?.error && (
                <VisualEmptyState message="No transcript data available for this call" />
              )}
              {txData?.transcript && Array.isArray(txData.transcript) && txData.transcript.length > 0 && (
                <pre style={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: 'inherit',
                  fontSize: 13,
                  lineHeight: 1.6,
                  color: 'var(--text)',
                  background: 'var(--bg3)',
                  padding: '12px 14px',
                  borderRadius: 10,
                  margin: 0,
                }}>
                  {txData.transcript.map(l => `${l.role}: ${l.text}`).join('\n')}
                </pre>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
// ══════════════════════════════════════════════════════════════
// PAGE: FORMS  —  Backend Email Send (Resend ) + Setup
// ══════════════════════════════════════════════════════════════
const API_BASE = (typeof window !== 'undefined' && window.__API_BASE__)
  || import.meta.env.VITE_API_BASE
  || 'http://localhost:8000'

// ── helpers ──────────────────────────────────────────────────
const inputStyle = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  border: '0.5px solid var(--border2)', background: 'var(--bg3)',
  color: 'var(--text1)', fontSize: 13, boxSizing: 'border-box',
  outline: 'none'
}
const labelStyle = { fontSize: 11, color: 'var(--text2)', marginBottom: 4, display: 'block' }

// ── Send email via backend (Resend) — no OAuth, no client ID ──
async function sendFormEmail(to, name, formUrl) {
  const res = await fetch(`${API_BASE}/api/send-form-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lead_email: to, lead_name: name, form_url: formUrl })
  })
  if (!res.ok) {
    let detail = 'Send failed'
    try { detail = (await res.json()).detail || detail } catch { }
    throw new Error(detail)
  }
  return await res.json()
}

// ── FormSetupModal ────────────────────────────────────────────
function FormSetupModal({ onClose, onSave, showToast }) {
  const [formUrl, setFormUrl] = useState(localStorage.getItem('google_form_url') || '')
  const [label, setLabel] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    if (!formUrl.includes('docs.google.com/forms')) {
      showToast('Paste a valid Google Form URL'); return
    }

    setSaving(true)
    const { error } = await supabase.from('forms').upsert({
      form_url: formUrl,
      label: label.trim() || `Form ${new Date().toLocaleDateString()}`,
      created_by: 'dashboard',
      last_used_at: new Date().toISOString()
    }, { onConflict: 'form_url' })

    setSaving(false)

    if (error) { showToast('Save failed: ' + error.message); return }

    localStorage.setItem('google_form_url', formUrl)
    onSave(formUrl)
    showToast('Form saved!')
    onClose()
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--bg2)', border: '0.5px solid var(--border2)', borderRadius: 12, padding: 28, width: 440, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h3 style={{ margin: 0, fontSize: 15, color: 'var(--text1)' }}>Google Form Setup</h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={labelStyle}>Form Name (optional)</label>
          <input value={label} onChange={e => setLabel(e.target.value)}
            placeholder="e.g. Onboarding Form, Discovery Call" style={inputStyle} />
        </div>

        <button onClick={() => window.open('https://docs.google.com/forms/create', '_blank')}
          style={{
            padding: '9px 14px', borderRadius: 8, border: '0.5px solid var(--border2)',
            background: 'var(--bg3)', color: 'var(--text1)', fontSize: 13, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8
          }}>
          ➕ Create New Google Form
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>(opens in new tab)</span>
        </button>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={labelStyle}>Paste Form Share URL *</label>
          <input value={formUrl} onChange={e => setFormUrl(e.target.value)}
            placeholder="https://docs.google.com/forms/d/e/..." style={inputStyle} />
          <span style={{ fontSize: 10, color: 'var(--text3)' }}>Google Forms → Share → Copy link → paste here</span>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose}
            style={{
              padding: '7px 16px', borderRadius: 8, border: '0.5px solid var(--border2)',
              background: 'var(--bg3)', color: 'var(--text2)', fontSize: 13, cursor: 'pointer'
            }}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={!formUrl || saving}
            style={{
              padding: '7px 16px', borderRadius: 8, border: 'none',
              background: 'var(--accent)', color: '#fff', fontSize: 13, cursor: (!formUrl || saving) ? 'not-allowed' : 'pointer',
              opacity: (!formUrl || saving) ? 0.5 : 1
            }}>
            {saving ? 'Saving…' : 'Save & Use'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── FormLibraryModal ──────────────────────────────────────────
function FormLibraryModal({ onClose, onUse, showToast }) {
  const [forms, setForms] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('forms')
      .select('*')
      .order('last_used_at', { ascending: false, nullsLast: true })
      .then(({ data, error }) => {
        if (error) showToast('Load failed: ' + error.message)
        setForms(data || [])
        setLoading(false)
      })
  }, [])

  async function deleteForm(id) {
    const { error } = await supabase.from('forms').delete().eq('id', id)
    if (error) { showToast('Delete failed'); return }
    setForms(f => f.filter(x => x.id !== id))
    showToast('Form removed')
  }

  async function useForm(form) {
    await supabase.from('forms')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', form.id)
    localStorage.setItem('google_form_url', form.form_url)
    onUse(form.form_url)
    showToast('Now using: ' + form.label)
    onClose()
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--bg2)', border: '0.5px solid var(--border2)', borderRadius: 12, padding: 28, width: 520, display: 'flex', flexDirection: 'column', gap: 16, maxHeight: '80vh' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: 15, color: 'var(--text1)' }}>Forms Library</h3>
          <button onClick={onClose}
            style={{
              padding: '4px 12px', borderRadius: 7, border: '0.5px solid var(--border2)',
              background: 'var(--bg3)', color: 'var(--text2)', fontSize: 12, cursor: 'pointer'
            }}>
            Close
          </button>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text3)', fontSize: 13 }}>
            Loading…
          </div>
        ) : forms.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text3)', fontSize: 13 }}>
            No saved forms. Use ⚙️ Setup Form to add one.
          </div>
        ) : (
          <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {forms.map(f => (
              <div key={f.id}
                style={{
                  background: 'var(--bg3)', border: '0.5px solid var(--border2)',
                  borderRadius: 10, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8
                }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text1)' }}>{f.label}</div>
                    {f.created_by && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>Added by {f.created_by}</div>}
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{fmtDate(f.created_at)}</div>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text3)', wordBreak: 'break-all' }}>{f.form_url}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button onClick={() => window.open(f.form_url, '_blank')}
                    style={{
                      padding: '5px 12px', borderRadius: 7, border: '0.5px solid var(--border2)',
                      background: 'var(--bg2)', color: 'var(--text1)', fontSize: 12, cursor: 'pointer'
                    }}>
                    🔗 Open
                  </button>
                  <button onClick={() => useForm(f)}
                    style={{
                      padding: '5px 12px', borderRadius: 7, border: 'none',
                      background: 'var(--accent)', color: '#fff', fontSize: 12, cursor: 'pointer'
                    }}>
                    ✓ Use Form
                  </button>
                  <button onClick={() => { navigator.clipboard.writeText(f.form_url); showToast('URL copied') }}
                    style={{
                      padding: '5px 12px', borderRadius: 7, border: '0.5px solid var(--border2)',
                      background: 'var(--bg2)', color: 'var(--text2)', fontSize: 12, cursor: 'pointer'
                    }}>
                    <Copy size={12} />
                  </button>
                  <button onClick={() => deleteForm(f.id)}
                    style={{
                      padding: '5px 12px', borderRadius: 7, border: '0.5px solid rgba(239,68,68,0.3)',
                      background: 'rgba(239,68,68,0.08)', color: '#ef4444', fontSize: 12, cursor: 'pointer'
                    }}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── SendFormModal ────────────────────────────────────────────
function SendFormModal({ onClose, onSent, showToast, formUrl }) {
  const [name, setName] = useState('')
  const [leadEmail, setLeadEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)

  function isValidEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) }

  async function handleSend() {
    if (!leadEmail.trim()) { showToast('Email is required'); return }
    if (!isValidEmail(leadEmail)) { showToast('Enter a valid email'); return }
    if (!formUrl) { showToast('No form URL — click ⚙️ Setup Form'); return }

    setBusy(true)
    try {
      await sendFormEmail(leadEmail, name, formUrl)
      setSent(true)
      showToast(`Email sent to ${leadEmail}`)
      setTimeout(() => { onSent(); onClose() }, 1000)
    } catch (err) {
      showToast(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--bg2)', border: '0.5px solid var(--border2)', borderRadius: 12, padding: 28, width: 520, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <h3 style={{ margin: 0, fontSize: 15, color: 'var(--text1)' }}>Send Form via Email</h3>

        {!formUrl && (
          <div style={{
            padding: '10px 14px', borderRadius: 8, background: 'rgba(239,68,68,0.1)',
            border: '0.5px solid rgba(239,68,68,0.3)', color: '#ef4444', fontSize: 12
          }}>
            ⚠️ No form URL. Close and click ⚙️ Setup Form.
          </div>
        )}

        {[
          { label: 'Lead Email *', val: leadEmail, set: setLeadEmail, ph: 'lead@example.com', type: 'email' },
          { label: 'Lead Name', val: name, set: setName, ph: 'Full name', type: 'text' },
        ].map(({ label, val, set, ph, type }) => (
          <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={labelStyle}>{label}</label>
            <input type={type} value={val} onChange={e => set(e.target.value)}
              placeholder={ph} style={inputStyle} />
          </div>
        ))}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 4 }}>
          <button onClick={onClose}
            style={{
              padding: '8px 18px', borderRadius: 8, border: '0.5px solid var(--border2)',
              background: 'var(--bg3)', color: 'var(--text2)', fontSize: 13, cursor: 'pointer'
            }}>
            Cancel
          </button>
          <button onClick={handleSend}
            disabled={busy || !leadEmail || !formUrl}
            style={{
              padding: '8px 20px', borderRadius: 8, border: 'none', fontSize: 13,
              background: sent ? '#22c55e' : 'var(--accent)', color: '#fff', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 6, minWidth: 130, justifyContent: 'center',
              opacity: (busy || !leadEmail || !formUrl) ? 0.5 : 1
            }}>
            {sent ? '✓ Sent!' : busy ? 'Sending…' : '📧 Send Email'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── SendLogTab ────────────────────────────────────────────────
function SendLogTab({ showToast, formUrl, submissions }) {
  const [log, setLog] = useState([])
  const [loading, setLoading] = useState(true)

  function loadLog() {
    setLoading(true)
    supabase.from('form_send_log')
      .select('*')
      .order('sent_at', { ascending: false })
      .limit(200)
      .then(({ data }) => { setLog(data || []); setLoading(false) })
  }

  useEffect(() => { loadLog() }, [])

  async function handleResend(l) {
    const url = l.form_url || formUrl
    if (!url) { showToast('No form URL available'); return }
    try {
      await sendFormEmail(l.lead_email, l.lead_name, url)
      showToast(`Reminder sent to ${l.lead_email}`)
      loadLog()
    } catch (err) {
      showToast('Resend failed: ' + err.message)
    }
  }

  function findResponse(l) {
    const email = (l.lead_email || '').trim().toLowerCase()
    if (!email) return null
    return submissions.find(s => {
      const subEmail = (s.email || '').trim().toLowerCase()
      return subEmail && subEmail === email && new Date(s.submitted_at) >= new Date(l.sent_at)
    }) || null
  }

  function StatusCell({ l }) {
    const responded = findResponse(l)
    if (responded) {
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#22c55e', fontSize: 12 }}
          title={`Responded ${fmtDate(responded.submitted_at)}`}>
          <CheckCircle size={13} /> Responded
        </span>
      )
    }
    if (l.status === 'failed') {
      return <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#ef4444', fontSize: 12 }} title={l.error || ''}><AlertCircle size={13} /> Failed</span>
    }
    return <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text3)', fontSize: 12 }}><Clock size={13} /> Pending</span>
  }

  return (
    <div className={styles.tableCard}>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Lead Name</th><th>Email</th>
              <th>Sent At</th><th>Status</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className={styles.emptyRow}>Loading…</td></tr>
            ) : log.length === 0 ? (
              <tr><td colSpan={5}><VisualEmptyState message="No forms sent yet" /></td></tr>
            ) : log.map(l => (
              <tr key={l.id} className={styles.tableRow}>
                <td style={{ fontWeight: 500 }}>{l.lead_name || '—'}</td>
                <td style={{ fontSize: 12, color: 'var(--text2)' }}>{l.lead_email}</td>
                <td style={{ color: 'var(--text2)', whiteSpace: 'nowrap' }}>{fmtDate(l.sent_at)}</td>
                <td><StatusCell l={l} /></td>
                <td>
                  <div className={styles.actions}>
                    <button className={styles.iconBtn} title="Resend Email" onClick={() => handleResend(l)}>
                      <Send size={14} />
                    </button>
                    <button className={styles.iconBtn} title="Copy Email"
                      onClick={() => { navigator.clipboard.writeText(l.lead_email); showToast('Email copied') }}>
                      <Copy size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── PageForms ─────────────────────────────────────────────────
function PageForms({ showToast, globalSearch, setFormCount }) {
  const [submissions, setSubmissions] = useState([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState(null)
  const [tab, setTab] = useState('responses')
  const [showModal, setShowModal] = useState(false)
  const [showSetup, setShowSetup] = useState(false)
  const [showLibrary, setShowLibrary] = useState(false)
  const [formUrl, setFormUrl] = useState(localStorage.getItem('google_form_url') || '')

  function loadSubmissions() {
    setLoading(true); setFetchError(null)
    supabase.from('form_submissions')
      .select('*, calls(lead_category, lead_score)')
      .order('submitted_at', { ascending: false })
      .limit(200)
      .then(({ data, error }) => {
        if (error) { console.error('[PageForms]', error.message); setFetchError(error.message) }
        const items = data || []
        setSubmissions(items)
        setLoading(false)
      })
  }

  useEffect(() => { loadSubmissions() }, [setFormCount])

  const filtered = useMemo(() => submissions.filter(s =>
    !globalSearch ||
    (s.name || '').toLowerCase().includes(globalSearch.toLowerCase()) ||
    (s.email || '').toLowerCase().includes(globalSearch.toLowerCase()) ||
    (s.service_requirements || '').toLowerCase().includes(globalSearch.toLowerCase())
  ), [submissions, globalSearch])

  function handleUseForm(url) {
    localStorage.setItem('google_form_url', url)
    setFormUrl(url)
  }

  return (
    <>
      {showSetup && <FormSetupModal onClose={() => setShowSetup(false)} onSave={handleUseForm} showToast={showToast} />}
      {showLibrary && <FormLibraryModal onClose={() => setShowLibrary(false)} onUse={handleUseForm} showToast={showToast} />}
      {showModal && <SendFormModal onClose={() => setShowModal(false)} onSent={() => { }} showToast={showToast} formUrl={formUrl} />}

      {fetchError && (
        <div className={styles.errorBanner} style={{ marginBottom: 12 }}>
          <AlertCircle size={14} />
          <span><b>Forms fetch error:</b> {fetchError}</span>
        </div>
      )}

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {[{ key: 'responses', label: 'Responses' }, { key: 'sent', label: 'Sent Log' }].map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{
                padding: '6px 14px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
                border: '0.5px solid var(--border2)',
                background: tab === t.key ? 'var(--accent)' : 'var(--bg3)',
                color: tab === t.key ? '#fff' : 'var(--text2)'
              }}>
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {tab === 'responses' && (
            <span style={{ fontSize: 12, color: 'var(--text2)' }}>{filtered.length} submissions</span>
          )}

          <span style={{
            fontSize: 11, padding: '3px 8px', borderRadius: 6,
            background: formUrl ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
            color: formUrl ? '#22c55e' : '#ef4444',
            border: `0.5px solid ${formUrl ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`
          }}>
            {formUrl ? '✓ Form set' : '⚠ No form'}
          </span>

          <button onClick={() => setShowSetup(true)}
            style={{
              padding: '6px 14px', borderRadius: 8, border: '0.5px solid var(--border2)',
              background: 'var(--bg3)', color: 'var(--text1)', fontSize: 12, cursor: 'pointer'
            }}>
            ⚙️ Setup Form
          </button>

          <button onClick={() => setShowLibrary(true)}
            style={{
              padding: '6px 14px', borderRadius: 8, border: '0.5px solid var(--border2)',
              background: 'var(--bg3)', color: 'var(--text1)', fontSize: 12, cursor: 'pointer'
            }}>
            📚 Forms Library
          </button>

          <button onClick={() => setShowModal(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px',
              background: 'var(--accent)', border: 'none', borderRadius: 8,
              color: '#fff', fontSize: 12, cursor: 'pointer'
            }}>
            <Send size={13} /> Send Email
          </button>

          {tab === 'responses' && (
            <button onClick={() => {
              exportCSV(filtered, ['name', 'email', 'service_requirements', 'budget', 'timeline', 'submitted_at'], 'form_submissions')
              showToast(`Exported ${filtered.length} rows`)
            }} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px',
              background: 'var(--bg3)', border: '0.5px solid var(--border2)', borderRadius: 8,
              color: 'var(--text1)', fontSize: 12, cursor: 'pointer'
            }}>
              <Download size={13} /> Export CSV
            </button>
          )}
        </div>
      </div>

      {/* Tab content */}
      {tab === 'responses' ? (
        <div className={styles.tableCard}>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Name</th><th>Email</th><th>Service Requirements</th>
                  <th>Budget</th><th>Timeline</th><th>Lead Status</th>
                  <th>Submitted</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={8} className={styles.emptyRow}>Loading…</td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={8}><VisualEmptyState message="No form submissions found" /></td></tr>
                ) : filtered.map(s => (
                  <tr key={s.id} className={styles.tableRow}>
                    <td style={{ fontWeight: 500 }}>{s.name || '—'}</td>
                    <td style={{ color: 'var(--text2)', fontSize: 12 }}>{s.email || '—'}</td>
                    <td className={styles.summaryCell}>{s.service_requirements || '—'}</td>
                    <td style={{ color: 'var(--text2)' }}>{s.budget || '—'}</td>
                    <td style={{ color: 'var(--text2)' }}>{s.timeline || '—'}</td>
                    <td>{s.calls
                      ? <Badge category={s.calls.lead_category} />
                      : <span style={{ color: 'var(--text3)', fontSize: 12 }}>—</span>}
                    </td>
                    <td style={{ color: 'var(--text2)', whiteSpace: 'nowrap' }}>{fmtDate(s.submitted_at)}</td>
                    <td>
                      <div className={styles.actions}>
                        <button className={styles.iconBtn} title="Copy Email"
                          onClick={() => { navigator.clipboard.writeText(s.email || ''); showToast('Email copied') }}>
                          <Copy size={14} />
                        </button>
                        <button className={styles.iconBtn} title="Send Form Email"
                          onClick={async () => {
                            if (!formUrl) { showToast('No form URL configured'); return }
                            if (!s.email) { showToast('No email for this lead'); return }
                            try {
                              await sendFormEmail(s.email, s.name, formUrl)
                              showToast(`Form sent to ${s.email}`)
                            } catch (err) {
                              showToast('Send failed: ' + err.message)
                            }
                          }}>
                          <Send size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <SendLogTab showToast={showToast} formUrl={formUrl} submissions={submissions} />
      )}
    </>
  )
}
// ══════════════════════════════════════════════════════════════
// PAGE: ANALYTICS
// ══════════════════════════════════════════════════════════════

// ── period options + bucketing (local to Analytics page) ──────
const ANALYTICS_PERIODS = [
  { id: 'weekly',  label: 'Weekly'  },
  { id: 'monthly', label: 'Monthly' },
  { id: 'yearly',  label: 'Yearly'  },
]
const DOW_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']

// ══════════════════════════════════════════════════════════════
// Keyword mention mining — used for "Top interested services" chart.
// Reads real text per call: extracted.summary (jsonb, set by lead
// analysis step) → falls back to transcript if summary missing.
// This REPLACES the old `interested_services` array approach, which
// fragmented identical services into near-duplicate bars (e.g.
// "AI/ML Development" vs "AI / ML Development" vs "Mobile & Web
// Development" vs "Mobile and Web Development" — all separate bars
// for the same thing). Keyword groups normalize those variants into
// one bucket, and are mined straight from what the customer actually
// said, not from a possibly-inconsistent tag written elsewhere.
//
// EDIT THIS LIST to match what your agent actually pitches — these
// are generic placeholders. Each entry: label shown in the chart,
// and one or more match patterns (case-insensitive, substring).
// ══════════════════════════════════════════════════════════════
const TECH_KEYWORDS = [
  { label: 'CRM',                 patterns: ['crm', 'lead management', 'lead tracking'] },
  { label: 'WhatsApp',            patterns: ['whatsapp'] },
  { label: 'AI / ML Development', patterns: ['ai/ml', 'ai / ml', 'machine learning', 'ai agent', 'artificial intelligence', 'chatbot', 'voice bot', 'voice agent', 'automation'] },
  { label: 'Web Development',     patterns: ['website', 'web development', 'landing page'] },
  { label: 'Mobile Development',  patterns: ['mobile app', 'mobile development', 'android app', 'ios app'] },
  { label: 'Payments',            patterns: ['payment gateway', 'upi', 'online payment'] },
  { label: 'Cloud / Server',      patterns: ['cloud', 'server', 'hosting'] },
  { label: 'Integration/API',     patterns: ['integration', 'api', 'zapier', 'sync with'] },
  { label: 'Analytics/Dashboard', patterns: ['dashboard', 'analytics', 'reporting'] },
]

// counts, per record, how many DISTINCT keyword groups appear in the
// text — a record mentioning "crm" three times still counts once
// per group, so one gushing call doesn't skew the whole chart
function buildKeywordMentions(records, keywordGroups) {
  const counts = {}
  keywordGroups.forEach(g => { counts[g.label] = 0 })

  records.forEach(r => {
    // real schema has no `summary` column — text lives in extracted.summary
    // (jsonb, set by lead analysis step). Fall back to transcript if absent.
    const text = (
      r.extracted?.summary ||
      r.summary || // kept for safety if a `summary` column gets added later
      r.transcript ||
      ''
    ).toLowerCase()
    if (!text) return
    keywordGroups.forEach(g => {
      const hit = g.patterns.some(p => text.includes(p.toLowerCase()))
      if (hit) counts[g.label]++
    })
  })

  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .filter(d => d.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
}

function getAnalyticsPeriodConfig(period) {
  const now = new Date()
  if (period === 'weekly') {
    const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 7)
    return { cutoff, bucketKey: d => d.toLocaleDateString('en-IN', { weekday: 'short' }), order: DOW_LABELS }
  }
  if (period === 'yearly') {
    const cutoff = new Date(now); cutoff.setFullYear(cutoff.getFullYear() - 1)
    return { cutoff, bucketKey: d => d.toLocaleDateString('en-IN', { month: 'short' }), order: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] }
  }
  const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 30)
  return { cutoff, bucketKey: d => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }), order: null }
}

function filterRecordsByPeriod(records, period) {
  const { cutoff } = getAnalyticsPeriodConfig(period)
  return records.filter(r => r.timestamp && new Date(r.timestamp) >= cutoff)
}

function buildScoreSeries(records, period) {
  const { bucketKey, order } = getAnalyticsPeriodConfig(period)
  const map = {}
  records.forEach(r => {
    if (!r.timestamp) return
    const key = bucketKey(new Date(r.timestamp))
    if (!map[key]) map[key] = { date: key, scoreSum: 0, scoreN: 0 }
    map[key].scoreSum += (r.lead_score || 0)
    map[key].scoreN++
  })
  const toRow = key => {
    const m = map[key]
    return { date: key, avg_score: m && m.scoreN ? +(m.scoreSum / m.scoreN).toFixed(1) : 0 }
  }
  if (order) return order.map(toRow)
  return Object.keys(map)
    .map(toRow)
    .sort((a, b) => new Date(`1 ${a.date}`) - new Date(`1 ${b.date}`))
    .slice(-30)
}

// ── dropdown — reuses existing .filters / .filterBtn / .filterActive ──
function AnalyticsPeriodDropdown({ value, onChange }) {
  return (
    <div className={styles.filters}>
      {ANALYTICS_PERIODS.map(p => (
        <button
          key={p.id}
          onClick={() => onChange(p.id)}
          className={`${styles.filterBtn} ${value === p.id ? styles.filterActive : ''}`}
        >
          {p.label}
        </button>
      ))}
    </div>
  )
}

function PageAnalytics({ records, stats, loading }) {
  const [period, setPeriod] = useState('monthly')

  // filter to selected window, derive everything below from this subset
  const periodRecords = filterRecordsByPeriod(records, period)

  const total    = periodRecords.length
  const hot      = periodRecords.filter(r => r.lead_category === 'HOT').length
  const warm     = periodRecords.filter(r => r.lead_category === 'WARM').length
  const cold     = periodRecords.filter(r => r.lead_category === 'COLD').length
  const convRate = total ? Math.round(hot / total * 100) : 0
  const avgScore = periodRecords.length
    ? (periodRecords.reduce((s, r) => s + (r.lead_score || 0), 0) / periodRecords.length).toFixed(1)
    : '0'

  const durationData = ['HOT', 'WARM', 'COLD'].map(cat => {
    const rows = periodRecords.filter(r => r.lead_category === cat && r.duration_sec)
    const avg  = rows.length ? Math.round(rows.reduce((s, r) => s + r.duration_sec, 0) / rows.length) : 0
    return { category: cat, avg_min: +(avg / 60).toFixed(1) }
  })

  const dowData = DOW_LABELS.map((d, i) => ({
    day: d,
    calls: periodRecords.filter(r => r.timestamp && new Date(r.timestamp).getDay() === i).length,
  }))

  const scoreOverTime = buildScoreSeries(periodRecords, period)

  // "Top interested services" — now mined directly from call summaries
  // instead of the raw `interested_services` array, so near-duplicate
  // labels ("AI/ML Development" vs "AI / ML Development" etc.) collapse
  // into one real bucket, straight from what the customer said.
  const svcData = buildKeywordMentions(periodRecords, TECH_KEYWORDS)

  const periodLabel = period === 'weekly' ? 'Last 7 days' : period === 'yearly' ? 'Last 12 months' : 'Last 30 days'

  return (
    <>
      {/* top-right period dropdown */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <AnalyticsPeriodDropdown value={period} onChange={setPeriod} />
      </div>

      <div className={styles.metricsRow}>
        <MetricCard icon={TrendingUp}    label="Conversion Rate" value={loading ? '…' : `${convRate}%`} sub={periodLabel} color="var(--green)" />
        <MetricCard icon={CheckCircle2}  label="Avg Lead Score"  value={loading ? '…' : avgScore}        sub={periodLabel} color="var(--warm)" />
        <MetricCard icon={Flame}         label="Hot Leads"       value={loading ? '…' : hot}             sub={`${total} total calls`} color="var(--hot)" />
        <MetricCard icon={Phone}         label="Warm Leads"      value={loading ? '…' : warm}            sub={`${total ? Math.round(warm/total*100) : 0}% of total`} color="var(--warm)" />
        <MetricCard icon={Users}         label="Cold Leads"      value={loading ? '…' : cold}            sub={`${total ? Math.round(cold/total*100) : 0}% of total`} color="var(--cold)" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: '1.5rem' }}>
        <div className={styles.chartCard}>
          <h3 className={styles.chartTitle}>Avg call duration by category (min) · {periodLabel}</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={durationData} margin={{ top: 5, right: 10, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="category" tick={{ fill: 'var(--text2)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: 'var(--text2)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="avg_min" name="Avg mins" radius={[4,4,0,0]}>
                {durationData.map((d, i) => <Cell key={i} fill={CATEGORY_COLOR[d.category]} fillOpacity={0.85} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className={styles.chartCard}>
          <h3 className={styles.chartTitle}>Calls by day of week · {periodLabel}</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={dowData} margin={{ top: 5, right: 10, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="day" tick={{ fill: 'var(--text2)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: 'var(--text2)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="calls" name="Calls" fill="var(--accent)" fillOpacity={0.8} radius={[4,4,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className={styles.chartCard}>
          <h3 className={styles.chartTitle}>
            Avg lead score over time — {period === 'weekly' ? 'by day of week' : period === 'yearly' ? 'by month' : 'by day'} · {periodLabel}
          </h3>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={scoreOverTime} margin={{ top: 5, right: 10, bottom: 0, left: -20 }}>
              <defs>
                <linearGradient id="gScore" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor="#4ade80" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#4ade80" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="date" tick={{ fill: 'var(--text2)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis domain={[0,10]} tick={{ fill: 'var(--text2)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="avg_score" name="Avg score" stroke="#4ade80" fill="url(#gScore)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className={styles.chartCard}>
          <h3 className={styles.chartTitle}>Top interested services (from summaries) · {periodLabel}</h3>
          {svcData.length === 0 ? (
            <VisualEmptyState message="No service mentions found in this period's summaries" />
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart layout="vertical" data={svcData} margin={{ top: 5, right: 10, bottom: 0, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis type="number" tick={{ fill: 'var(--text2)', fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={{ fill: 'var(--text2)', fontSize: 10 }} axisLine={false} tickLine={false} width={120} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="count" name="Mentions" fill="var(--accent)" fillOpacity={0.8} radius={[0,4,4,0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
          <p style={{ fontSize: 10, color: 'var(--text3)', margin: '8px 0 0' }}>
            Mined from call summaries, not the raw interested_services tag — edit TECH_KEYWORDS in code to match what your agent pitches.
          </p>
        </div>
      </div>
    </>
  )
}
// ══════════════════════════════════════════════════════════════
// PAGE: Agent Profiles
// ══════════════════════════════════════════════════════════════
//
// CHANGED (this pass) — batch calling no longer has its own inline
// module-level store. It now imports everything from ./batchCallStore
// (the fixed v6 module — CALL_HANDLER_URL-based status polling,
// PENDING-only-until-terminal statuses, control.loopAlive so Resume
// never spawns a second dialing loop, Stop checked inside the
// pause-wait too). This file used to duplicate all of that with an
// older, buggier version — deleted, not kept side-by-side.
//
// Adjust the import path below if batchCallStore.js lives somewhere
// other than alongside this file.
import {
  useBatchStore, COUNTRY_CODES, BATCH_STATUSES, toE164,
  setCountryCode as setBatchCountryCode, setAgentId as setBatchAgentId,
  loadFromFileInput, loadFromFilePicker, loadFromGoogleSheetCsvUrl,
  startBatch, pauseBatch, stopBatch, exportBatchSheet,
} from './batchCallStore'

// base URL for the voice server (server.py) — separate from
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
  // Single-call dialer — hits server.py's POST /api/outbound-call
  // directly (to, agent_id, name). Tracks only the current dial
  // attempt's status, not a growing log. Uses toE164/COUNTRY_CODES
  // from batchCallStore so the same normalization rules apply to
  // both the single dialer and batch calling.
  // ────────────────────────────────────────────────────────────
  const [dialCountryCode, setDialCountryCode] = useState('91')
  const [dialTo, setDialTo] = useState('')
  const [dialName, setDialName] = useState('') // customer name → LLM lead_name for this call
  const [dialAgentId, setDialAgentId] = useState('')
  const [dialing, setDialing] = useState(false)
  const [callStatus, setCallStatus] = useState(null) // { status, message, time }

  useEffect(() => {
    if (!dialAgentId && agents.length) setDialAgentId(agents[0].agent_id)
  }, [agents, dialAgentId])

  async function placeCall() {
    const to = toE164(dialTo, dialCountryCode)
    if (!dialTo.trim()) { showToast('Enter a phone number to call', 'err'); return }
    if (!dialAgentId) { showToast('Select an agent', 'err'); return }

    const agentLabel = agents.find(a => a.agent_id === dialAgentId)?.name || dialAgentId

    setDialing(true)
    setCallStatus({ status: 'dialing', message: `Dialing ${to} via ${agentLabel}${dialName.trim() ? ` (${dialName.trim()})` : ''}…`, time: new Date() })

    try {
      const res = await fetch(`${VOICE_SERVER_URL}/api/outbound-call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, agent_id: dialAgentId, name: dialName.trim() }),
      })
      const data = await res.json()

      if (!res.ok || data.error) {
        setCallStatus({ status: 'failed', message: data.error || 'Call failed', time: new Date() })
        showToast('Call failed: ' + (data.error || res.statusText), 'err')
      } else if (!data.call_uuid) {
        setCallStatus({
          status: 'failed',
          message: `No answer webhook received from Plivo — call likely never connected (invalid number / carrier reject). from=${data.from || '—'}`,
          time: new Date(),
        })
        showToast('Call did not connect', 'err')
      } else {
        setCallStatus({
          status: 'placed',
          message: `Call placed ✓ from=${data.from || '—'} call_uuid=${data.call_uuid}`,
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
  // BATCH CALLING — all state + the dialing loop live in
  // batchCallStore.js now (module-level, survives page navigation).
  // This component only renders `batch` (a read-only snapshot) and
  // calls the store's exported functions. See batchCallStore.js for
  // the actual polling/loop/resume logic and why it's shaped this way.
  // ────────────────────────────────────────────────────────────
  const batch = useBatchStore()
  const batchTableBodyRef = useRef(null)
  const activeRowRef = useRef(null)

  // auto-scroll the pointer row into view as batch.index increments
  useEffect(() => {
    if (batch.index >= 0 && activeRowRef.current) {
      activeRowRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [batch.index])

  useEffect(() => {
    if (!batch.agentId && agents.length) setBatchAgentId(agents[0].agent_id)
  }, [agents, batch.agentId])

  async function handleBatchFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      await loadFromFileInput(file)
      showToast(`Loaded ✓ — no live disk write from this picker (use "Load with live write" for that)`)
    } catch (err) {
      showToast('Failed to parse file: ' + err.message, 'err')
    }
    e.target.value = '' // allow re-selecting the same file
  }

  // Chrome/Edge only — opens the SAME file for read+write, so every
  // status update writes straight back into the source file on disk.
  async function handleBatchFileLiveWrite() {
    try {
      await loadFromFilePicker()
      showToast('Loaded ✓ — live-writing status back to the source file')
    } catch (err) {
      showToast(err.message, 'err')
    }
  }

  const [sheetsUrl, setSheetsUrl] = useState('')
  const [sheetsLoading, setSheetsLoading] = useState(false)

  async function importFromGoogleSheets() {
    if (!sheetsUrl.trim()) { showToast('Paste a Google Sheets link first', 'err'); return }
    if (batch.running) { showToast('Stop the current batch first', 'err'); return }
    setSheetsLoading(true)
    try {
      await loadFromGoogleSheetCsvUrl(sheetsUrl.trim())
      showToast('Sheet imported ✓')
    } catch (e) {
      showToast('Google Sheets import failed: ' + e.message, 'err')
    }
    setSheetsLoading(false)
  }

  function handleStartOrResume() {
    if (!batch.rows.length) { showToast('Upload a sheet first', 'err'); return }
    if (!batch.agentId) { showToast('Select an agent', 'err'); return }
    const resuming = batch.index >= 0
    startBatch(VOICE_SERVER_URL, CALL_HANDLER_URL)
    showToast(resuming ? 'Batch resumed' : 'Batch calling started')
  }

  function handlePause() {
    pauseBatch()
    showToast('Batch paused')
  }

  function handleStop() {
    stopBatch()
    showToast('Batch stopped')
  }

  function handleExport() {
    if (!batch.rows.length) { showToast('Nothing to export', 'err'); return }
    exportBatchSheet()
    showToast('Sheet exported ✓')
  }

  // Colors for the real Plivo-CDR-derived statuses (batchCallStore.js
  // BATCH_STATUSES — no more DIALING/RINGING, a row is PENDING or
  // terminal, nothing in between).
  const batchStatusColor = {
    PENDING:   'var(--text3)',
    CONNECTED: '#4ade80',
    NO_ANSWER: 'var(--warm, #f5a623)',
    BUSY:      'var(--warm, #f5a623)',
    REJECTED:  'var(--hot)',
    FAILED:    'var(--hot)',
    UNKNOWN:   'var(--warm, #f5a623)',
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

          <div style={{ flex: '1 1 200px' }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
              Customer Name <span style={{ color: 'var(--text3)', textTransform: 'none', fontWeight: 400 }}>(optional)</span>
            </label>
            <input
              value={dialName}
              onChange={e => setDialName(e.target.value)}
              placeholder="e.g. Priya Sharma"
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
            {dialName.trim() && <> — greeting will use <span style={{ color: 'var(--text2)' }}>"{dialName.trim()}"</span></>}
          </p>
        )}

        {callStatus && (
          <div style={{ borderTop: '0.5px solid var(--border)', paddingTop: 10, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor[callStatus.status] || 'var(--text3)', flexShrink: 0 }} />
            <span style={{ color: 'var(--text3)' }}>{callStatus.time.toLocaleTimeString()}</span>
            <span style={{ color: 'var(--text1)' }}>{callStatus.message}</span>
          </div>
        )}
      </div>

      {/* BATCH CALLING CARD */}
      <div style={{ background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Batch Calling
          </span>
          {batch.canLiveWrite && (
            <span style={{ fontSize: 10, color: '#4ade80', display: 'flex', alignItems: 'center', gap: 4 }}>
              ● live-writing to disk
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '0 0 150px' }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
              Country
            </label>
            <select value={batch.countryCode} onChange={e => setBatchCountryCode(e.target.value)} style={inputStyle} disabled={batch.running}>
              {COUNTRY_CODES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
          </div>

          <div style={{ flex: '1 1 220px' }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
              Agent
            </label>
            <select value={batch.agentId} onChange={e => setBatchAgentId(e.target.value)} style={inputStyle} disabled={batch.running || agentsLoading}>
              {agentsLoading && <option>Loading…</option>}
              {agents.map(a => (
                <option key={a.agent_id} value={a.agent_id}>{a.name || '—'} ({a.agent_id})</option>
              ))}
            </select>
          </div>

          <div style={{ flex: '1 1 220px' }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
              Sheet (.xlsx / .csv)
            </label>
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={handleBatchFile}
              disabled={batch.running}
              style={{ ...inputStyle, padding: '6px' }}
            />
          </div>

          <button
            onClick={handleBatchFileLiveWrite}
            disabled={batch.running}
            title="Chrome/Edge only — writes call status back into this same file as the batch runs"
            style={{ padding: '8px 12px', background: 'var(--bg3)', border: '0.5px solid var(--border)', borderRadius: 8, color: 'var(--text2)', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', opacity: batch.running ? 0.5 : 1 }}
          >
            Load with live write
          </button>
        </div>

        {/* Google Sheets import — accepts a normal Share link or a
            published-to-web CSV link (see batchCallStore.js normalizeSheetsCsvUrl) */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 320px' }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
              …or Google Sheets link (shared or published-to-web)
            </label>
            <input
              value={sheetsUrl}
              onChange={e => setSheetsUrl(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/…"
              disabled={batch.running || sheetsLoading}
              style={inputStyle}
            />
          </div>
          <button
            onClick={importFromGoogleSheets}
            disabled={batch.running || sheetsLoading || !sheetsUrl.trim()}
            style={{ padding: '8px 14px', background: 'var(--bg3)', border: '0.5px solid var(--border)', borderRadius: 8, color: 'var(--text1)', fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: (!sheetsUrl.trim() || sheetsLoading) ? 0.6 : 1, whiteSpace: 'nowrap' }}
          >
            {sheetsLoading ? 'Loading…' : 'Import'}
          </button>
        </div>
        <p style={{ fontSize: 10, color: 'var(--text3)', margin: 0 }}>
          Read-only import — this pulls a snapshot of the sheet. Status updates write to the local table / disk / export, not back to the original Google Sheet.
          Add a "Name" column to have each row's lead name passed to the LLM automatically.
        </p>

        {batch.rows.length > 0 && (
          <p style={{ fontSize: 11, color: 'var(--text3)', margin: 0 }}>
            {batch.fileName} — {batch.rows.length} rows — phone column: <span style={{ color: 'var(--text2)', fontFamily: 'monospace' }}>{batch.phoneKey}</span>
            {batch.nameKey && <> — name column: <span style={{ color: 'var(--text2)', fontFamily: 'monospace' }}>{batch.nameKey}</span></>}
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {!batch.running ? (
            <button
              onClick={handleStartOrResume}
              disabled={!batch.rows.length || !batch.agentId}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: 'var(--accent)', border: 'none', borderRadius: 8, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: (!batch.rows.length || !batch.agentId) ? 0.6 : 1 }}
            >
              <Play size={14} /> {batch.index >= 0 ? 'Resume' : 'Start'} Calling
            </button>
          ) : (
            <button
              onClick={handlePause}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: 'var(--bg3)', border: '0.5px solid var(--border)', borderRadius: 8, color: 'var(--text1)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
            >
              <Pause size={14} /> Pause
            </button>
          )}
          <button
            onClick={handleStop}
            disabled={!batch.running && batch.index < 0}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: 'transparent', border: '0.5px solid var(--border)', borderRadius: 8, color: 'var(--hot)', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: (!batch.running && batch.index < 0) ? 0.5 : 1 }}
          >
            <Square size={14} /> Stop
          </button>
          <button
            onClick={handleExport}
            disabled={!batch.rows.length}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: 'var(--bg3)', border: '0.5px solid var(--border)', borderRadius: 8, color: 'var(--text1)', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: !batch.rows.length ? 0.5 : 1, marginLeft: 'auto' }}
          >
            <Download size={14} /> Export Sheet
          </button>
        </div>

        {/* ROWS TABLE — current row pointer + per-row status */}
        {batch.rows.length > 0 && (
          <div ref={batchTableBodyRef} style={{ maxHeight: 280, overflowY: 'auto', border: '0.5px solid var(--border)', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--bg3)', zIndex: 1 }}>
                <tr>
                  <th style={{ padding: '6px 8px', textAlign: 'left', width: 24 }}></th>
                  <th style={{ padding: '6px 8px', textAlign: 'left' }}>#</th>
                  <th style={{ padding: '6px 8px', textAlign: 'left' }}>Phone</th>
                  {batch.nameKey && <th style={{ padding: '6px 8px', textAlign: 'left' }}>Name</th>}
                  <th style={{ padding: '6px 8px', textAlign: 'left' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {batch.rows.map((r, i) => (
                  <tr
                    key={i}
                    ref={i === batch.index ? activeRowRef : null}
                    style={{ background: i === batch.index ? 'var(--bg3)' : 'transparent' }}
                  >
                    <td style={{ padding: '6px 8px' }}>{i === batch.index && batch.running && <ArrowRight size={13} color="var(--accent)" />}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--text3)' }}>{r.__row}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: 'var(--text1)' }}>{toE164(r.__phone, batch.countryCode)}</td>
                    {batch.nameKey && <td style={{ padding: '6px 8px', color: 'var(--text2)' }}>{r[batch.nameKey] || '—'}</td>}
                    <td style={{ padding: '6px 8px' }}>
                      <span style={{ color: batchStatusColor[r.__status] || 'var(--text3)', fontWeight: 600 }}>
                        {BATCH_STATUSES[r.__status] || r.__status}
                      </span>
                    </td>
                       <td style={{ padding: '6px 8px'}}>{r.__hangupCause}</td>
                     <td style={{ padding: '6px 8px' }}>
                      <span style={{ color: batchStatusColor[r.__status] || 'var(--text3)', fontWeight: 600 }}>{r.__hangupCause}</span>
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

        {/* CURRENT-ROW LOG — single line, not a growing list */}
        {batch.currentLog && (
          <div style={{ display: 'flex', gap: 8, fontSize: 11, padding: '6px 8px', background: 'var(--bg3)', borderRadius: 6, alignItems: 'center' }}>
            <span style={{ color: 'var(--text3)', flexShrink: 0 }}>{batch.currentLog.time.toLocaleTimeString()}</span>
            <span style={{ color: 'var(--text3)', flexShrink: 0 }}>row {batch.currentLog.row}</span>
            <span style={{ color: batch.currentLog.level === 'err' ? 'var(--hot)' : batch.currentLog.level === 'ok' ? '#4ade80' : 'var(--text1)' }}>{batch.currentLog.message}</span>
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
// ══════════════════════════════════════════════════════════════
// ROOT SHELL
// ══════════════════════════════════════════════════════════════
const NAV = [
  { id: 'dashboard', icon: Activity, label: 'Dashboard' },
  { id: 'leads', icon: Users, label: 'Leads' },
  { id: 'conversations', icon: FileText, label: 'Conversations' },
  { id: 'analytics', icon: BarChart2, label: 'Analytics' },
 
  { id: 'prompt', icon: MessageSquare, label: 'Agent Profiles' },
   { id: 'forms', icon: ClipboardList, label: 'Forms', badgeKey: 'forms' },
  { id: 'settings', icon: Settings, label: 'Settings' },
]

export default function Dashboard() {
  const [page, setPage] = useState('dashboard')
  const [records, setRecords] = useState([])
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('ALL')
  const [selected, setSelected] = useState(null)
  const [lastSync, setLastSync] = useState(null)
  const [agentConfig, setAgentConfig] = useState({})
  const [globalSearch, setGlobalSearch] = useState('')
  const [liveCall, setLiveCall] = useState(null)
  const [formCount, setFormCount] = useState(0)

  const { toast, show: showToast } = useToast()

  const fetchAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const leads = await fetchLeadsFromSupabase()
      setRecords(leads)
      setStats(computeStats(leads))
      setLastSync(new Date())
    } catch (e) {
      console.error('[Dashboard] fetch error:', e)
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    supabase.from('agent_config').select('key, value').then(({ data, error }) => {
      // FIX: was silently swallowing error
      if (error) console.error('[agentConfig load]', error.message)
      const map = {}
        ; (data || []).forEach(r => { map[r.key] = r.value })
      setAgentConfig(map)
    })
  }, [])

  useEffect(() => {
    fetchAll()
    const channel = supabase
      .channel('calls-realtime-global')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'calls' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          setLiveCall({ sid: payload.new.call_sid, from: payload.new.from_number, status: 'Connected' })
          setTimeout(() => setLiveCall(null), 8000)
        }
        fetchAll()
      })
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [fetchAll])

  async function openTranscript(callSid) {
    try {
      const data = await fetchTranscriptFromSupabase(callSid)
      setSelected(data)
    } catch (e) {
      setSelected({ call_sid: callSid, transcript: [], error: e.message })
    }
  }

  const pageTitle = NAV.find(n => n.id === page)?.label || 'Dashboard'

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}>
          <Activity size={20} color="var(--accent)" />
          <span>Inbox Infotech</span>
        </div>
        <nav className={styles.nav}>
          {NAV.map(({ id, icon: Icon, label, badgeKey }) => (
            <button key={id} onClick={() => setPage(id)}
              className={`${styles.navItem} ${page === id ? styles.navActive : ''}`}>
              <Icon size={16} />
              <span style={{ flex: 1, textAlign: 'left' }}>{label}</span>
              {badgeKey === 'forms' && formCount > 0 && (
                <span style={{ background: 'var(--accent)', color: '#fff', fontSize: 10, padding: '2px 6px', borderRadius: 10, fontWeight: 600 }}>
                  {formCount}
                </span>
              )}
            </button>
          ))}
        </nav>
      </aside>

      <main className={styles.main}>
        {liveCall && (
          <div style={{ background: 'rgba(255,107,74,0.15)', border: '1px solid var(--hot)', padding: '10px 16px', borderRadius: 10, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10, color: 'var(--hot)' }}>
            <Radio size={16} className={styles.spin} />
            <span style={{ fontSize: 13, fontWeight: 500 }}>
              <b>Live Call:</b> Incoming from {liveCall.from || 'anonymous'} ({liveCall.sid?.slice(0, 8)}…)
            </span>
            <button onClick={() => setLiveCall(null)} style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--hot)', cursor: 'pointer' }}>
              <X size={14} />
            </button>
          </div>
        )}

        <div className={styles.header}>
          <div>
            <h1 className={styles.pageTitle}>{pageTitle}</h1>
            <p className={styles.pageSub}>
              {lastSync ? `Last synced ${lastSync.toLocaleTimeString()}` : loading ? 'Fetching…' : 'Not yet synced'}
            </p>
          </div>

          <div style={{ position: 'relative', width: 320 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)' }} />
            <input
              value={globalSearch}
              onChange={e => setGlobalSearch(e.target.value)}
              placeholder="Search by name, phone, summary…"
              style={{ width: '100%', background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: 8, padding: '7px 12px 7px 32px', color: 'var(--text1)', fontSize: 12, outline: 'none', boxSizing: 'border-box' }}
            />
            {globalSearch && (
              <X size={12} onClick={() => setGlobalSearch('')}
                style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)', cursor: 'pointer' }} />
            )}
          </div>

          {!['prompt', 'settings'].includes(page) && (
            <button className={styles.refreshBtn} onClick={fetchAll} disabled={loading}>
              <RefreshCw size={14} className={loading ? styles.spin : ''} />
              Refresh
            </button>
          )}
        </div>

        {error && (
          <div className={styles.errorBanner}>
            <AlertCircle size={14} />
            <span><b>Supabase error:</b> {error}</span>
          </div>
        )}

        {page === 'dashboard' && <PageDashboard records={records} stats={stats} loading={loading} filter={filter} setFilter={setFilter} openTranscript={openTranscript} showToast={showToast} globalSearch={globalSearch} />}
        {page === 'leads' && <PageLeads records={records} loading={loading} openTranscript={openTranscript} showToast={showToast} fetchAll={fetchAll} agentConfig={agentConfig} globalSearch={globalSearch} />}
        {page === 'conversations' && <PageConversations records={records} loading={loading} openTranscript={openTranscript} globalSearch={globalSearch} />}
        {page === 'forms' && <PageForms showToast={showToast} globalSearch={globalSearch} setFormCount={setFormCount} />}
        {page === 'analytics' && <PageAnalytics records={records} stats={stats} loading={loading} />}
        {page === 'prompt' && <PageAgentProfiles showToast={showToast} />}
        {page === 'settings' && <PageSettings supabase={supabase} showToast={showToast} onConfigChange={cfg => setAgentConfig(c => ({ ...c, ...cfg }))} />}
      </main>

      {selected && (
        <div className={styles.modalOverlay} onClick={() => setSelected(null)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3>Transcript — <span className={styles.mono}>{selected.call_sid}</span></h3>
              <button className={styles.iconBtn} onClick={() => setSelected(null)}><X size={14} /></button>
            </div>
            {selected.error && (
              <div style={{ padding: '12px 1.25rem', color: 'var(--hot)', fontSize: 13 }}>Error: {selected.error}</div>
            )}
            <div className={styles.transcriptBody}>
              {selected.transcript?.length === 0 && !selected.error && (
                <VisualEmptyState message="No transcript data for this call" />
              )}
              {(selected.transcript || []).map((line, i) => {
                const isAgent = line.role === 'Agent'
                return (
                  <div key={i} className={`${styles.bubble} ${isAgent ? styles.bubbleAgent : styles.bubbleCustomer}`}>
                    <span className={styles.bubbleLabel}>{line.role}</span>
                    <p>{line.text}</p>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      <Toast toast={toast} />
    </div>
  )
}