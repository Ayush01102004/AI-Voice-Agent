# Inbox Infotech — AI Outbound Voice Sales System

Full-stack AI voice sales platform: Deepgram Voice Agent + Plivo telephony for calling, FastAPI + Supabase for the backend/data layer, and a React/Vite dashboard for leads, conversations, analytics, agent profiles, and admin.

## Architecture

```
                     +-----------------------+
                     |    React Dashboard     |
                     |  (Vite, Supabase JS)   |
                     +-----------+-----------+
                                 |
              +------------------+------------------+
              |                                     |
   REST + realtime                             REST (place call)
              |                                     |
              v                                     v
      +---------------+                    +------------------+
      |   Supabase    |<-------writes------|    server.py      |
      |  (Postgres)   |                    | Deepgram Voice    |
      +-------^-------+                    | Agent <-> Plivo   |
              |                            | audio stream      |
              |    REST (leads, config,    | (aiohttp, WS)     |
              |     numbers, transcripts)  +---------+----------+
              |                                      |
      +-------+---------+                            |
      |  call_handler.py |<----live-call facts--------+
      |  FastAPI +       |    POST /api/call-live-facts
      |  Supabase        |
      |  webhooks, leads |                            |
      |  API, Plivo #s   |                            |
      +-------^----------+                            |
              |                                       |
     recording / stream-status              REST (calls.create,
        webhooks                                hangup)
              |                                       |
              +------------------+--------------------+
                                 |
                                 v
                         +---------------+
                         |  Plivo Voice  |
                         |      API      |
                         +---------------+
```

- **`server.py`** — holds the live call. Answers Plivo's Answer URL webhook, streams audio both ways over a WebSocket to Deepgram's Voice Agent API, runs AMD/ghost-call detection, and places outbound calls via the Plivo REST API.
- **`call_handler.py`** — the single DB writer. Receives Plivo's recording/stream-status webhooks, transcribes + extracts lead data, triggers n8n, and exposes the REST API the dashboard reads from (leads, stats, transcripts, recordings, agent config, Plivo number management).
- **Dashboard (`src/components/`)** — talks to Supabase directly for reads/realtime, and to `call_handler.py` / `server.py` for anything requiring server-side credentials (Plivo numbers, placing calls, config).

## Calling — Single & Batch

Both modes live on the **Agent Profiles** page (`PageAgentProfiles.jsx`).

### Single call
"Make a Call" button → phone number + agent dropdown → `POST {VITE_VOICE_SERVER_URL}/api/outbound-call` on `server.py`, which places the call via `plivo_client.calls.create` and returns a `dash_id` correlation token (Plivo's `request_uuid` isn't usable downstream, so `dash_id` bridges to the real Plivo `CallUUID` once `plivo_answer()` fires).

### Batch call
Logic lives in `batchCallStore.js` (module-level store — survives page nav mid-run), UI renders in `PageAgentProfiles.jsx`.

1. **Load numbers** — from a local Excel/CSV file, a live-editable local file (File System Access API, Chrome/Edge only), or a published-to-web Google Sheet CSV URL.
2. **Dial loop** — sequentially dials each row via `server.py`'s `/api/outbound-call`, then polls `call_handler.py`'s `GET /api/plivo/call-status?call_uuid=...` until a terminal hangup cause is reached (up to 25 attempts, 7s apart) before moving to the next row.
3. **Controls** — pause / stop / resume mid-batch.
4. **Write-back** — updates status/hangup-cause columns back into the open file (if using the File System Access picker) and/or exports a finished sheet at any time.

Phone numbers are normalized to E.164 via `toE164()` with a configurable default country code.

## Dashboard pages

| Page             | File                    | Purpose                                                                                              |
|------------------|-------------------------|------------------------------------------------------------------------------------------------------|
| Dashboard        | `PageDashboard.jsx`     | Metrics, calls-over-time, lead breakdown, sources, recent leads table + CSV export                   |
| Leads            | `PageLeads.jsx`         | Full lead table/actions                                                                              |
| Conversations    | `PageConversations.jsx` | Paginated call list + transcript viewer                                                              |
| Analytics        | `PageAnalytics.jsx`     | Weekly/monthly/yearly conversion, duration, day-of-week, lead score trend,etc.                       |
| Agent Profiles   | `PageAgentProfiles.jsx` | Agent config, single call, batch calling                                                             |
| Forms            | `PageForms.jsx`         | Google Form submissions, email sending                                                               |
| Settings         | `PageSettings.jsx`      | Admin login (SHA-256), config, embeds Admin Panel                                                    |
| Admin Panel      | `PageAdminPanel.jsx`    | Raw DB admin across Supabase tables (behind admin login)                                             |

Shared helpers/constants/sub-components: `dashboardShared.jsx`. Layout + realtime + nav shell: `Dashboard.jsx` / `Dashboard.module.css`.

## Backend endpoints

**`server.py`** (voice/streaming server)
```
POST /plivo/answer          Plivo Answer URL webhook → Record+Stream XML
GET  /ws/plivo               Plivo Audio Streaming WebSocket
POST /api/outbound-call      Place an outbound call
GET  /api/resolve-call-uuid  Resolve dash_id → real Plivo CallUUID
GET  /health  /ping
```

**`call_handler.py`** (API + webhook server)
```
POST /plivo/recording            Plivo recording webhook
POST /plivo/stream-status        Plivo stream-status webhook
GET  /api/leads
GET  /api/stats
GET  /api/transcript/{call_sid}
GET  /api/recording/{call_sid}
GET  /api/config
POST /api/config/refresh
GET  /api/agents
POST /api/agents
DELETE /api/agents/{agent_id}
PATCH  /api/agents/{agent_id}/toggle
GET  /api/agents/active-count
GET  /api/agents/active-ids
GET  /api/agent-for-number
GET  /api/number-for-agent
GET  /api/plivo/numbers          List rented Plivo numbers + owning agent
POST /api/plivo/link-number      Bind a number to an agent
POST /api/plivo/unlink-number
GET  /api/plivo/call-status      Poll a call's hangup cause (used by batch loop)
POST /api/send-form-email
POST /api/call-live-facts        server.py → live call facts/history
POST /api/call-transcript
GET  /health
```

## Setup

### Requirements
- Python 3.10+
- Node.js (for the Vite dashboard)
- A Plivo account (Auth ID/Token, a Voice Application, at least one rented number)
- A Supabase project
- Deepgram API key, Groq API key (lead extraction), Resend API key (form emails, optional)

### Install

```bash
pip install -r requirements.txt
```

Dashboard:
```bash
cd <dashboard-dir>
npm install
```

### Environment variables

**Backend** (`server.py` + `call_handler.py`, `.env`)
```
PLIVO_AUTH_ID=
PLIVO_AUTH_TOKEN=
PLIVO_APP_NAME=
PLIVO_ANSWER_URL=
DEEPGRAM_API_KEY=
GROQ_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
CALL_HANDLER_URL=
N8N_WEBHOOK_URL=
RESEND_API_KEY=
RESEND_FROM_EMAIL=
INTERNAL_API_KEY=
ALLOWED_ORIGINS=
LOG_LEVEL=
PORT=
```

**Dashboard** (`.env`, Vite)
```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_VOICE_SERVER_URL=      # server.py base URL, e.g. http://localhost:8080
VITE_CALL_HANDLER_URL=      # call_handler.py base URL, e.g. http://localhost:8000
VITE_API_BASE=              # used by PageForms.jsx
```

### Run

```bash
# voice/streaming server
python server.py

# API + webhook server
uvicorn call_handler:app --host 0.0.0.0 --port 8000 --reload --log-level warning --no-access-log

# dashboard
npm run dev
```

Point your Plivo Voice Application's Answer URL at `https://<server.py-host>/plivo/answer` (needs a public tunnel in local dev, e.g. ngrok) and set the recording/stream-status webhook URLs on `call_handler.py` accordingly.

## Notes

- `plivo_answer()` is the first point the real Plivo `CallUUID` exists — outbound-call responses and status polling use the `dash_id` correlation token until then.
- `call_handler.py` is the only service that writes to Supabase; `server.py` forwards live-call facts to it via `/api/call-live-facts` rather than writing directly.
- Batch calling and single calling both go through the same `/api/outbound-call` endpoint on `server.py`.
