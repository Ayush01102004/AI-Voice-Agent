# Inbox Infotech — AI Voice Sales Agent Dashboard

A production-ready AI voice sales agent system with a full-stack dashboard. Twilio handles telephony, Deepgram powers real-time STT + TTS + agent reasoning, Groq extracts lead insights, and a React + Supabase dashboard gives you live visibility into every call.

---

## Architecture Overview

```
Incoming Call
     │
     ▼
Twilio (PSTN)
     │  POST /twilio/voice  →  TwiML (<Stream>)
     │  wss://.../ws/twilio →  Media Streams (mulaw 8kHz)
     ▼
server.py  (aiohttp, port 5002)
     │  Deepgram Voice Agent SDK (WebSocket)
     │  ← audio in / audio out (mulaw)
     │  ← ConversationText, FunctionCallRequest
     │
     │  GET http://localhost:8000/api/config  →  live system prompt
     ▼
call_handler.py  (FastAPI, port 8000)
     │  POST /twilio-webhook  ←  Twilio status callback (call completed)
     │  Deepgram REST API  →  transcription (nova-3, diarized)
     │  Groq llama-3.3-70b  →  lead extraction (JSON)
     │  Supabase  →  persist calls, lead_notes, agent_config
     │  N8N hot lead webhook  →  HOT lead automation
     ▼
React Dashboard  (Vite, port 5173)
     │  Supabase JS client  →  reads all tables directly
     │  Pages: Overview, Leads, Calls, Settings (+ Admin DB Panel)
```

---

## Repository Structure

```
/
├── backend/
│   ├── server.py           # Deepgram Voice Agent + Twilio WebSocket bridge
│   ├── call_handler.py     # FastAPI: webhooks, transcription, extraction, storage
│   └── requirements.txt
├── frontend/
│   └── src/
│       └── components/
│           ├── Dashboard.jsx         # Root layout + page routing
│           ├── PageSettings.jsx      # Settings + admin login
│           └── PageAdminPanel.jsx    # Embedded DB admin UI (admin-only)
└── .env                    # See Environment Variables section
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Telephony | Twilio Media Streams (mulaw 8 kHz) |
| Voice Agent | Deepgram Voice Agent SDK v5+ (STT: nova-3, TTS: aura-2-helena-en, LLM: gpt-4o-mini) |
| Transcription | Deepgram REST API (nova-3, diarized, punctuated) |
| Lead Extraction | Groq `llama-3.3-70b-versatile` |
| Backend Framework | FastAPI + aiohttp |
| Database | Supabase (PostgreSQL) |
| Automation | N8N webhook (HOT lead trigger) |
| Frontend | React + Vite |
| Frontend DB Client | Supabase JS |
| Icons | Lucide React |

---

## Environment Variables

Create a `.env` file in the project root:

```env
# Deepgram
DEEPGRAM_API_KEY=your_deepgram_api_key

# Groq
GROQ_API_KEY=your_groq_api_key

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# Twilio (used by Make.com / outbound trigger)
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_FROM_NUMBER=+1xxxxxxxxxx

# N8N
N8N_WEBHOOK_URL=https://hook.make.com/your-webhook-id

# Internal service wiring (default works for same-machine dev)
CALL_HANDLER_URL=http://localhost:8000
```

---

## Supabase Schema

Run these in the Supabase SQL editor:

```sql
-- Agent configuration (system prompt, connections, etc.)
create table agent_config (
  key         text primary key,
  value       text not null default '',
  updated_at  timestamptz not null default now()
);

-- Call records
create table calls (
  id                uuid primary key default gen_random_uuid(),
  call_sid          text unique not null,
  from_number       text,
  to_number         text,
  duration_sec      int default 0,
  transcript        text,
  lead_category     text default 'COLD',
  lead_score        int default 1,
  extracted         jsonb,
  recording_url     text,
  source            text default 'Unknown',
  name              text default '',
  last_contacted_at timestamptz,
  created_at        timestamptz not null default now()
);

-- Lead notes (added from dashboard)
create table lead_notes (
  id        uuid primary key default gen_random_uuid(),
  call_sid  text references calls(call_sid) on delete cascade,
  note      text not null,
  author    text default 'Admin',
  created_at timestamptz not null default now()
);

-- Web form submissions
create table form_submissions (
  id                   uuid primary key default gen_random_uuid(),
  name                 text,
  to_number            text,
  email                text,
  service_requirements text,
  budget               text,
  timeline             text,
  submitted_at         timestamptz not null default now()
);

-- Prompt version history
create table prompt_versions (
  id            uuid primary key default gen_random_uuid(),
  prompt_key    text not null,
  prompt_value  text not null,
  rollback_note text,
  created_at    timestamptz not null default now()
);
```

Seed the default system prompt:

```sql
insert into agent_config (key, value) values
  ('system_prompt', 'You are Alex, a friendly sales caller from Inbox Infotech...'),
  ('agent_name', 'Alex')
on conflict (key) do nothing;
```

---

## Backend Setup

```bash
cd backend
pip install -r requirements.txt
```

**requirements.txt**
```
deepgram-sdk>=3.0.0
websockets>=12.0
python-dotenv>=1.0.0
fastapi
uvicorn
httpx
openai
aiohttp
groq
twilio
supabase==2.4.2
```

### Start call_handler (FastAPI)

```bash
uvicorn call_handler:app --host 0.0.0.0 --port 8000 --reload
```

Endpoints:

| Method | Path | Purpose |
|---|---|---|
| POST | `/twilio-webhook` | Twilio status callback (call completed) |
| GET | `/api/leads` | Paginated lead list with extraction data |
| GET | `/api/stats` | Aggregate stats (total, HOT/WARM/COLD, avg score) |
| GET | `/api/transcript/{call_sid}` | Parsed diarized transcript |
| GET | `/api/config` | Live agent config for server.py |
| POST | `/api/config/refresh` | Force-bust 5-min config cache |
| GET | `/health` | Health check + DB connectivity |

### Start server.py (Deepgram Voice Agent)

```bash
python server.py
```

Endpoints:

| Method | Path | Purpose |
|---|---|---|
| POST | `/twilio/voice` | Twilio webhook — returns TwiML `<Stream>` |
| GET | `/ws/twilio` | Twilio Media Streams WebSocket |
| GET | `/health` | Health check + prompt loaded status |

### Expose to Twilio (development)

```bash
ngrok http 5002
```

Set Twilio webhook:
- Voice URL: `https://your-ngrok-id.ngrok.io/twilio/voice`  (HTTP POST)
- Status Callback: `https://your-ngrok-id.ngrok.io/twilio-webhook` on `call_handler` port 8000

For production, deploy both services and point Twilio to their public URLs.

---

## Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

Create `frontend/.env`:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your_anon_key
```

### Pages

| Page | Description |
|---|---|
| Overview | Stats cards, lead category chart, top sources, recent activity |
| Leads | Full lead table with filters, lead score badge, transcript modal |
| Calls | Raw call records, recording playback links |
| Settings | General config, integrations (Teams/Slack/Calendly/Email), admin panel |

### Admin Panel (`PageAdminPanel`)

Accessible only after admin login in Settings. Provides a full embedded database editor:

- Table selector for all 5 Supabase tables
- Inline cell editing (click to edit, Enter to save, Escape to cancel)
- JSONB columns: textarea with JSON validation before save
- Insert row form with type-aware inputs (text / number / jsonb)
- Delete with inline confirmation step
- Client-side search across all string columns
- Pagination at 20 rows/page
- CSV export of current filtered view
- Read-only enforcement on `id`, `created_at`, `updated_at`, `submitted_at`

Admin session persists across page navigation via `sessionStorage` — cleared on tab close.

---

## Call Flow (End to End)

1. **Outbound or inbound call** hits Twilio.
2. Twilio POSTs to `server.py /twilio/voice` → receives TwiML `<Stream>`.
3. Twilio opens WebSocket to `server.py /ws/twilio`, streams mulaw audio.
4. `server.py` fetches live system prompt from `call_handler /api/config`.
5. `server.py` opens Deepgram Voice Agent connection, sends `Settings` (prompt, audio config, greeting, functions).
6. Deepgram handles STT → LLM (gpt-4o-mini) → TTS in real time.
7. Agent audio (mulaw) streams back through `server.py` to Twilio → caller.
8. On `FunctionCallRequest` for `end_conversation`: agent responds, WebSocket closes, Twilio hangs up.
9. Twilio POSTs status callback to `call_handler /twilio-webhook` once call completes.
10. `call_handler` downloads recording → Deepgram transcription (diarized) → Groq extraction → Supabase upsert.
11. If `lead_category == HOT`, Make.com webhook fires for downstream automation.
12. Dashboard reflects new call data in real time via Supabase JS client.

---

## Agent Configuration (Live Editing)

The system prompt and agent name are stored in `agent_config` and loaded fresh per call:

- Edit `system_prompt` in the dashboard Settings page (admin login required) or via the Admin DB Panel.
- `call_handler` caches config for 5 minutes (`_CONFIG_TTL = 300`). Hit `POST /api/config/refresh` to bust immediately.
- `server.py` fetches from `call_handler /api/config` at call start — no restart needed.
- If `call_handler` is unreachable, `server.py` falls back to `_DEFAULT_SYSTEM_PROMPT`.

---

## Lead Scoring

Groq `llama-3.3-70b-versatile` scores every call:

| Category | Score | Criteria |
|---|---|---|
| HOT | 8–10 | Clear interest + budget indicator + decision maker + urgency |
| WARM | 4–7 | Interested but vague on budget/timeline, or not decision maker |
| COLD | 1–3 | No interest, declined, hung up, wrong number, voicemail |

Extracted fields saved to `calls.extracted` (jsonb): `name`, `pain_points`, `budget`, `requirements`, `timeline`, `decision_maker`, `industry`, `intent_level`, `summary`, `next_action`, `interested_services`.

---

## Integrations

| Service | Config key in `agent_config` | Purpose |
|---|---|---|
| Slack | `conn_slack` | HOT lead alerts to Slack channel |
| Microsoft Teams | `conn_teams` | HOT lead alerts to Teams channel |
| Calendly | `conn_calendly` | Booking link sent to qualified leads |
| Email | `conn_email` | Notification email for new leads |
| N8N | `N8N_WEBHOOK_URL` env var | Full automation workflow on HOT lead |

---

## Production Deployment Notes

- Deploy `call_handler.py` and `server.py` as separate services (Railway, Render, EC2, etc.).
- Set `CALL_HANDLER_URL` in `server.py`'s env to the public URL of `call_handler`.
- Use a process manager (systemd, supervisord, or Docker) — both services must stay up.
- Twilio requires a publicly accessible HTTPS URL for both webhooks.
- Set Supabase RLS policies appropriately if exposing the anon key in the frontend.
- `SUPABASE_SERVICE_ROLE_KEY` is backend-only — never expose it to the frontend.