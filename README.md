# Inbox Infotech — AI Voice Sales Agent

Production-ready AI voice sales agent with real-time telephony, automated lead extraction, and a live dashboard.

---

## Architecture

```
Outbound Call
     │
     ▼
Telnyx (PSTN)
     │  POST /telnyx/voice      →  TeXML (<Stream>)
     │  wss://.../ws/telnyx     →  Media Streams (mulaw 8kHz)
     ▼
voice_agent.py  (aiohttp, port 5002)
     │  Deepgram Voice Agent SDK (WebSocket)
     │  ← audio in / audio out (mulaw 8kHz)
     │  ← ConversationText, FunctionCallRequest
     │
     │  GET http://localhost:8000/api/config  →  live system prompt + lead_name
     ▼
call_handler.py  (FastAPI, port 8000)
     │  POST /telnyx-webhook    ←  Telnyx call.completed / call.recording.saved
     │  Deepgram REST API       →  transcription (nova-3, diarized)
     │  Groq llama-3.3-70b      →  lead extraction (JSON)
     │  Supabase                →  persist calls, lead_notes, agent_config
     │  N8N webhook             →  HOT lead automation
     ▼
React Dashboard  (Vite, port 5173)
     Supabase JS client  →  reads all tables directly
     Pages: Overview · Leads · Calls · Settings · Admin DB Panel
```

---

## Repository Structure

```
/
├── backend/
│   ├── voice_agent.py      # Deepgram Voice Agent + Telnyx WebSocket bridge
│   ├── call_handler.py     # FastAPI: webhooks, transcription, extraction, storage
│   └── requirements.txt
├── frontend/
│   └── src/
│       └── components/
│           ├── Dashboard.jsx
│           ├── PageSettings.jsx
│           └── PageAdminPanel.jsx
└── .env
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Telephony | Telnyx Media Streams (mulaw 8 kHz) |
| Voice Agent | Deepgram Voice Agent SDK v5+ · STT: nova-3 · TTS: aura-2-helena-en · LLM: gpt-4o-mini |
| Transcription | Deepgram REST API (nova-3, diarized) |
| Lead Extraction | Groq `llama-3.3-70b-versatile` |
| Backend | FastAPI + aiohttp |
| Database | Supabase (PostgreSQL) |
| Automation | N8N webhook |
| Frontend | React + Vite + Supabase JS |

---

## Environment Variables

```env
# Deepgram
DEEPGRAM_API_KEY=

# Groq
GROQ_API_KEY=

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=

# Telnyx
TELNYX_API_KEY=
TELNYX_PUBLIC_KEY=           # Ed25519 public key for webhook signature verification

# N8N
N8N_WEBHOOK_URL=

# Internal wiring (defaults work for same-machine dev)
CALL_HANDLER_URL=http://localhost:8000
PORT=5002

# Optional: per-campaign lead name (overrides agent_config table)
LEAD_NAME=
```

---

## Supabase Schema

```sql
create table agent_config (
  key        text primary key,
  value      text not null default '',
  updated_at timestamptz not null default now()
);

create table calls (
  id               uuid primary key default gen_random_uuid(),
  call_sid         text unique not null,
  from_number      text,
  to_number        text,
  duration_sec     int default 0,
  transcript       text,
  lead_category    text default 'COLD',
  lead_score       int default 1,
  extracted        jsonb,
  recording_url    text,
  source           text default 'Unknown',
  name             text default '',
  company          text default '',
  last_contacted_at timestamptz,
  created_at       timestamptz not null default now()
);

create table lead_notes (
  id         uuid primary key default gen_random_uuid(),
  call_sid   text references calls(call_sid) on delete cascade,
  note       text not null,
  author     text default 'Admin',
  created_at timestamptz not null default now()
);

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

create table prompt_versions (
  id            uuid primary key default gen_random_uuid(),
  prompt_key    text not null,
  prompt_value  text not null,
  rollback_note text,
  created_at    timestamptz not null default now()
);
```

Seed defaults:

```sql
insert into agent_config (key, value) values
  ('system_prompt', 'You are Ella, a friendly sales caller from Inbox Infotech...'),
  ('agent_name',    'Ella')
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
deepgram-sdk>=5.0.0
aiohttp>=3.9
python-dotenv>=1.0
fastapi
uvicorn
httpx
groq
supabase==2.4.2
cryptography
```

### Start call_handler (port 8000)

```bash
uvicorn call_handler:app --host 0.0.0.0 --port 8000 --reload
```

| Method | Path | Purpose |
|---|---|---|
| POST | `/telnyx-webhook` | Telnyx `call.completed` / `call.recording.saved` |
| GET | `/api/leads` | Paginated lead list |
| GET | `/api/stats` | Aggregate stats |
| GET | `/api/transcript/{call_sid}` | Parsed diarized transcript |
| GET | `/api/config` | Live agent config for voice_agent.py |
| POST | `/api/config/refresh` | Force-bust 5-min config cache |
| GET | `/health` | Health check + DB connectivity |

### Start voice_agent (port 5002)

```bash
python voice_agent.py
```

| Method | Path | Purpose |
|---|---|---|
| POST | `/telnyx/voice` | Telnyx webhook — returns TeXML `<Stream>` |
| GET | `/ws/telnyx` | Telnyx Media Streams WebSocket |
| GET | `/health` | Health check + prompt loaded |
| GET | `/ping` | Liveness probe |

### Expose publicly (development)

```bash
ngrok http 5002   # voice_agent
ngrok http 8000   # call_handler (separate terminal)
```

---

## Telnyx Configuration

1. **Voice webhook** (HTTP POST): `https://<voice-agent-host>/telnyx/voice`
2. **Webhook events** on call_handler: `https://<call-handler-host>/telnyx-webhook`
   - Enable events: `call.completed`, `call.recording.saved`
3. Set **TELNYX_PUBLIC_KEY** in `.env` to enable Ed25519 webhook signature verification (recommended for production).
4. Enable **call recording** in your Telnyx connection profile.

---

## Call Flow

1. Telnyx triggers outbound call → POSTs to `/telnyx/voice` → returns TeXML `<Stream>`.
2. Telnyx opens WebSocket to `/ws/telnyx`, streams mulaw audio.
3. `voice_agent.py` fetches live config from `call_handler /api/config`.
4. Deepgram Voice Agent handles STT → LLM (gpt-4o-mini) → TTS in real time.
5. Agent audio streams back through `voice_agent.py` → Telnyx → caller.
6. On `end_conversation` function call: WebSocket closes, Telnyx hangs up.
7. Telnyx POSTs `call.recording.saved` or `call.completed` to `/telnyx-webhook`.
8. `call_handler` downloads recording → Deepgram transcription → Groq extraction → Supabase upsert.
9. `lead_category == HOT` → N8N webhook fires.
10. Dashboard reflects new data in real time via Supabase JS.

---

## Agent Configuration (Live Editing)

- Edit `system_prompt` and `agent_name` in the Settings page (admin login required) or via Admin DB Panel.
- `call_handler` caches config for 5 minutes. Bust immediately: `POST /api/config/refresh`.
- `voice_agent.py` fetches config at call start — no restart required.
- Set `lead_name` in `agent_config` table (or `LEAD_NAME` env var) to personalise greeting and recovery memory per campaign.
- Fallback: if `call_handler` is unreachable, `voice_agent.py` uses built-in default prompt.

---

## Lead Scoring

Groq scores every completed call:

| Category | Score | Criteria |
|---|---|---|
| HOT | 8–10 | Clear interest + budget + decision maker + urgency |
| WARM | 4–7 | Interested but vague on budget/timeline, or not decision maker |
| COLD | 1–3 | No interest, declined, wrong number, voicemail, hung up |

Extracted fields saved to `calls.extracted` (jsonb): `name`, `company`, `pain_points`, `budget`, `requirements`, `timeline`, `decision_maker`, `industry`, `intent_level`, `lead_score`, `lead_category`, `summary`, `next_action`, `interested_services`.

---

## Dashboard

| Page | Description |
|---|---|
| Overview | Stats cards, lead category chart, top sources, recent activity |
| Leads | Lead table with filters, score badge, transcript modal |
| Calls | Raw call records, recording playback |
| Settings | Agent config, integrations, admin panel access |

**Admin Panel** (admin login required): full inline DB editor for all 5 tables — edit, insert, delete, search, paginate, CSV export. Session persists via `sessionStorage`.

---

## Integrations

| Service | `agent_config` key | Purpose |
|---|---|---|
| Slack | `conn_slack` | HOT lead channel alerts |
| Microsoft Teams | `conn_teams` | HOT lead channel alerts |
| Calendly | `conn_calendly` | Booking link for qualified leads |
| Email | `conn_email` | New lead notifications |
| N8N | `N8N_WEBHOOK_URL` env | Full automation on HOT lead |

---

## Production Notes

- Deploy `voice_agent.py` and `call_handler.py` as separate services (Railway, Render, EC2, Docker).
- Set `CALL_HANDLER_URL` to `call_handler`'s public URL.
- Both services require public HTTPS endpoints for Telnyx webhooks.
- `SUPABASE_SERVICE_ROLE_KEY` is backend-only — never expose to frontend.
- Set Supabase RLS policies before exposing the anon key in the frontend.
- Use a process manager (systemd, supervisord, or Docker) — both services must stay running.