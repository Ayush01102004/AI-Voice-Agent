// src/components/Dashboard.jsx
// Reads directly from Supabase `calls` table with realtime subscription.
// Also has manual refresh + filter by category.

import { useEffect, useState, useCallback } from 'react'
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import {
  Phone, TrendingUp, Flame, Users, RefreshCw,
  Eye, PhoneCall, MessageSquare, CheckCircle2,
  AlertCircle, Clock, Activity,
} from 'lucide-react'
import { supabase } from '../supabaseClient'
import styles from './Dashboard.module.css'

// ── constants ────────────────────────────────────────────────

const CATEGORY_COLOR = { HOT: '#ff6b4a', WARM: '#f5a623', COLD: '#5b9cf6' }
const SCORE_COLOR    = s => s >= 8 ? '#ff6b4a' : s >= 5 ? '#f5a623' : '#5b9cf6'
const PIE_COLORS     = ['#ff6b4a', '#f5a623', '#5b9cf6']

// ── helpers ───────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

function fmtDuration(sec) {
  if (!sec) return '—'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m ${s}s`
}

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
    HOT:  { label: 'HOT',  bg: 'var(--hot-bg)',  color: 'var(--hot)'  },
    WARM: { label: 'WARM', bg: 'var(--warm-bg)', color: 'var(--warm)' },
    COLD: { label: 'COLD', bg: 'var(--cold-bg)', color: 'var(--cold)' },
  }
  const c = map[category] || map.COLD
  return (
    <span style={{
      background: c.bg, color: c.color,
      fontSize: 10, fontWeight: 600, padding: '3px 9px',
      borderRadius: 20, letterSpacing: 0.5,
    }}>
      {c.label}
    </span>
  )
}

function MetricCard({ icon: Icon, label, value, sub, color }) {
  return (
    <div className={styles.metricCard}>
      <div className={styles.metricIcon} style={{ color: color || 'var(--accent)' }}>
        <Icon size={18} />
      </div>
      <div>
        <p className={styles.metricLabel}>{label}</p>
        <p className={styles.metricValue} style={{ color: color || 'var(--text1)' }}>{value}</p>
        {sub && <p className={styles.metricSub}>{sub}</p>}
      </div>
    </div>
  )
}

// ── custom tooltip ────────────────────────────────────────────

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: 'var(--bg3)', border: '0.5px solid var(--border2)',
      borderRadius: 8, padding: '8px 14px', fontSize: 12, color: 'var(--text1)',
    }}>
      <p style={{ color: 'var(--text2)', marginBottom: 4 }}>{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color }}>{p.name}: <b>{p.value}</b></p>
      ))}
    </div>
  )
}

// ── build chart data from raw records ─────────────────────────

function buildWeeklyData(records) {
  const map = {}
  records.forEach(r => {
    const d = r.created_at ? new Date(r.created_at) : new Date()
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

function buildPieData(hot, warm, cold) {
  return [
    { name: 'Hot',  value: hot,  pct: hot + warm + cold > 0 ? Math.round(hot  / (hot + warm + cold) * 100) : 0 },
    { name: 'Warm', value: warm, pct: hot + warm + cold > 0 ? Math.round(warm / (hot + warm + cold) * 100) : 0 },
    { name: 'Cold', value: cold, pct: hot + warm + cold > 0 ? Math.round(cold / (hot + warm + cold) * 100) : 0 },
  ]
}

// ── main component ────────────────────────────────────────────

export default function Dashboard() {
  const [records,   setRecords]   = useState([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState(null)
  const [filter,    setFilter]    = useState('ALL')
  const [selected,  setSelected]  = useState(null)   // transcript modal
  const [lastSync,  setLastSync]  = useState(null)

  // ── fetch all calls ────────────────────────────────────────

  const fetchRecords = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data, error: err } = await supabase
        .from('calls')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200)

      if (err) throw err
      setRecords(data || [])
      setLastSync(new Date())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  // ── realtime subscription ──────────────────────────────────

  useEffect(() => {
    fetchRecords()

    const channel = supabase
      .channel('calls-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'calls' }, () => {
        fetchRecords()
      })
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [fetchRecords])

  // ── derived stats ──────────────────────────────────────────

  const total    = records.length
  const hot      = records.filter(r => r.lead_category === 'HOT').length
  const warm     = records.filter(r => r.lead_category === 'WARM').length
  const cold     = records.filter(r => r.lead_category === 'COLD').length
  const avgScore = total ? (records.reduce((s, r) => s + (r.lead_score || 0), 0) / total).toFixed(1) : '0'
  const convRate = total ? Math.round(hot / total * 100) : 0

  const filteredRecords = filter === 'ALL'
    ? records
    : records.filter(r => r.lead_category === filter)

  const weeklyData = buildWeeklyData(records)
  const pieData    = buildPieData(hot, warm, cold)

  // ── transcript modal ───────────────────────────────────────

  async function openTranscript(callSid) {
    const { data } = await supabase
      .from('calls')
      .select('call_sid, transcript, extracted')
      .eq('call_sid', callSid)
      .single()
    setSelected(data)
  }

  // ── render ─────────────────────────────────────────────────

  return (
    <div className={styles.shell}>

      {/* sidebar */}
      <aside className={styles.sidebar}>
        <div className={styles.logo}>
          <Activity size={20} color="var(--accent)" />
          <span>Inbox Infotech</span>
        </div>
        <nav className={styles.nav}>
          {[
            { icon: Activity,     label: 'Dashboard'    },
            { icon: Users,        label: 'Leads'        },
            { icon: Phone,        label: 'Conversations'},
            { icon: TrendingUp,   label: 'Analytics'    },
          ].map(({ icon: Icon, label }) => (
            <button key={label} className={`${styles.navItem} ${label === 'Dashboard' ? styles.navActive : ''}`}>
              <Icon size={16} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </aside>

      {/* main */}
      <main className={styles.main}>

        {/* header */}
        <div className={styles.header}>
          <div>
            <h1 className={styles.pageTitle}>Sales dashboard</h1>
            <p className={styles.pageSub}>
              {lastSync ? `Last synced ${lastSync.toLocaleTimeString()}` : 'Loading…'}
            </p>
          </div>
          <button className={styles.refreshBtn} onClick={fetchRecords} disabled={loading}>
            <RefreshCw size={14} className={loading ? styles.spin : ''} />
            Refresh
          </button>
        </div>

        {error && (
          <div className={styles.errorBanner}>
            <AlertCircle size={14} /> {error}
          </div>
        )}

        {/* metric cards */}
        <div className={styles.metricsRow}>
          <MetricCard icon={Users}       label="Total leads"   value={total}       sub="all time" />
          <MetricCard icon={Flame}       label="Hot leads"     value={hot}         sub={`${Math.round(hot/Math.max(total,1)*100)}% of total`} color="var(--hot)" />
          <MetricCard icon={Phone}       label="Total calls"   value={total}       sub="processed" color="var(--accent)" />
          <MetricCard icon={TrendingUp}  label="Conversion"    value={`${convRate}%`} sub="hot / total" color="var(--green)" />
          <MetricCard icon={CheckCircle2} label="Avg score"    value={avgScore}    sub="out of 10" color="var(--warm)" />
        </div>

        {/* charts row */}
        <div className={styles.chartsRow}>

          {/* area chart */}
          <div className={styles.chartCard} style={{ gridColumn: 'span 2' }}>
            <h3 className={styles.chartTitle}>Calls over time</h3>
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={weeklyData} margin={{ top: 5, right: 10, bottom: 0, left: -20 }}>
                <defs>
                  <linearGradient id="gHot"  x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stopColor="#ff6b4a" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#ff6b4a" stopOpacity={0}   />
                  </linearGradient>
                  <linearGradient id="gWarm" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stopColor="#f5a623" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#f5a623" stopOpacity={0}   />
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

          {/* pie chart */}
          <div className={styles.chartCard}>
            <h3 className={styles.chartTitle}>Lead breakdown</h3>
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={pieData} cx="50%" cy="50%" innerRadius={55} outerRadius={80}
                  dataKey="value" paddingAngle={3}>
                  {pieData.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i]} />
                  ))}
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
        </div>

        {/* score bar chart */}
        <div className={styles.chartCard} style={{ marginBottom: '1.5rem' }}>
          <h3 className={styles.chartTitle}>Score distribution</h3>
          <ResponsiveContainer width="100%" height={140}>
            <BarChart
              data={Array.from({ length: 10 }, (_, i) => ({
                score: i + 1,
                count: records.filter(r => r.lead_score === i + 1).length,
              }))}
              margin={{ top: 5, right: 10, bottom: 0, left: -20 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="score" tick={{ fill: 'var(--text2)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: 'var(--text2)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="count" name="Leads" radius={[4, 4, 0, 0]}>
                {Array.from({ length: 10 }, (_, i) => (
                  <Cell key={i} fill={SCORE_COLOR(i + 1)} fillOpacity={0.85} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* leads table */}
        <div className={styles.tableCard}>
          <div className={styles.tableHeader}>
            <h3 className={styles.chartTitle} style={{ margin: 0 }}>Recent leads</h3>
            <div className={styles.filters}>
              {['ALL', 'HOT', 'WARM', 'COLD'].map(f => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`${styles.filterBtn} ${filter === f ? styles.filterActive : ''}`}
                  style={filter === f && f !== 'ALL' ? { color: CATEGORY_COLOR[f] } : {}}
                >
                  {f}
                </button>
              ))}
            </div>
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
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className={styles.emptyRow}>Loading…</td></tr>
                ) : filteredRecords.length === 0 ? (
                  <tr><td colSpan={7} className={styles.emptyRow}>No records found</td></tr>
                ) : filteredRecords.map(r => {
                  const ext = r.extracted || {}
                  return (
                    <tr key={r.call_sid} className={styles.tableRow}>
                      <td className={styles.mono}>{r.to_number || '—'}</td>
                      <td><Badge category={r.lead_category} /></td>
                      <td><StarScore score={r.lead_score || 1} /></td>
                      <td style={{ color: 'var(--text2)' }}>{fmtDuration(r.duration_sec)}</td>
                      <td className={styles.summaryCell}>{ext.summary || '—'}</td>
                      <td style={{ color: 'var(--text2)', whiteSpace: 'nowrap' }}>{fmtDate(r.created_at)}</td>
                      <td>
                        <div className={styles.actions}>
                          <button
                            className={styles.iconBtn}
                            title="View transcript"
                            onClick={() => openTranscript(r.call_sid)}
                          >
                            <Eye size={14} />
                          </button>
                          <button className={styles.iconBtn} title="Call">
                            <PhoneCall size={14} />
                          </button>
                          <button className={styles.iconBtn} title="Message">
                            <MessageSquare size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className={styles.tableFooter}>
            Showing {filteredRecords.length} of {total} records
          </p>
        </div>
      </main>

      {/* transcript modal */}
      {selected && (
        <div className={styles.modalOverlay} onClick={() => setSelected(null)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3>Transcript — <span className={styles.mono}>{selected.call_sid}</span></h3>
              <button className={styles.iconBtn} onClick={() => setSelected(null)}>✕</button>
            </div>

            {selected.extracted?.summary && (
              <div className={styles.summaryBox}>
                <p className={styles.summaryLabel}>AI Summary</p>
                <p>{selected.extracted.summary}</p>
              </div>
            )}

            <div className={styles.transcriptBody}>
              {(selected.transcript || '').split('\n').filter(Boolean).map((line, i) => {
                const [speaker, ...rest] = line.split(':')
                const isAgent = speaker?.trim() === 'Agent'
                return (
                  <div key={i} className={`${styles.bubble} ${isAgent ? styles.bubbleAgent : styles.bubbleCustomer}`}>
                    <span className={styles.bubbleLabel}>{speaker?.trim()}</span>
                    <p>{rest.join(':').trim()}</p>
                  </div>
                )
              })}
              {!selected.transcript && (
                <p style={{ color: 'var(--text2)', textAlign: 'center', padding: '2rem' }}>No transcript available</p>
              )}
            </div>

            {selected.extracted?.next_action && (
              <div className={styles.nextAction}>
                <Clock size={13} />
                Next: {selected.extracted.next_action}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}