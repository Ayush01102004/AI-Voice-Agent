// src/components/Dashboard.jsx
import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import {
  Phone, TrendingUp, Flame, Users, RefreshCw, Eye,
  PhoneCall, Copy, CheckCircle2, AlertCircle, Radio, Search,
  Clock, Activity, BarChart2, FileText, Download, X, History,
  ClipboardList, Settings, Zap, MessageSquare, Calendar,
  Handshake, StickyNote, ChevronDown, Send, Save, ArrowLeftRight
} from 'lucide-react'
import { supabase } from '../supabaseClient'
import styles from './Dashboard.module.css'

// ── DB adapter ────────────────────────────────────────────────
function normalizeRow(row) {
  const ex = row.extracted || {}
  return {
    ...row,
    lead_category: row.lead_category || 'COLD',
    timestamp:           row.created_at,
    summary:             ex.summary             ?? null,
    next_action:         ex.next_action         ?? null,
    name:                ex.name                ?? null,
    pain_points:         Array.isArray(ex.pain_points)         ? ex.pain_points         : [],
    interested_services: Array.isArray(ex.interested_services) ? ex.interested_services : [],
    budget:              ex.budget              ?? null,
    timeline:            ex.timeline            ?? null,
    decision_makers:     ex.decision_makers     ?? null,
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
  const hot   = records.filter(r => r.lead_category === 'HOT').length
  const warm  = records.filter(r => r.lead_category === 'WARM').length
  const cold  = records.filter(r => r.lead_category === 'COLD').length
  const avg   = total
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
const SCORE_COLOR    = s => s >= 8 ? '#ff6b4a' : s >= 5 ? '#f5a623' : '#5b9cf6'
const PIE_COLORS     = ['#ff6b4a', '#f5a623', '#5b9cf6']
const SOURCE_COLORS  = ['#6c63ff', '#4ade80', '#f5a623', '#5b9cf6', '#ff6b4a']
const ALL_CATS       = ['ALL', 'HOT', 'WARM', 'COLD', 'CLOSED']

// ── helpers ───────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}
function fmtDuration(sec) {
  if (!sec) return '—'
  return `${Math.floor(sec / 60)}m ${sec % 60}s`
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
  const rows = records.map(r => columns.map(c => `"${String(r[c] ?? '').replace(/"/g,'""')}"`).join(','))
  const blob = new Blob([[columns.join(','), ...rows].join('\n')], { type: 'text/csv' })
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${filename}_${new Date().toISOString().slice(0,10)}.csv` })
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
    HOT:    { bg: 'var(--hot-bg)',  color: 'var(--hot)'  },
    WARM:   { bg: 'var(--warm-bg)', color: 'var(--warm)' },
    COLD:   { bg: 'var(--cold-bg)', color: 'var(--cold)' },
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

function FilterBar({ value, onChange, cats = ['ALL','HOT','WARM','COLD','CLOSED'] }) {
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
    const d   = r.timestamp ? new Date(r.timestamp) : new Date()
    const key = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
    if (!map[key]) map[key] = { date: key, calls: 0, hot: 0, warm: 0, cold: 0 }
    map[key].calls++
    const cat = (r.lead_category || 'COLD').toUpperCase()
    if (cat === 'HOT')  map[key].hot++
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
  const total    = stats?.total_calls    ?? records.length
  const hot      = stats?.hot            ?? records.filter(r => r.lead_category === 'HOT').length
  const warm     = stats?.warm           ?? records.filter(r => r.lead_category === 'WARM').length
  const cold     = stats?.cold           ?? records.filter(r => r.lead_category === 'COLD').length
  const avgScore = stats?.avg_lead_score ?? (records.length ? (records.reduce((s, r) => s + (r.lead_score || 0), 0) / records.length).toFixed(1) : '0')
  const convRate = stats?.conversion_rate ?? (total ? Math.round(hot / total * 100) : 0)

  const filteredRecords = useMemo(() => {
    return records
      .filter(r => filter === 'ALL' || r.lead_category === filter)
      .filter(r => !globalSearch ||
        (r.to_number || '').includes(globalSearch) ||
        (r.name || '').toLowerCase().includes(globalSearch.toLowerCase()) ||
        (r.summary || '').toLowerCase().includes(globalSearch.toLowerCase()))
  }, [records, filter, globalSearch])

  const weeklyData = buildWeeklyData(records)
  const pieData = [
    { name: 'Hot',  value: hot,  pct: total ? Math.round(hot  / total * 100) : 0 },
    { name: 'Warm', value: warm, pct: total ? Math.round(warm / total * 100) : 0 },
    { name: 'Cold', value: cold, pct: total ? Math.round(cold / total * 100) : 0 },
  ]
  const sourceData = buildSourceData(records)

  return (
    <>
      <div className={styles.metricsRow}>
        <MetricCard icon={Users}        label="Total leads"  value={loading ? '…' : total}           sub="all time" />
        <MetricCard icon={Flame}        label="Hot leads"    value={loading ? '…' : hot}             sub={`${Math.round(hot / Math.max(total,1) * 100)}% of total`} color="var(--hot)" />
        <MetricCard icon={Phone}        label="Total calls"  value={loading ? '…' : total}           sub="processed" color="var(--accent)" />
        <MetricCard icon={TrendingUp}   label="Conversion"   value={loading ? '…' : `${convRate}%`} sub="hot / total" color="var(--green)" />
        <MetricCard icon={CheckCircle2} label="Avg score"    value={loading ? '…' : avgScore}        sub="out of 10" color="var(--warm)" />
      </div>

      <div className={styles.chartsRow}>
        <div className={styles.chartCard}>
          <h3 className={styles.chartTitle}>Calls over time</h3>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={weeklyData} margin={{ top: 5, right: 10, bottom: 0, left: -20 }}>
              <defs>
                <linearGradient id="gHot"  x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor="#ff6b4a" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#ff6b4a" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gWarm" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor="#f5a623" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#f5a623" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="date" tick={{ fill: 'var(--text2)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: 'var(--text2)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="hot"  name="Hot"  stroke="#ff6b4a" fill="url(#gHot)"  strokeWidth={2} dot={false} />
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
          <FilterBar value={filter} onChange={setFilter} cats={['ALL','HOT','WARM','COLD','CLOSED']} />
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Phone</th>
                <th>Status</th>
                <th>Score</th>
                <th>Duration</th>
                <th>Summary</th>
                <th>Date</th>
                <th>Last Contacted</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className={styles.emptyRow}>Loading…</td></tr>
              ) : filteredRecords.length === 0 ? (
                <tr><td colSpan={8}><VisualEmptyState message="No matching recent records found" /></td></tr>
              ) : filteredRecords.map(r => (
                <tr key={r.call_sid} className={styles.tableRow}>
                  <td className={styles.mono}>{r.to_number || '—'}</td>
                  <td><Badge category={r.lead_category} /></td>
                  <td><StarScore score={r.lead_score || 1} /></td>
                  <td style={{ color: 'var(--text2)' }}>{fmtDuration(r.duration_sec)}</td>
                  <td className={styles.summaryCell}>{r.summary || '—'}</td>
                  <td style={{ color: 'var(--text2)', whiteSpace: 'nowrap' }}>{fmtDate(r.timestamp)}</td>
                  <td style={{ color: 'var(--text2)', fontSize: 12 }}>{r.last_contacted_at ? fmtDateTime(r.last_contacted_at) : fmtDateTime(r.timestamp)}</td>
                  <td>
                    <div className={styles.actions}>
                      <button className={styles.iconBtn} title="View transcript" onClick={() => openTranscript(r.call_sid)}><Eye size={14} /></button>
                      <button className={styles.iconBtn} title={`Call ${r.to_number}`} onClick={() => window.open(`tel:${r.to_number}`)}><PhoneCall size={14} /></button>
                      <button className={styles.iconBtn} title="Copy number" onClick={() => { navigator.clipboard.writeText(r.to_number || ''); showToast(`Copied ${r.to_number}`) }}><Copy size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={styles.tableFooter}>Showing {filteredRecords.length} of {total} records</p>
      </div>
    </>
  )
}

// ══════════════════════════════════════════════════════════════
// PAGE: LEADS
// ══════════════════════════════════════════════════════════════
function PageLeads({ records, loading, openTranscript, showToast, fetchAll, agentConfig, globalSearch }) {
  const [catFilter, setCatFilter] = useState('ALL')
  const [sortKey,   setSortKey]   = useState('timestamp')
  const [sortDir,   setSortDir]   = useState('desc')
  const [pageSize,  setPageSize]  = useState(10)
  const [detail,    setDetail]    = useState(null)
  const [notes,     setNotes]     = useState([])
  const [noteInput, setNoteInput] = useState('')
  const [notesLoading,  setNotesLoading]  = useState(false)
  const [statusSaving,  setStatusSaving]  = useState(false)
  const [noteAuthor,    setNoteAuthor]    = useState('Sales Team')

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
          <FilterBar value={catFilter} onChange={setCatFilter} cats={['ALL','HOT','WARM','COLD','CLOSED']} />
          <select
            value={pageSize}
            onChange={e => setPageSize(Number(e.target.value))}
            style={{ background: 'var(--bg3)', border: '0.5px solid var(--border2)', borderRadius: 8, padding: '6px 10px', color: 'var(--text1)', fontSize: 12, cursor: 'pointer', outline: 'none' }}>
            {[10, 20, 30, 40].map(n => <option key={n} value={n}>{n} per page</option>)}
          </select>
          <button onClick={() => { exportCSV(filtered, ['name','to_number','lead_category','lead_score','duration_sec','budget','decision_makers','timestamp','last_contacted_at'], 'leads'); showToast(`Exported ${filtered.length} rows`) }}
            style={{ display:'flex', alignItems:'center', gap:6, padding:'6px 14px', background:'var(--bg3)', border:'0.5px solid var(--border2)', borderRadius:8, color:'var(--text1)', fontSize:12, cursor:'pointer', whiteSpace:'nowrap' }}>
            <Download size={13}/> Export CSV
          </button>
        </div>

        <div className={styles.tableCard}>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th><SortBtn k="name"          label="Name"   /></th>
                  <th><SortBtn k="to_number"     label="Phone"  /></th>
                  <th><SortBtn k="lead_category" label="Status" /></th>
                  <th><SortBtn k="lead_score"    label="Score"  /></th>
                  <th>Budget</th>
                  <th>Decision Maker</th>
                  <th>Last Contacted</th>
                  <th><SortBtn k="timestamp"     label="Date"   /></th>
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
                    <td style={{ fontSize: 12 }}>{r.decision_makers || '—'}</td>
                    <td style={{ color: 'var(--text2)', fontSize: 12 }}>{r.last_contacted_at ? fmtDateTime(r.last_contacted_at) : fmtDateTime(r.timestamp)}</td>
                    <td style={{ color: 'var(--text2)', whiteSpace: 'nowrap' }}>{fmtDate(r.timestamp)}</td>
                    <td onClick={e => e.stopPropagation()}>
                      <div className={styles.actions}>
                        <button className={styles.iconBtn} onClick={() => openTranscript(r.call_sid)}><Eye size={14} /></button>
                        <button className={styles.iconBtn} title={`Call ${r.to_number}`} onClick={e => { e.stopPropagation(); window.open(`tel:${r.to_number}`) }}><PhoneCall size={14} /></button>
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
              <option value="HOT"    style={{ color: '#ff6b4a' }}>🔥 HOT</option>
              <option value="WARM"   style={{ color: '#f5a623' }}>🌤 WARM</option>
              <option value="COLD"   style={{ color: '#5b9cf6' }}>❄️ COLD</option>
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
              style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px', background:'var(--bg3)', border:'0.5px solid var(--border)', borderRadius:8, color:'var(--green)', fontSize:12, cursor:'pointer', textAlign:'left' }}>
              <PhoneCall size={13} /> Follow-up Call
            </button>
            <button
              onClick={async () => { await updateStatus(detail.call_sid, 'CLOSED'); showToast('Deal closed! 🎉') }}
              disabled={detail.lead_category === 'CLOSED' || statusSaving}
              style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px', background: detail.lead_category === 'CLOSED' ? 'rgba(74,222,128,0.08)' : 'var(--bg3)', border:`0.5px solid ${detail.lead_category === 'CLOSED' ? 'rgba(74,222,128,0.4)' : 'var(--border)'}`, borderRadius:8, color: detail.lead_category === 'CLOSED' ? '#4ade80' : 'var(--hot)', fontSize:12, cursor: detail.lead_category === 'CLOSED' ? 'default' : 'pointer', textAlign:'left', opacity: detail.lead_category === 'CLOSED' ? 0.7 : 1 }}>
              <Handshake size={13} /> {detail.lead_category === 'CLOSED' ? 'Deal Closed ✓' : 'Close Deal'}
            </button>
            <button
              onClick={() => {
                // FIX: was using undefined `calendlyLink` in outer scope — now correctly uses local var
                window.open(calendlyLink || 'https://calendly.com', '_blank')
              }}
              style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px', background:'var(--bg3)', border:'0.5px solid var(--border)', borderRadius:8, color:'var(--accent)', fontSize:12, cursor:'pointer', textAlign:'left' }}>
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
              style={{ flex:1, background:'var(--bg3)', border:'0.5px solid var(--border)', borderRadius:8, padding:'7px 10px', color:'var(--text1)', fontSize:12, outline:'none' }}
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
  const [selected,  setSelected] = useState(null)
  const [txData,    setTxData]   = useState(null)
  const [txLoading, setTxLoading] = useState(false)

  const filtered = useMemo(() => {
    return records.filter(r =>
      !globalSearch ||
      (r.to_number || '').includes(globalSearch) ||
      (r.name || '').toLowerCase().includes(globalSearch.toLowerCase()) ||
      (r.summary || '').toLowerCase().includes(globalSearch.toLowerCase())
    )
  }, [records, globalSearch])

  async function loadTranscript(r) {
    setSelected(r)
    setTxData(null)
    setTxLoading(true)
    try {
      const data = await fetchTranscriptFromSupabase(r.call_sid)
      setTxData(data)
    } catch (e) {
      setTxData({ error: e.message, transcript: [] })
    } finally {
      setTxLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 140px)' }}>
      <div style={{ width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto' }}>
        {loading && <p style={{ color: 'var(--text2)', textAlign: 'center', padding: '2rem', fontSize: 13 }}>Loading…</p>}
        {filtered.map(r => (
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
            <div style={{ flex: 1, overflowY: 'auto', padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {txLoading && <p style={{ color: 'var(--text2)', textAlign: 'center', padding: '2rem', fontSize: 13 }}>Loading transcript…</p>}
              {txData?.error && <p style={{ color: 'var(--hot)', padding: '1rem', fontSize: 13 }}>Error: {txData.error}</p>}
              {!txLoading && txData?.transcript?.length === 0 && !txData?.error && (
                <VisualEmptyState message="No transcript data available for this call" />
              )}
              {txData?.transcript?.map((line, i) => {
                const isAgent = line.role === 'Agent'
                return (
                  <div key={i} className={`${styles.bubble} ${isAgent ? styles.bubbleAgent : styles.bubbleCustomer}`}>
                    <span className={styles.bubbleLabel}>{line.role}</span>
                    <p>{line.text}</p>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// PAGE: FORMS
// ══════════════════════════════════════════════════════════════
function PageForms({ showToast, globalSearch, setFormCount }) {
  const [submissions, setSubmissions] = useState([])
  const [loading,     setLoading]     = useState(true)
  // FIX: added error state — was silently failing on 400/RLS errors
  const [fetchError,  setFetchError]  = useState(null)

  useEffect(() => {
    setLoading(true)
    setFetchError(null)
    supabase.from('form_submissions')
      .select('*, calls(lead_category, lead_score)')
      .order('submitted_at', { ascending: false })
      .limit(200)
      .then(({ data, error }) => {
        if (error) {
          console.error('[PageForms]', error.message)
          setFetchError(error.message)
        }
        const items = data || []
        setSubmissions(items)
        setFormCount(items.length)
        setLoading(false)
      })
  }, [setFormCount])

  const filtered = useMemo(() => {
    return submissions.filter(s =>
      !globalSearch ||
      (s.name || '').toLowerCase().includes(globalSearch.toLowerCase()) ||
      (s.to_number || '').includes(globalSearch) ||
      (s.email || '').toLowerCase().includes(globalSearch.toLowerCase()) ||
      (s.service_requirements || '').toLowerCase().includes(globalSearch.toLowerCase())
    )
  }, [submissions, globalSearch])

  return (
    <>
      {fetchError && (
        <div className={styles.errorBanner} style={{ marginBottom: 12 }}>
          <AlertCircle size={14} />
          <span><b>Forms fetch error:</b> {fetchError}</span>
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, justifyContent: 'flex-end', alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--text2)' }}>{filtered.length} submissions</span>
        <button onClick={() => { exportCSV(filtered, ['name','to_number','email','service_requirements','budget','timeline','submitted_at'], 'form_submissions'); showToast(`Exported ${filtered.length} form rows`) }}
          style={{ display:'flex', alignItems:'center', gap:6, padding:'6px 14px', background:'var(--bg3)', border:'0.5px solid var(--border2)', borderRadius:8, color:'var(--text1)', fontSize:12, cursor:'pointer', whiteSpace:'nowrap' }}>
          <Download size={13}/> Export CSV
        </button>
      </div>
      <div className={styles.tableCard}>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Email</th>
                <th>Service requirements</th>
                <th>Budget</th>
                <th>Timeline</th>
                <th>Lead status</th>
                <th>Submitted</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} className={styles.emptyRow}>Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={9}><VisualEmptyState message="No form submissions found" /></td></tr>
              ) : filtered.map(s => (
                <tr key={s.id} className={styles.tableRow}>
                  <td style={{ fontWeight: 500 }}>{s.name || '—'}</td>
                  <td className={styles.mono}>{s.to_number || '—'}</td>
                  <td style={{ color: 'var(--text2)', fontSize: 12 }}>{s.email || '—'}</td>
                  <td className={styles.summaryCell}>{s.service_requirements || '—'}</td>
                  <td style={{ color: 'var(--text2)' }}>{s.budget || '—'}</td>
                  <td style={{ color: 'var(--text2)' }}>{s.timeline || '—'}</td>
                  <td>{s.calls ? <Badge category={s.calls.lead_category} /> : <span style={{ color: 'var(--text3)', fontSize: 12 }}>—</span>}</td>
                  <td style={{ color: 'var(--text2)', whiteSpace: 'nowrap' }}>{fmtDate(s.submitted_at)}</td>
                  <td>
                    <div className={styles.actions}>
                      <button className={styles.iconBtn} title="Copy phone" onClick={() => { navigator.clipboard.writeText(s.to_number || ''); showToast(`Copied ${s.to_number}`) }}><Copy size={14} /></button>
                      <button className={styles.iconBtn} title="Call" onClick={() => window.open(`tel:${s.to_number}`)}><PhoneCall size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

// ══════════════════════════════════════════════════════════════
// PAGE: ANALYTICS
// ══════════════════════════════════════════════════════════════
function PageAnalytics({ records, stats, loading }) {
  const total    = stats?.total_calls ?? records.length
  const hot      = stats?.hot  ?? records.filter(r => r.lead_category === 'HOT').length
  const warm     = stats?.warm ?? records.filter(r => r.lead_category === 'WARM').length
  const cold     = stats?.cold ?? records.filter(r => r.lead_category === 'COLD').length
  const convRate = stats?.conversion_rate ?? (total ? Math.round(hot / total * 100) : 0)
  const avgScore = stats?.avg_lead_score  ?? (records.length ? (records.reduce((s, r) => s + (r.lead_score || 0), 0) / records.length).toFixed(1) : 0)

  const durationData = ['HOT','WARM','COLD'].map(cat => {
    const rows = records.filter(r => r.lead_category === cat && r.duration_sec)
    const avg  = rows.length ? Math.round(rows.reduce((s, r) => s + r.duration_sec, 0) / rows.length) : 0
    return { category: cat, avg_sec: avg, avg_min: +(avg / 60).toFixed(1) }
  })

  const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
  const dowData = DOW.map((d, i) => ({
    day: d,
    calls: records.filter(r => r.timestamp && new Date(r.timestamp).getDay() === i).length,
  }))

  const serviceMap = {}
  records.forEach(r => {
    (r.interested_services || []).forEach(s => { serviceMap[s] = (serviceMap[s] || 0) + 1 })
  })
  const serviceData = Object.entries(serviceMap).sort((a,b) => b[1]-a[1]).slice(0,8).map(([name, count]) => ({ name, count }))

  const scoreOverTime = buildWeeklyData(records).map(d => ({
    ...d,
    avg_score: records.filter(r => {
      const k = r.timestamp ? new Date(r.timestamp).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : ''
      return k === d.date
    }).reduce((s, r, _, a) => s + (r.lead_score || 0) / a.length, 0).toFixed(1),
  }))

  const sourceData = buildSourceData(records)

  return (
    <>
      <div className={styles.metricsRow}>
        <MetricCard icon={TrendingUp}   label="Conversion rate" value={loading ? '…' : `${convRate}%`}  sub="hot leads / total" color="var(--green)" />
        <MetricCard icon={CheckCircle2} label="Avg lead score"  value={loading ? '…' : avgScore}        sub="out of 10" color="var(--warm)" />
        <MetricCard icon={Flame}        label="Hot leads"       value={loading ? '…' : hot}             sub={`${total} total calls`} color="var(--hot)" />
        <MetricCard icon={Phone}        label="Warm leads"      value={loading ? '…' : warm}            sub={`${total ? Math.round(warm/total*100) : 0}% of total`} color="var(--warm)" />
        <MetricCard icon={Users}        label="Cold leads"      value={loading ? '…' : cold}            sub={`${total ? Math.round(cold/total*100) : 0}% of total`} color="var(--cold)" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: '1.5rem' }}>
        <div className={styles.chartCard}>
          <h3 className={styles.chartTitle}>Avg call duration by category (min)</h3>
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
          <h3 className={styles.chartTitle}>Calls by day of week</h3>
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
          <h3 className={styles.chartTitle}>Avg lead score over time</h3>
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
          <h3 className={styles.chartTitle}>Top interested services</h3>
          {serviceData.length === 0 ? (
            <VisualEmptyState message="No service data available" />
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart layout="vertical" data={serviceData} margin={{ top: 5, right: 10, bottom: 0, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis type="number" tick={{ fill: 'var(--text2)', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" tick={{ fill: 'var(--text2)', fontSize: 10 }} axisLine={false} tickLine={false} width={100} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="count" name="Mentions" fill="var(--accent)" fillOpacity={0.8} radius={[0,4,4,0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </>
  )
}
// ══════════════════════════════════════════════════════════════
// PAGE: PROMPT
// ══════════════════════════════════════════════════════════════
function PagePrompt({ showToast }) {
  const [prompt, setPrompt] = useState('')
  const [activePrompt, setActivePrompt] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [lastSaved, setLastSaved] = useState(null)

  // NEW
  const [rollbackLog, setRollbackLog] = useState([])

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // ────────────────────────────────────────────────────────────
  // Load rollback history
  // ────────────────────────────────────────────────────────────
  async function loadRollbackHistory() {
    const { data, error } = await supabase
      .from('prompt_versions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20)

    if (!error) {
      setRollbackLog(data || [])
    } else {
      console.error('[loadRollbackHistory]', error.message)
    }
  }

  // ────────────────────────────────────────────────────────────
  // Load active prompt
  // ────────────────────────────────────────────────────────────
  async function fetchPrompt() {
    const { data, error } = await supabase
      .from('agent_config')
      .select('value, updated_at')
      .eq('key', 'system_prompt')
      .single()

    if (error) {
      console.error('[fetchPrompt]', error.message)
      setLoading(false)
      return
    }

    setPrompt(data?.value || '')
    setActivePrompt(data?.value || '')

    if (data?.updated_at) {
      setLastSaved(new Date(data.updated_at))
    }

    setLoading(false)
  }

  // ────────────────────────────────────────────────────────────
  // Initial load
  // ────────────────────────────────────────────────────────────
  useEffect(() => {
    fetchPrompt()
    loadRollbackHistory()
  }, [])

  const tokenCount = useMemo(
    () => Math.round((prompt || '').length / 4),
    [prompt]
  )

  // ────────────────────────────────────────────────────────────
  // SAVE PROMPT
  // ────────────────────────────────────────────────────────────
  async function save() {
    try {
      setSaving(true)

      const now = new Date().toISOString()

      // SAVE OLD PROMPT INTO HISTORY
      await supabase
        .from('prompt_versions')
        .insert({
          prompt_key: 'system_prompt',
          prompt_value: activePrompt,
          rollback_note: 'Manual production update',
        })

      // UPDATE LIVE PROMPT
      const { error } = await supabase
        .from('agent_config')
        .update({
          value: prompt,
          updated_at: now,
        })
        .eq('key', 'system_prompt')

      setSaving(false)

      if (error) {
        console.error('[save prompt]', error.message)
        showToast('Error saving prompt', 'err')
        return
      }

      setActivePrompt(prompt)
      setLastSaved(new Date(now))
      setIsEditing(false)

      await loadRollbackHistory()

      showToast('Prompt deployed successfully ✓')
    } catch (err) {
      console.error(err)
      setSaving(false)
      showToast('Unexpected error occurred', 'err')
    }
  }

  // ────────────────────────────────────────────────────────────
  // REAL ROLLBACK
  // ────────────────────────────────────────────────────────────
  async function rollbackPrompt(oldPrompt) {
    try {
      const { error } = await supabase
        .from('agent_config')
        .update({
          value: oldPrompt,
          updated_at: new Date().toISOString(),
        })
        .eq('key', 'system_prompt')

      if (error) {
        console.error('[rollbackPrompt]', error.message)
        showToast('Rollback failed', 'err')
        return
      }

      setPrompt(oldPrompt)
      setActivePrompt(oldPrompt)

      await fetchPrompt()
      await loadRollbackHistory()

      showToast('Rollback completed ✓')
    } catch (err) {
      console.error(err)
      showToast('Rollback failed', 'err')
    }
  }

  if (loading) {
    return (
      <p
        style={{
          color: 'var(--text2)',
          padding: '2rem',
          textAlign: 'center',
        }}
      >
        Loading prompt…
      </p>
    )
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 280px',
        gap: 20,
      }}
    >
      {/* LEFT PANEL */}
      <div style={{ maxWidth: 720 }}>
        <div
          style={{
            background: 'var(--accent-dim)',
            border: '0.5px solid rgba(108,99,255,0.3)',
            borderRadius: 10,
            padding: '10px 14px',
            marginBottom: 16,
            fontSize: 13,
            color: 'var(--text2)',
          }}
        >
          <span
            style={{
              color: 'var(--accent)',
              fontWeight: 600,
            }}
          >
            System Deployment Mode
          </span>

          {' '}— Modifying this mutates live agent logic instantly.

          {lastSaved && (
            <div
              style={{
                fontSize: 11,
                marginTop: 4,
                color: 'var(--text3)',
              }}
            >
              Last saved: {lastSaved.toLocaleString()}
            </div>
          )}
        </div>

        {!isEditing ? (
          <div
            style={{
              background: 'var(--bg2)',
              border: '1px dashed var(--border)',
              borderRadius: 10,
              padding: '16px',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 12,
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--green)',
                  textTransform: 'uppercase',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: 'var(--green)',
                    display: 'inline-block',
                  }}
                />

                Active Live Prompt
              </span>

              <button
                onClick={() => setIsEditing(true)}
                style={{
                  padding: '4px 12px',
                  background: 'var(--bg3)',
                  border: '0.5px solid var(--border2)',
                  color: 'var(--text1)',
                  fontSize: 12,
                  borderRadius: 6,
                  cursor: 'pointer',
                }}
              >
                Modify Production Prompt
              </button>
            </div>

            <pre
              style={{
                whiteSpace: 'pre-wrap',
                fontSize: 12,
                color: 'var(--text2)',
                fontFamily: 'monospace',
                margin: 0,
                lineHeight: 1.6,
              }}
            >
              {activePrompt || 'No prompt configured yet.'}
            </pre>
          </div>
        ) : (
          <>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={18}
              style={{
                width: '100%',
                background: 'var(--bg2)',
                border: '1px solid var(--accent)',
                borderRadius: 10,
                padding: '14px 16px',
                color: 'var(--text1)',
                fontSize: 13,
                lineHeight: 1.7,
                outline: 'none',
                resize: 'vertical',
                fontFamily: 'inherit',
                boxSizing: 'border-box',
              }}
            />

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginTop: 12,
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  color: 'var(--text3)',
                }}
              >
                <b>{prompt.length}</b> chars ·{' '}
                <b>{tokenCount}</b> est. tokens
              </span>

              <div
                style={{
                  display: 'flex',
                  gap: 8,
                }}
              >
                <button
                  onClick={() => {
                    setPrompt(activePrompt)
                    setIsEditing(false)
                  }}
                  style={{
                    padding: '8px 14px',
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text2)',
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>

                <button
                  onClick={save}
                  disabled={saving}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '9px 20px',
                    background: 'var(--accent)',
                    border: 'none',
                    borderRadius: 8,
                    color: '#fff',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                    opacity: saving ? 0.6 : 1,
                  }}
                >
                  <Save size={14} />
                  {saving ? 'Deploying…' : 'Publish Version'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* RIGHT PANEL */}
      <div
        style={{
          background: 'var(--bg2)',
          borderRadius: 12,
          padding: '14px',
          border: '0.5px solid var(--border)',
          height: 'fit-content',
        }}
      >
        <h4
          style={{
            margin: '0 0 12px 0',
            fontSize: 12,
            textTransform: 'uppercase',
            color: 'var(--text2)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <History size={13} />
          Rollback Log
        </h4>

        {rollbackLog.length === 0 ? (
          <p
            style={{
              fontSize: 11,
              color: 'var(--text3)',
              margin: 0,
            }}
          >
            No rollback history found.
          </p>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {rollbackLog.map((log) => (
              <div
                key={log.id}
                style={{
                  background: 'var(--bg3)',
                  borderRadius: 6,
                  padding: '8px',
                  fontSize: 11,
                }}
              >
                <p
                  style={{
                    color: 'var(--text3)',
                    margin: '0 0 4px 0',
                  }}
                >
                  {new Date(log.created_at).toLocaleString()}
                </p>

                <p
                  style={{
                    color: 'var(--text2)',
                    margin: '0 0 6px 0',
                    fontSize: 10,
                  }}
                >
                  {log.rollback_note}
                </p>

                <button
                  onClick={() =>
                    rollbackPrompt(log.prompt_value)
                  }
                  style={{
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    color: 'var(--accent)',
                    cursor: 'pointer',
                    fontSize: 11,
                    fontWeight: 500,
                  }}
                >
                  Rollback →
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}



// ══════════════════════════════════════════════════════════════
// PAGE: SETTINGS
// ══════════════════════════════════════════════════════════════
const SETTINGS_FIELDS = [
  { key: 'agent_name',          label: 'Agent name',            placeholder: 'Alex',                           type: 'text'   },
  { key: 'company_name',        label: 'Company name',          placeholder: 'Inbox Infotech',                 type: 'text'   },
  { key: 'calendly_link',       label: 'Calendly link',         placeholder: 'https://calendly.com/your-link', type: 'url'    },
  { key: 'followup_delay',      label: 'Follow-up delay (hrs)', placeholder: '24',                             type: 'number' },
  { key: 'notification_email',  label: 'Notification email',    placeholder: 'sales@yourcompany.com',          type: 'email'  },
]

function PageSettings({ showToast, onConfigChange }) {
  const [values,  setValues]  = useState({})
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)

  useEffect(() => {
    supabase.from('agent_config').select('key, value')
      .in('key', SETTINGS_FIELDS.map(f => f.key))
      .then(({ data, error }) => {
        // FIX: was silently swallowing error
        if (error) console.error('[PageSettings load]', error.message)
        const map = {}
        ;(data || []).forEach(r => { map[r.key] = r.value })
        setValues(map)
        setLoading(false)
      })
  }, [])

  async function save() {
    setSaving(true)
    const upserts = SETTINGS_FIELDS.map(f => ({
      key: f.key,
      value: values[f.key] || '',
      updated_at: new Date().toISOString(),
    }))
    const { error } = await supabase.from('agent_config').upsert(upserts, { onConflict: 'key' })
    setSaving(false)
    if (error) { showToast('Error saving settings', 'err'); return }
    showToast('Settings saved ✓')
    onConfigChange(values)
  }

  if (loading) return <p style={{ color: 'var(--text2)', padding: '2rem', textAlign: 'center' }}>Loading config…</p>

  return (
    <div style={{ maxWidth: 560 }}>
      <div style={{ background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: 14, padding: '1.5rem' }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 20 }}>Agent configuration</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {SETTINGS_FIELDS.map(f => (
            <div key={f.key}>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>{f.label}</label>
              <input
                type={f.type}
                value={values[f.key] || ''}
                onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
                placeholder={f.placeholder}
                style={{ width: '100%', background: 'var(--bg3)', border: '0.5px solid var(--border)', borderRadius: 8, padding: '9px 12px', color: 'var(--text1)', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
              />
            </div>
          ))}
        </div>
        <button
          onClick={save} disabled={saving}
          style={{ display:'flex', alignItems:'center', gap:6, marginTop:24, padding:'9px 20px', background:'var(--accent)', border:'none', borderRadius:8, color:'#fff', fontSize:13, fontWeight:600, cursor:'pointer', opacity: saving ? 0.6 : 1 }}>
          <Save size={14} /> {saving ? 'Saving…' : 'Save Settings'}
        </button>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// ROOT SHELL
// ══════════════════════════════════════════════════════════════
const NAV = [
  { id: 'dashboard',     icon: Activity,       label: 'Dashboard'     },
  { id: 'leads',         icon: Users,          label: 'Leads'         },
  { id: 'conversations', icon: FileText,       label: 'Conversations' },
  { id: 'forms',         icon: ClipboardList,  label: 'Forms', badgeKey: 'forms' },
  { id: 'analytics',     icon: BarChart2,      label: 'Analytics'     },
  { id: 'prompt',        icon: MessageSquare,  label: 'Agent Prompt'  },
  { id: 'settings',      icon: Settings,       label: 'Settings'      },
]

export default function Dashboard() {
  const [page,        setPage]       = useState('dashboard')
  const [records,     setRecords]    = useState([])
  const [stats,       setStats]      = useState(null)
  const [loading,     setLoading]    = useState(true)
  const [error,       setError]      = useState(null)
  const [filter,      setFilter]     = useState('ALL')
  const [selected,    setSelected]   = useState(null)
  const [lastSync,    setLastSync]   = useState(null)
  const [agentConfig, setAgentConfig] = useState({})
  const [globalSearch, setGlobalSearch] = useState('')
  const [liveCall,    setLiveCall]   = useState(null)
  const [formCount,   setFormCount]  = useState(0)

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
      ;(data || []).forEach(r => { map[r.key] = r.value })
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
              <b>Live Call:</b> Incoming from {liveCall.from || 'anonymous'} ({liveCall.sid?.slice(0,8)}…)
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

          {!['prompt','settings'].includes(page) && (
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

        {page === 'dashboard'     && <PageDashboard     records={records} stats={stats} loading={loading} filter={filter} setFilter={setFilter} openTranscript={openTranscript} showToast={showToast} globalSearch={globalSearch} />}
        {page === 'leads'         && <PageLeads         records={records} loading={loading} openTranscript={openTranscript} showToast={showToast} fetchAll={fetchAll} agentConfig={agentConfig} globalSearch={globalSearch} />}
        {page === 'conversations' && <PageConversations records={records} loading={loading} openTranscript={openTranscript} globalSearch={globalSearch} />}
        {page === 'forms'         && <PageForms         showToast={showToast} globalSearch={globalSearch} setFormCount={setFormCount} />}
        {page === 'analytics'     && <PageAnalytics     records={records} stats={stats} loading={loading} />}
        {page === 'prompt'        && <PagePrompt        showToast={showToast} />}
        {page === 'settings'      && <PageSettings      showToast={showToast} onConfigChange={cfg => setAgentConfig(c => ({ ...c, ...cfg }))} />}
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