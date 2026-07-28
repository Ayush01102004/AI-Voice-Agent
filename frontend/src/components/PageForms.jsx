// src/components/PageForms.jsx
// Forms page — Backend email send (Resend) + setup/library modals + sent-log tab.
// Kept as a single file (modals included) per "no further split" rule.
import { useEffect, useState, useMemo } from 'react'
import {
  Download, Send, Copy, CheckCircle, AlertCircle, Clock,
} from 'lucide-react'
import { supabase } from '../supabaseClient'
import styles from './Dashboard.module.css'
import { fmtDate, VisualEmptyState, Badge, exportCSV } from './dashboardShared'

const API_BASE = (typeof window !== 'undefined' && window.__API_BASE__)
  || import.meta.env.VITE_API_BASE
  || 'http://localhost:8000'

const inputStyle = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  border: '0.5px solid var(--border2)', background: 'var(--bg3)',
  color: 'var(--text1)', fontSize: 13, boxSizing: 'border-box',
  outline: 'none'
}
const labelStyle = { fontSize: 11, color: 'var(--text2)', marginBottom: 4, display: 'block' }

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

export default function PageForms({ showToast, globalSearch, setFormCount }) {
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
