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
     hangup / stream-status                 REST (calls.create,
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
- **`call_handler.py`** — the single DB writer. Receives Plivo's hangup/stream-status webhooks, transcribes + extracts lead data, and exposes the REST API the dashboard reads from (agent config, campaigns/batch-calling, Plivo number management).
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
|------------------|-------------------------|--------------------------------------------------------------------------------------------------------|
| Dashboard        | `PageDashboard.jsx`     | Metrics, calls-over-time, lead breakdown, sources, recent leads table + CSV export                   |
| Leads            | `PageLeads.jsx`         | Full lead table/actions                                                                              |
| Conversations    | `PageConversations.jsx` | Paginated call list + transcript viewer                                                              |
| Analytics        | `PageAnalytics.jsx`     | Weekly/monthly/yearly conversion, duration, day-of-week, lead score trend, etc.                      |
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
GET  /metrics                 Process-lifetime barge-in metrics snapshot (JSON, on-demand)
```

**`call_handler.py`** (API + webhook server)
```
POST /plivo/hangup                      Plivo hangup webhook — final CDR; updates calls + campaign call_attempts
POST /plivo/stream-status                Plivo stream-status webhook
GET  /api/config                         Agent config (?agent_id=)
PATCH  /api/agents/{agent_id}/toggle
GET  /api/agents/active-count
GET  /api/agent-for-number
GET  /api/number-for-agent
GET  /api/plivo/numbers                  List rented Plivo numbers + owning agent
POST /api/plivo/link-number              Bind a number to an agent
POST /api/plivo/unlink-number
GET  /api/plivo/call-status              Poll a call's hangup cause (used by batch loop)
POST /api/send-form-email
POST /api/call-live-facts                server.py → live call facts/history
POST /api/call-transcript
POST /api/campaigns                      Create a batch-calling campaign
GET  /api/campaigns                      List campaigns (?agent_id=&limit=)
DELETE /api/campaigns/{campaign_id}
GET  /api/campaigns/{campaign_id}/leads
POST /api/campaigns/{campaign_id}/dial/{lead_id}     Atomically claim + dial one lead
PATCH  /api/campaigns/attempts/{attempt_id}
POST /api/campaigns/{campaign_id}/reconcile          Recover stale/stuck attempts
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
GROQ_MODEL=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
CALL_HANDLER_URL=
RESEND_API_KEY=
RESEND_FROM_EMAIL=
INTERNAL_API_KEY=
ALLOWED_ORIGINS=
LOG_LEVEL=            # default WARNING in production — see Logging below
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

### Run (local dev)

```bash
# voice/streaming server
python server.py

# API + webhook server
uvicorn call_handler:app --host 0.0.0.0 --port 8000 --reload --log-level warning --no-access-log

# dashboard
npm run dev
```

Point your Plivo Voice Application's Answer URL at `https://<server.py-host>/plivo/answer` (needs a public tunnel in local dev, e.g. ngrok) and set the hangup/stream-status webhook URLs on `call_handler.py` accordingly.

## Production deployment (Railway)

Both backend services (`server.py` and `call_handler.py`) are Railway-ready as of this commit — deploy each as its own Railway service, pointed at the same repo/subfolder, with its own start command:

```bash
# server.py service
python server.py

# call_handler.py service
uvicorn call_handler:app --host 0.0.0.0 --port $PORT --log-level warning --no-access-log
```

Set `PORT` from Railway's injected env var (`server.py` already reads `PORT` via `server_app/config.py`; the `call_handler.py` start command should pass `--port $PORT` explicitly). Set the rest of the backend env vars listed above in each service's Railway variables.

### Logging

Production logging defaults to **`WARNING`** — routine per-call tracing, per-request/connection noise, and periodic summary logging are suppressed by default so Railway logs stay signal-only. Override with `LOG_LEVEL=INFO` or `LOG_LEVEL=DEBUG` on either service when you need verbose tracing for debugging.

**Always shown (`WARNING` / `ERROR`, no override needed):**
- `server started on port %d` / `server stopped` — `server.py`
- `call_handler started` / `call_handler stopped` — `call_handler.py`
- `Supabase client initialised`
- Plivo signature missing/verify-failure warnings, non-JSON WS message warnings, WS loop exceptions
- Outbound call create failures, agent-config/phone-map fetch failures, Supabase retry-exhausted errors

**Suppressed by default — set `LOG_LEVEL=INFO` to see:**
- Per-call lifecycle tracing (`clog()` in `session.py`) — answer webhook, call started/cleanup, TTS/STT reconnects, barge-in events, hangup, across `audio.py`, `tts_bridge.py`, `stt_bridge.py`, `llm_bridge.py`, `routes.py`, `call_handler_client.py`
- `call_outcome` structured JSON lines (`session.py`)
- `barge_in_metric` per-event structured JSON lines (`metrics.py`)
- `Lead extracted`, campaign stale-recovery notices (`call_handler_app/lead_extraction.py`, `campaigns.py`)
- Supabase transient-retry, hangup-webhook, and stream-status debug lines

**Removed in this commit (not just suppressed):**
- The 5-minute `barge_in_metrics_summary` background logging loop and its startup call — `/metrics` remains available on-demand, it just no longer logs itself automatically every 5 minutes
- The server-startup route-dump log listing every registered route
- The per-connection `WS connected — agent_id=... call_uuid=...` log line

No functional endpoints, Plivo webhooks, WebSocket behavior, batch calling, AI voice logic, or error handling were changed — this commit is logging/observability only.

## Database schema (Supabase)

The base schema (`final_schema.sql` — `agents`, `calls`, `agent_config`, `agent_numbers`, etc.) provisions the core tables everything above reads/writes. Batch calling's durable state lives in a second, additive migration, **`schema_campaigns.sql`**, which must be run against the same Supabase project or `call_handler_app/campaigns.py` will 500 on every request:

```sql
-- ============================================================
-- schema_campaigns.sql — batch-calling durable state.
-- Idempotent: safe to re-run. Required by
-- backend/call_handler_app/campaigns.py — that file will 500 on
-- every request until this has been run, because none of these
-- tables/constraints exist in final_schema.sql.
--
-- The idempotency_key UNIQUE constraint is NOT optional — it is the
-- entire mechanism the duplicate-call fix in dial_lead() relies on
-- (upsert(..., on_conflict="idempotency_key", ignore_duplicates=True)
-- only works because Postgres enforces this constraint atomically).
-- Without it, dial_lead() will error at runtime, not silently misbehave.
-- ============================================================

-- gen_random_uuid() needs pgcrypto — final_schema.sql never enables it
-- (agents.agent_id is text, not uuid, so nothing already turned this on).
create extension if not exists pgcrypto;

-- ── campaigns ────────────────────────────────────────────────
create table if not exists public.campaigns (
  campaign_id uuid primary key default gen_random_uuid(),
  agent_id text not null references public.agents (agent_id) on delete cascade,
  file_name text,
  total_leads integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_campaigns_agent_id on public.campaigns (agent_id);
create index if not exists idx_campaigns_created_at on public.campaigns (created_at desc);

-- ── campaign_leads ───────────────────────────────────────────
create table if not exists public.campaign_leads (
  lead_id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (campaign_id) on delete cascade,
  row_index integer not null,
  phone text not null,
  name text,
  raw_row jsonb not null default '{}'::jsonb,
  status text not null default 'PENDING',
  created_at timestamptz not null default now()
);

create index if not exists idx_campaign_leads_campaign_id on public.campaign_leads (campaign_id);
create index if not exists idx_campaign_leads_status on public.campaign_leads (status);

-- ── call_attempts ────────────────────────────────────────────
-- started_at DEFAULTS TO now() AT INSERT — this is load-bearing.
-- campaigns.py's reconcile/stale-recovery logic computes attempt age
-- from started_at and never sets it explicitly anywhere in the app
-- code, so if this default is missing, every attempt's age reads as
-- "unknown," stale recovery silently never fires, and QUEUED rows with
-- no call_uuid can get stuck forever again — the exact bug being fixed.
create table if not exists public.call_attempts (
  attempt_id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.campaign_leads (lead_id) on delete cascade,
  campaign_id uuid not null references public.campaigns (campaign_id) on delete cascade,
  attempt_number integer not null,
  idempotency_key text not null,
  business_status text not null default 'QUEUED',
  call_uuid text,
  provider_status text,
  hangup_cause text,
  failure_reason text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

-- THE constraint dial_lead()'s atomic claim depends on. Without this,
-- on_conflict="idempotency_key" has nothing to match and Postgres
-- raises an error on every upsert call.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'call_attempts_idempotency_key_key' and conrelid = 'public.call_attempts'::regclass
  ) then
    alter table public.call_attempts add constraint call_attempts_idempotency_key_key unique (idempotency_key);
  end if;
end $$;

create index if not exists idx_call_attempts_lead_id on public.call_attempts (lead_id);
create index if not exists idx_call_attempts_campaign_id on public.call_attempts (campaign_id);
create index if not exists idx_call_attempts_call_uuid on public.call_attempts (call_uuid);
create index if not exists idx_call_attempts_business_status on public.call_attempts (business_status);

-- ── Realtime — batchCallStore.js's waitForOutcome() subscribes to
-- postgres_changes on this table. Without this, the Realtime half of
-- the fix (item 5) never fires anything and every call silently falls
-- back to the 30s-then-final-DB-check path — degraded, not broken,
-- but worth confirming this actually ran.
-- Guarded manually (not "ADD TABLE IF NOT EXISTS") for compatibility
-- with Postgres <15 — Supabase's SQL editor runs a pasted script as
-- one implicit transaction, so an unguarded failure here would roll
-- back every table/constraint created above it in the same run too.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'call_attempts'
  ) then
    alter publication supabase_realtime add table public.call_attempts;
  end if;
end $$;
```

**Tables it adds:**

| Table            | Key columns                                                                 | Purpose                                                                 |
|-------------------|------------------------------------------------------------------------------|--------------------------------------------------------------------------|
| `campaigns`        | `campaign_id` (PK), `agent_id` (FK → `agents`), `file_name`, `total_leads`  | One row per batch-calling run                                          |
| `campaign_leads`   | `lead_id` (PK), `campaign_id` (FK), `row_index`, `phone`, `raw_row` (jsonb), `status` | One row per uploaded lead in a campaign                                |
| `call_attempts`    | `attempt_id` (PK), `lead_id` (FK), `campaign_id` (FK), `idempotency_key` (unique), `business_status`, `call_uuid`, `hangup_cause`, `started_at` | One row per dial attempt against a lead; drives dedupe, stale-attempt recovery, and the batch UI's realtime status via `call_attempts_idempotency_key_key` and the `supabase_realtime` publication |

Run it once per Supabase project, after `final_schema.sql` — it's idempotent (`create table if not exists`, guarded `do $$` blocks), so re-running it is safe.

## Notes

- `plivo_answer()` is the first point the real Plivo `CallUUID` exists — outbound-call responses and status polling use the `dash_id` correlation token until then.
- `call_handler.py` is the only service that writes to Supabase; `server.py` forwards live-call facts to it via `/api/call-live-facts` rather than writing directly.
- Batch calling and single calling both go through the same `/api/outbound-call` endpoint on `server.py`.
- Batch-calling durable state (campaigns, campaign leads, call attempts, idempotency, stale-attempt recovery) requires `schema_campaigns.sql` to have been run against Supabase — `call_handler_app/campaigns.py` will 500 on every request until it has.