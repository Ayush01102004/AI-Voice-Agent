"""
call_handler.py  —  FastAPI + Supabase
Telnyx webhook receiver + transcription + lead extraction + N8N trigger

Run:
  pip install fastapi uvicorn httpx groq python-dotenv supabase
  uvicorn call_handler:app --host 0.0.0.0 --port 8000 --reload

Upgrades vs v3.2.0:
  8.  source field written to calls table         [Top Sources chart support]
  9.  name extracted from transcript + saved      [Leads page name column]
  10. lifespan replaces deprecated on_event()    [FastAPI v0.93+ clean startup]
  11. system_prompt fetched from agent_config DB  [no more hardcoded prompt]
  12. agent_config cache with TTL=5min            [prompt edits apply fast]
  13. Telnyx webhook replaces Twilio              [POST /telnyx-webhook]
  14. lead_name exposed in /api/config            [server.py recovery memory]

Upgrades vs v3.4.0:
  15. Telnyx webhook signature verification        [was unauthenticated]
  16. retry/backoff on delayed recording fetch      [was single-shot after fixed 5s sleep]
  17. CORS origins now env-configurable             [was allow_origins=["*"] hardcoded]
  18. /api/call-live-facts endpoint                  [receives server.py's live-call facts/history,
                                                       so call_handler.py stays the single DB writer]
"""

import asyncio
import base64
import json
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from groq import AsyncGroq
from supabase import create_client, Client

# ── env ───────────────────────────────────────────────────────

load_dotenv()

DEEPGRAM_API_KEY          = os.getenv("DEEPGRAM_API_KEY", "")
GROQ_API_KEY              = os.getenv("GROQ_API_KEY", "")
N8N_WEBHOOK_URL           = os.getenv("N8N_WEBHOOK_URL", "")
SUPABASE_URL              = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
TELNYX_API_KEY            = os.getenv("TELNYX_API_KEY", "")   # UPGRADE #13
TELNYX_PUBLIC_KEY         = os.getenv("TELNYX_PUBLIC_KEY", "")  # NEW: UPGRADE #15
INTERNAL_API_KEY          = os.getenv("INTERNAL_API_KEY", "")   # NEW: UPGRADE #18 — shared secret for server.py → call_handler.py calls
ALLOWED_ORIGINS           = [
    o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o.strip()
]  # NEW: UPGRADE #17

for name, val in [
    ("DEEPGRAM_API_KEY",          DEEPGRAM_API_KEY),
    ("GROQ_API_KEY",              GROQ_API_KEY),
    ("SUPABASE_URL",              SUPABASE_URL),
    ("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY),
]:
    if not val:
        raise ValueError(f"{name} missing from .env")

groq_client: AsyncGroq       = AsyncGroq(api_key=GROQ_API_KEY)
supabase:    Optional[Client] = None

# ── NEW: UPGRADE #15/#16 constants ───────────────────────────

WEBHOOK_TIMESTAMP_SKEW_S     = 300.0  # reject Telnyx webhook timestamps older than this
RECORDING_FETCH_RETRIES      = 3
RECORDING_FETCH_BACKOFF_S    = 4.0    # multiplied by attempt number, on top of the initial 5s wait

# ── UPGRADE #12: agent_config cache ──────────────────────────

_CONFIG_CACHE:    Dict[str, Dict[str, str]] = {}   # {agent_id: {key: value}}
_CONFIG_CACHE_TS: Dict[str, float] = {}             # {agent_id: monotonic_ts}
_CONFIG_TTL:      float = 300.0  # 5 minutes

_DEFAULT_SYSTEM_PROMPT = """
You are a friendly and confident sales caller from Inbox Infotech.
You are speaking naturally on a real-time phone call.

STYLE:
- Speak naturally like a real human
- Keep replies short and conversational
- Be slightly persuasive, avoid long explanations

RULES:
- Never sound robotic or repeat yourself
- Stay concise and relevant

SERVICES:
- AI / ML Development | IoT Solutions | CRM / ERP
- Mobile & Web Development | Cloud & DevOps
- API Integration | Automation Solutions

GOAL:
Understand customer needs and guide the conversation naturally.
""".strip()


DEFAULT_AGENT_ID = "default"

def _fetch_agent_config_sync(agent_id: str) -> Dict[str, str]:
    rows = (
        _get_supabase()
        .table("agent_config")
        .select("key, value")
        .eq("agent_id", agent_id)
        .execute()
        .data or []
    )
    return {r["key"]: r["value"] for r in rows}


# UPGRADE #19: config cache is now keyed per agent_id (multi-agent support).
# _CONFIG_CACHE / _CONFIG_CACHE_TS are dicts: {agent_id: {...}} / {agent_id: ts}
# so each agent's prompt/name/etc refreshes independently and one agent's
# cache miss never forces a refetch of the other nine.
async def get_agent_config(agent_id: str = DEFAULT_AGENT_ID, force: bool = False) -> Dict[str, str]:
    global _CONFIG_CACHE, _CONFIG_CACHE_TS
    now = time.monotonic()
    cached    = _CONFIG_CACHE.get(agent_id)
    cached_ts = _CONFIG_CACHE_TS.get(agent_id, 0.0)
    if force or not cached or (now - cached_ts) > _CONFIG_TTL:
        try:
            cfg = await asyncio.to_thread(_fetch_agent_config_sync, agent_id)
            _CONFIG_CACHE[agent_id]    = cfg
            _CONFIG_CACHE_TS[agent_id] = now
            print(f"[config] refreshed agent_id={agent_id} — {len(cfg)} keys")
        except Exception as e:
            print(f"[config] fetch failed for agent_id={agent_id}, using cache/defaults: {e}")
    return _CONFIG_CACHE.get(agent_id, {})


async def get_system_prompt(agent_id: str = DEFAULT_AGENT_ID) -> str:
    cfg    = await get_agent_config(agent_id)
    prompt = cfg.get("system_prompt", "").strip()
    if not prompt:
        print(f"[config] system_prompt not in DB for agent_id={agent_id} — using default")
        return _DEFAULT_SYSTEM_PROMPT
    return prompt


# UPGRADE #19: resolve which agent_id owns an inbound/outbound number.
# Cached briefly since the phone->agent mapping changes rarely.
_PHONE_MAP_CACHE: Dict[str, str] = {}
_PHONE_MAP_CACHE_TS: float = 0.0
_PHONE_MAP_TTL = 300.0  # 5 min - mapping changes rarely, ok to lag briefly

def _fetch_phone_map_sync() -> Dict[str, str]:
    rows = (
        _get_supabase()
        .table("agents")
        .select("agent_id, phone_number")
        .eq("is_active", True)
        .execute()
        .data or []
    )
    return {r["phone_number"]: r["agent_id"] for r in rows if r.get("phone_number")}


async def resolve_agent_id_for_number(to_number: Optional[str]) -> str:
    global _PHONE_MAP_CACHE, _PHONE_MAP_CACHE_TS
    if not to_number:
        return DEFAULT_AGENT_ID
    now = time.monotonic()
    if not _PHONE_MAP_CACHE or (now - _PHONE_MAP_CACHE_TS) > _PHONE_MAP_TTL:
        try:
            _PHONE_MAP_CACHE    = await asyncio.to_thread(_fetch_phone_map_sync)
            _PHONE_MAP_CACHE_TS = now
        except Exception as e:
            print(f"[phone_map] fetch failed, using stale/empty cache: {e}")
    return _PHONE_MAP_CACHE.get(to_number, DEFAULT_AGENT_ID)

# ── lifespan ──────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global supabase
    supabase = create_client(
        supabase_url=SUPABASE_URL,
        supabase_key=SUPABASE_SERVICE_ROLE_KEY,
    )
    print("[startup] Supabase client ready")
    try:
        await get_agent_config(DEFAULT_AGENT_ID, force=True)
        prompt_preview = (await get_system_prompt(DEFAULT_AGENT_ID))[:80].replace("\n", " ")
        print(f"[startup] default system_prompt loaded: '{prompt_preview}…'")
        await resolve_agent_id_for_number(None)  # warms phone map cache
    except Exception as e:
        print(f"[startup] config pre-warm failed: {e}")

    yield
    print("[shutdown] clean exit")

# ── app ───────────────────────────────────────────────────────

app = FastAPI(
    title="Inbox Infotech — Call Handler",
    version="3.4.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,   # CHANGED: was hardcoded ["*"] — now env-driven, defaults to "*" if unset
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Supabase guard ────────────────────────────────────────────

def _get_supabase() -> Client:
    if supabase is None:
        raise RuntimeError("Supabase client not initialised yet")
    return supabase

# ── NEW: UPGRADE #15 — Telnyx webhook signature verification ──
# Same Ed25519 + timestamp-freshness pattern used in server.py's
# /telnyx/voice handler. No-ops (accepts everything) if
# TELNYX_PUBLIC_KEY is not set, matching server.py's behavior.

async def _verify_telnyx_signature(request: Request) -> bytes:
    """
    Returns the raw request body bytes if verification passes
    (or is disabled). Raises HTTPException(403) if verification
    is enabled and fails.
    """
    body = await request.body()

    if not TELNYX_PUBLIC_KEY:
        return body

    from fastapi import HTTPException as _HTTPException
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    sig       = request.headers.get("telnyx-signature-ed25519", "")
    timestamp = request.headers.get("telnyx-timestamp", "")

    try:
        ts_val = float(timestamp)
    except (TypeError, ValueError):
        raise _HTTPException(status_code=403, detail="Missing or invalid Telnyx timestamp")

    if abs(time.time() - ts_val) > WEBHOOK_TIMESTAMP_SKEW_S:
        raise _HTTPException(status_code=403, detail="Stale Telnyx webhook timestamp")

    try:
        pub_key = Ed25519PublicKey.from_public_bytes(base64.b64decode(TELNYX_PUBLIC_KEY))
        pub_key.verify(base64.b64decode(sig), (timestamp + "|").encode() + body)
    except _HTTPException:
        raise
    except Exception as exc:
        print(f"[telnyx-webhook] signature verify failed: {exc}")
        raise _HTTPException(status_code=403, detail="Invalid Telnyx signature")

    return body

# ═══════════════════════════════════════════════════════════════
# UPGRADE #13: Telnyx webhook  POST /telnyx-webhook
# Replaces /twilio-webhook.
#
# Telnyx sends call.completed events via HTTP webhooks (JSON body).
# Recording URL comes from a separate call.recording.saved event
# or the Telnyx Call Control API; here we handle both patterns:
#   a) call.recording.saved  → has recording_url directly
#   b) call.completed        → fetch recording from Telnyx API
# ═══════════════════════════════════════════════════════════════

async def _fetch_telnyx_recording(call_control_id: str) -> str:
    """
    Query Telnyx API for the recording URL of a completed call.
    Returns empty string if not found or API key missing.
    """
    if not TELNYX_API_KEY:
        print("[telnyx] TELNYX_API_KEY not set — cannot fetch recording")
        return ""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"https://api.telnyx.com/v2/recordings?filter[call_control_id]={call_control_id}",
                headers={"Authorization": f"Bearer {TELNYX_API_KEY}"},
            )
            if resp.status_code == 200:
                data = resp.json().get("data", [])
                if data:
                    url = data[0].get("download_urls", {}).get("mp3", "")
                    print(f"[telnyx] recording URL fetched: {url[:60]}…")
                    return url
            print(f"[telnyx] recording fetch {resp.status_code}: {resp.text[:120]}")
    except Exception as e:
        print(f"[telnyx] recording fetch error: {e}")
    return ""


@app.post("/telnyx-webhook")
async def telnyx_webhook(request: Request, background_tasks: BackgroundTasks):
    """
    Handles two Telnyx event types:
      - call.recording.saved  → recording URL available immediately
      - call.completed        → fetch recording via API
    All other events return 200 immediately (Telnyx requires ACK).
    """
    # NEW: UPGRADE #15 — verify signature before trusting the body at all.
    raw_body = await _verify_telnyx_signature(request)

    try:
        body = json.loads(raw_body)
    except Exception:
        return JSONResponse({"status": "bad_request"}, status_code=400)

    data      = body.get("data", {})
    event_type = data.get("event_type", "")
    payload   = data.get("payload", {})

    call_control_id = payload.get("call_control_id", "")
    call_leg_id     = payload.get("call_leg_id", call_control_id)

    # Source tag: N8N sets X-Lead-Source header when triggering outbound calls
    source = request.headers.get("X-Lead-Source", "Outbound Call")

    print(f"[telnyx-webhook] event={event_type} call_control_id={call_control_id}")

    # ── call.recording.saved ──────────────────────────────────
    if event_type == "call.recording.saved":
        recording_url = (
            payload.get("recording_urls", {}).get("mp3", "")
            or payload.get("public_recording_urls", {}).get("mp3", "")
        )
        if not recording_url:
            return JSONResponse({"status": "skipped", "reason": "no recording url"})

        from_number  = payload.get("from", "")
        to_number    = payload.get("to", "")
        duration_sec = int(payload.get("duration_secs", 0))

        call_meta = {
            "call_sid":      call_control_id,
            "from_number":   from_number,
            "to_number":     to_number,
            "duration_sec":  duration_sec,
            "recording_url": recording_url,
            "source":        source,
            "received_at":   datetime.utcnow().isoformat(),
        }
        background_tasks.add_task(
            process_recording_pipeline, call_control_id, recording_url, call_meta
        )
        print(f"[telnyx-webhook] queued pipeline for {call_control_id}")
        return JSONResponse({"status": "received", "call_control_id": call_control_id})

    # ── call.completed ────────────────────────────────────────
    elif event_type == "call.completed":
        from_number  = payload.get("from", "")
        to_number    = payload.get("to", "")
        duration_sec = int(payload.get("duration_secs", 0))

        async def _delayed_pipeline():
            # Small initial delay — Telnyx may not have processed recording yet
            await asyncio.sleep(5)

            # CHANGED: UPGRADE #16 — retry with backoff instead of a single
            # fetch attempt. Was: one shot, silent skip on miss.
            recording_url = ""
            for attempt in range(RECORDING_FETCH_RETRIES):
                if attempt:
                    await asyncio.sleep(RECORDING_FETCH_BACKOFF_S * attempt)
                recording_url = await _fetch_telnyx_recording(call_control_id)
                if recording_url:
                    break
                print(f"[telnyx-webhook] recording not ready, attempt {attempt + 1}/{RECORDING_FETCH_RETRIES}")

            if not recording_url:
                print(f"[telnyx-webhook] no recording for {call_control_id} after {RECORDING_FETCH_RETRIES} attempts — skipping pipeline")
                return
            call_meta = {
                "call_sid":      call_control_id,
                "from_number":   from_number,
                "to_number":     to_number,
                "duration_sec":  duration_sec,
                "recording_url": recording_url,
                "source":        source,
                "received_at":   datetime.utcnow().isoformat(),
            }
            await process_recording_pipeline(call_control_id, recording_url, call_meta)

        background_tasks.add_task(_delayed_pipeline)
        return JSONResponse({"status": "received", "call_control_id": call_control_id})

    # ── all other events: ACK and ignore ─────────────────────
    return JSONResponse({"status": "ok", "event": event_type})


# ── Keep /twilio-webhook alive for legacy callers ─────────────
@app.post("/twilio-webhook")
async def twilio_webhook_legacy(request: Request, background_tasks: BackgroundTasks):
    """Backwards-compat shim — delegates to same pipeline."""
    form = await request.form()
    body = dict(form)

    call_sid      = body.get("CallSid", "")
    status        = body.get("CallStatus", "")
    recording_url = body.get("RecordingUrl", "")
    duration      = int(body.get("CallDuration", 0))
    from_number   = body.get("From", "")
    to_number     = body.get("To", "")
    source        = request.headers.get("X-Lead-Source", "Inbound Call")

    print(f"[twilio-legacy] call_sid={call_sid} status={status}")

    if status != "completed":
        return JSONResponse({"status": "skipped", "reason": f"status={status}"})
    if not call_sid or not recording_url:
        return JSONResponse({"status": "skipped", "reason": "missing fields"})

    if not recording_url.endswith(".mp3"):
        recording_url += ".mp3"

    call_meta = {
        "call_sid":      call_sid,
        "from_number":   from_number,
        "to_number":     to_number,
        "duration_sec":  duration,
        "recording_url": recording_url,
        "source":        source,
        "received_at":   datetime.utcnow().isoformat(),
    }
    background_tasks.add_task(
        process_recording_pipeline, call_sid, recording_url, call_meta
    )
    return JSONResponse({"status": "received", "call_sid": call_sid})

# ═══════════════════════════════════════════════════════════════
# TRANSCRIPTION
# ═══════════════════════════════════════════════════════════════

async def transcribe_recording(audio_bytes: bytes) -> str:
    print(f"[transcribe] sending {len(audio_bytes):,} bytes")

    async with httpx.AsyncClient(timeout=120) as client:
        response = await client.post(
            "https://api.deepgram.com/v1/listen"
            "?model=nova-3&punctuate=true&diarize=true&smart_format=true&utterances=true",
            headers={
                "Authorization": f"Token {DEEPGRAM_API_KEY}",
                "Content-Type":  "audio/mp3",
            },
            content=audio_bytes,
        )

    if response.status_code != 200:
        print(f"[transcribe] failed {response.status_code}: {response.text[:200]}")
        return ""

    data = response.json()

    try:
        words = data["results"]["channels"][0]["alternatives"][0].get("words", [])
    except Exception:
        try:
            return data["results"]["channels"][0]["alternatives"][0].get("transcript", "")
        except Exception:
            return ""

    if not words:
        return ""

    lines: List[str] = []
    current_speaker: Optional[int] = None
    current_words:   List[str]     = []

    for word in words:
        speaker_id = word.get("speaker", 0)
        punct_word = word.get("punctuated_word", word.get("word", ""))

        if speaker_id != current_speaker:
            if current_words and current_speaker is not None:
                label = "Agent" if current_speaker == 0 else "Customer"
                lines.append(f"{label}: {' '.join(current_words)}")
            current_speaker = speaker_id
            current_words   = [punct_word]
        else:
            current_words.append(punct_word)

    if current_words and current_speaker is not None:
        label = "Agent" if current_speaker == 0 else "Customer"
        lines.append(f"{label}: {' '.join(current_words)}")

    transcript = "\n".join(lines)
    print(f"[transcribe] done — {len(lines)} turns")
    return transcript

# ═══════════════════════════════════════════════════════════════
# EXTRACTION
# ═══════════════════════════════════════════════════════════════

EXTRACTION_PROMPT = """
You are an expert sales analyst at Inbox Infotech.
Analyze this call transcript and extract structured lead information.

Inbox Infotech services:
- AI / ML Development | IoT Solutions | CRM / ERP
- Mobile & Web Development | Cloud & DevOps
- API Integration | Automation Solutions

Transcript:
{transcript}

Return ONLY valid JSON with this exact structure:
{{
    "name": "",
    "company": "",
    "pain_points": [],
    "budget": "",
    "requirements": [],
    "timeline": "",
    "decision_maker": true,
    "industry": "",
    "intent_level": "high",
    "lead_score": 8,
    "lead_category": "HOT",
    "summary": "",
    "next_action": "",
    "interested_services": []
}}

Field notes:
- name: customer's first name if mentioned, else empty string ""
- company: customer's company name if mentioned, else empty string ""

Scoring rules — apply strictly:
HOT  (score 8-10): clear interest + budget indicator + decision maker + urgency
WARM (score 4-7) : interested but vague on budget/timeline, or not decision maker
COLD (score 1-3) : no interest, declined, hung up, wrong number, voicemail
"""

_COLD_FALLBACK: Dict[str, Any] = {
    "name":               "",
    "company":            "",
    "pain_points":        [],
    "budget":             "not mentioned",
    "requirements":       [],
    "timeline":           "not mentioned",
    "decision_maker":     False,
    "industry":           "unknown",
    "intent_level":       "low",
    "lead_score":         1,
    "lead_category":      "COLD",
    "summary":            "No transcript available.",
    "next_action":        "Retry call later.",
    "interested_services": [],
}


async def extract_insights(call_sid: str, transcript: str) -> Dict[str, Any]:
    if not transcript.strip():
        return _COLD_FALLBACK.copy()

    try:
        response = await groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {"role": "system", "content": "You are a sales analyst. Return only valid JSON."},
                {"role": "user",   "content": EXTRACTION_PROMPT.format(transcript=transcript)},
            ],
            response_format={"type": "json_object"},
            temperature=0.1,
            max_tokens=800,
        )

        extracted = json.loads(response.choices[0].message.content)

        extracted.setdefault("name", "")
        extracted.setdefault("company", "")
        extracted.setdefault("pain_points", [])
        extracted.setdefault("requirements", [])
        extracted.setdefault("interested_services", [])
        extracted.setdefault("lead_score", 1)
        extracted.setdefault("lead_category", "COLD")
        extracted["lead_score"] = max(1, min(10, int(extracted["lead_score"])))
        cat = extracted["lead_category"].upper()
        extracted["lead_category"] = cat if cat in ("HOT", "WARM", "COLD") else "COLD"

        name = str(extracted.get("name", "")).strip()
        extracted["name"] = name if name.lower() not in ("", "unknown", "n/a", "none") else ""

        company = str(extracted.get("company", "")).strip()
        extracted["company"] = company if company.lower() not in ("", "unknown", "n/a", "none") else ""

        print(f"[extract] {call_sid} → {extracted['lead_category']} score={extracted['lead_score']} name='{extracted['name']}' company='{extracted['company']}'")
        return extracted

    except Exception as e:
        print(f"[extract] failed: {e}")
        return {**_COLD_FALLBACK, "summary": "Extraction failed.", "next_action": "Manual review required."}

# ═══════════════════════════════════════════════════════════════
# SUPABASE STORAGE
# ═══════════════════════════════════════════════════════════════

def _save_record_sync(row: Dict[str, Any]) -> None:
    _get_supabase().table("calls").upsert(row).execute()


async def save_record(record: Dict[str, Any]) -> None:
    meta      = record.get("meta", {})
    extracted = record.get("extracted", {})

    # UPGRADE #19: tag which agent handled this call for per-agent reporting
    agent_id = await resolve_agent_id_for_number(meta.get("to_number"))

    row = {
        "call_sid":      record["call_sid"],
        "from_number":   meta.get("from_number"),
        "to_number":     meta.get("to_number"),
        "duration_sec":  meta.get("duration_sec", 0),
        "transcript":    record.get("transcript", ""),
        "lead_category": extracted.get("lead_category", "COLD"),
        "lead_score":    extracted.get("lead_score", 1),
        "extracted":     extracted,
        "recording_url": meta.get("recording_url", ""),
        "source":        meta.get("source", "Unknown"),
        "name":          extracted.get("name", ""),
        "company":       extracted.get("company", ""),   # UPGRADE #14 side-effect
        "agent_id":      agent_id,
    }

    try:
        await asyncio.to_thread(_save_record_sync, row)
        print(f"[storage] saved {record['call_sid']} to Supabase")
    except Exception as e:
        print(f"[storage] Supabase error: {e}")


def _load_records_sync(category: Optional[str], limit: int) -> List[Dict[str, Any]]:
    query = (
        _get_supabase()
        .table("calls")
        .select("*")
        .order("created_at", desc=True)
        .limit(limit)
    )
    if category:
        query = query.eq("lead_category", category.upper())
    return query.execute().data or []


def _load_stats_sync() -> List[Dict[str, Any]]:
    return (
        _get_supabase()
        .table("calls")
        .select("lead_category, lead_score")
        .execute()
        .data or []
    )


def _load_transcript_sync(call_sid: str) -> Optional[Dict[str, Any]]:
    res = (
        _get_supabase()
        .table("calls")
        .select("call_sid, transcript")
        .eq("call_sid", call_sid)
        .single()
        .execute()
    )
    return res.data


# ── NEW: UPGRADE #18 — live-call facts from server.py ───────
# Writes to dedicated live_* columns only, so this never collides
# with the post-call pipeline's columns (transcript, extracted,
# lead_category, etc). call_handler.py remains the only writer
# to Supabase — server.py never touches the DB directly.
#
# Requires these columns to exist on the "calls" table:
#   live_facts       jsonb
#   live_outcome     text
#   live_history     jsonb
#   live_updated_at  timestamptz

def _save_live_facts_sync(row: Dict[str, Any]) -> None:
    _get_supabase().table("calls").upsert(row, on_conflict="call_sid").execute()


async def save_live_facts(
    call_sid: str,
    facts:    Dict[str, Any],
    outcome:  Optional[str],
    history:  List[Dict[str, str]],
) -> None:
    row = {
        "call_sid":        call_sid,
        "live_facts":      facts,
        "live_outcome":    outcome,
        "live_history":    history,
        "live_updated_at": datetime.utcnow().isoformat(),
    }
    try:
        await asyncio.to_thread(_save_live_facts_sync, row)
        print(f"[storage] live facts saved for {call_sid}")
    except Exception as e:
        print(f"[storage] live facts save error for {call_sid}: {e}")

# ═══════════════════════════════════════════════════════════════
# N8N HOT LEAD TRIGGER
# ═══════════════════════════════════════════════════════════════

async def trigger_hot_lead_workflow(
    call_sid:  str,
    extracted: Dict[str, Any],
    meta:      Dict[str, Any],
) -> None:
    if not N8N_WEBHOOK_URL:
        print("[n8n] webhook not configured — skipping")
        return

    payload = {
        "call_sid":            call_sid,
        "to_number":           meta.get("to_number"),
        "name":                extracted.get("name", ""),
        "company":             extracted.get("company", ""),
        "duration_sec":        meta.get("duration_sec"),
        "recording_url":       meta.get("recording_url"),
        "source":              meta.get("source", "Unknown"),
        "lead_category":       extracted.get("lead_category"),
        "lead_score":          extracted.get("lead_score"),
        "intent_level":        extracted.get("intent_level"),
        "summary":             extracted.get("summary"),
        "next_action":         extracted.get("next_action"),
        "pain_points":         extracted.get("pain_points"),
        "requirements":        extracted.get("requirements"),
        "budget":              extracted.get("budget"),
        "timeline":            extracted.get("timeline"),
        "interested_services": extracted.get("interested_services"),
    }

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(N8N_WEBHOOK_URL, json=payload)
        print(f"[n8n] {resp.status_code} for {call_sid}")
    except Exception as e:
        print(f"[n8n] failed: {e}")

# ═══════════════════════════════════════════════════════════════
# PIPELINE
# ═══════════════════════════════════════════════════════════════

async def process_recording_pipeline(
    call_sid:      str,
    recording_url: str,
    call_meta:     Dict[str, Any],
) -> None:
    print(f"[pipeline] started {call_sid}")

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.get(recording_url)
            resp.raise_for_status()
            audio_bytes = resp.content
        print(f"[pipeline] downloaded {len(audio_bytes):,} bytes")
    except Exception as e:
        print(f"[pipeline] download failed: {e}")
        return

    transcript = await transcribe_recording(audio_bytes)
    extracted  = await extract_insights(call_sid, transcript)

    await save_record({
        "call_sid":   call_sid,
        "meta":       call_meta,
        "transcript": transcript,
        "extracted":  extracted,
    })

    if extracted.get("lead_category") == "HOT":
        print(f"[pipeline] HOT lead — triggering n8n")
        await trigger_hot_lead_workflow(call_sid, extracted, call_meta)

    print(f"[pipeline] completed {call_sid}")

# ═══════════════════════════════════════════════════════════════
# API ENDPOINTS
# ═══════════════════════════════════════════════════════════════

@app.get("/api/leads")
async def get_leads(category: Optional[str] = None, limit: int = 100):
    try:
        records = await asyncio.to_thread(_load_records_sync, category, limit)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    leads = [
        {
            "call_sid":            r.get("call_sid"),
            "timestamp":           r.get("created_at"),
            "from_number":         r.get("from_number"),
            "to_number":           r.get("to_number"),
            "name":                r.get("name", ""),
            "company":             r.get("company", ""),
            "source":              r.get("source", "Unknown"),
            "duration_sec":        r.get("duration_sec"),
            "lead_category":       r.get("lead_category", "COLD"),
            "lead_score":          r.get("lead_score", 1),
            "intent_level":        (r.get("extracted") or {}).get("intent_level", "low"),
            "summary":             (r.get("extracted") or {}).get("summary", ""),
            "next_action":         (r.get("extracted") or {}).get("next_action", ""),
            "pain_points":         (r.get("extracted") or {}).get("pain_points", []),
            "interested_services": (r.get("extracted") or {}).get("interested_services", []),
            "recording_url":       r.get("recording_url", ""),
        }
        for r in records
    ]

    return JSONResponse({"total": len(leads), "leads": leads})


@app.get("/api/stats")
async def get_stats():
    try:
        rows = await asyncio.to_thread(_load_stats_sync)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    total     = len(rows)
    hot       = sum(1 for r in rows if r.get("lead_category") == "HOT")
    warm      = sum(1 for r in rows if r.get("lead_category") == "WARM")
    cold      = sum(1 for r in rows if r.get("lead_category") == "COLD")
    avg_score = (sum(r.get("lead_score", 0) for r in rows) / total if total else 0)

    return JSONResponse({
        "total_calls":     total,
        "hot":             hot,
        "warm":            warm,
        "cold":            cold,
        "avg_lead_score":  round(avg_score, 1),
        "conversion_rate": round(hot / total * 100, 1) if total else 0,
    })


@app.get("/api/transcript/{call_sid}")
async def get_transcript(call_sid: str):
    try:
        record = await asyncio.to_thread(_load_transcript_sync, call_sid)
    except Exception:
        record = None

    if not record:
        raise HTTPException(status_code=404, detail=f"No transcript for {call_sid}")

    raw    = record.get("transcript", "")
    parsed = [
        {
            "role": line.split(":")[0].strip(),
            "text": ":".join(line.split(":")[1:]).strip(),
        }
        for line in raw.splitlines()
        if ":" in line
    ]
    return JSONResponse({"call_sid": call_sid, "transcript": parsed})


# ═══════════════════════════════════════════════════════════════
# UPGRADE #14: /api/config — expose lead_name for server.py
# ═══════════════════════════════════════════════════════════════

@app.get("/api/config")
async def get_config(agent_id: str = DEFAULT_AGENT_ID):
    cfg = await get_agent_config(agent_id)

    # Keys safe to expose to server.py (never expose service role creds)
    safe_keys = {
        "system_prompt", "agent_name", "company_name",
        "calendly_link", "followup_delay", "notification_email",
        "lead_name",    # UPGRADE #14: server.py uses this for greeting + recovery memory
    }
    filtered = {k: v for k, v in cfg.items() if k in safe_keys}
    filtered["agent_id"] = agent_id

    # lead_name fallback: if not in agent_config table, check env
    # (useful when set per-campaign via environment variable)
    if "lead_name" not in filtered:
        env_lead = os.getenv("LEAD_NAME", "").strip()
        if env_lead:
            filtered["lead_name"] = env_lead

    return JSONResponse(filtered)


@app.post("/api/config/refresh")
async def refresh_config(agent_id: Optional[str] = None):
    # No agent_id -> refresh every agent currently cached (cheap: just re-fetches
    # per-agent rows already known about, not a full table scan per agent).
    if agent_id:
        await get_agent_config(agent_id, force=True)
        return JSONResponse({"status": "ok", "agent_id": agent_id, "keys": list(_CONFIG_CACHE.get(agent_id, {}).keys())})

    for aid in list(_CONFIG_CACHE.keys()) or [DEFAULT_AGENT_ID]:
        await get_agent_config(aid, force=True)
    return JSONResponse({"status": "ok", "agents_refreshed": list(_CONFIG_CACHE.keys())})


# ═══════════════════════════════════════════════════════════════
# UPGRADE #19: agent registry — list/create/update/delete agents,
# and resolve which agent owns an inbound Telnyx number.
# Dashboard's Agent Prompt page uses these (or reads/writes Supabase
# directly — either works since RLS/service-role key governs access).
# ═══════════════════════════════════════════════════════════════

_DEFAULT_AGENT_CONFIG_KEYS = ("system_prompt", "agent_name", "lead_name")

@app.get("/api/agents")
async def list_agents():
    rows = await asyncio.to_thread(
        lambda: _get_supabase().table("agents").select("*").order("created_at").execute().data or []
    )
    return JSONResponse({"agents": rows})


@app.post("/api/agents")
async def upsert_agent(request: Request):
    body = await request.json()
    agent_id = (body.get("agent_id") or "").strip()
    name     = (body.get("name") or "").strip()
    if not agent_id or not name:
        raise HTTPException(status_code=400, detail="agent_id and name are required")

    phone_number = (body.get("phone_number") or "").strip() or None
    now = datetime.utcnow().isoformat()

    def _upsert():
        _get_supabase().table("agents").upsert({
            "agent_id":     agent_id,
            "name":         name,
            "phone_number": phone_number,
            "is_active":    body.get("is_active", True),
            "updated_at":   now,
        }, on_conflict="agent_id").execute()

        # seed empty config rows for a brand-new agent so the prompt page
        # has something to edit immediately (no-op if rows already exist,
        # since we only insert keys that are missing)
        existing = (
            _get_supabase().table("agent_config")
            .select("key").eq("agent_id", agent_id).execute().data or []
        )
        existing_keys = {r["key"] for r in existing}
        seed_rows = [
            {"agent_id": agent_id, "key": k, "value": "", "updated_at": now}
            for k in _DEFAULT_AGENT_CONFIG_KEYS if k not in existing_keys
        ]
        if seed_rows:
            _get_supabase().table("agent_config").insert(seed_rows).execute()

    await asyncio.to_thread(_upsert)
    _PHONE_MAP_CACHE.clear()  # force phone routing refresh on next call
    return JSONResponse({"status": "ok", "agent_id": agent_id})


@app.delete("/api/agents/{agent_id}")
async def delete_agent(agent_id: str):
    if agent_id == DEFAULT_AGENT_ID:
        raise HTTPException(status_code=400, detail="cannot delete the default agent")

    def _delete():
        _get_supabase().table("agents").delete().eq("agent_id", agent_id).execute()
        _get_supabase().table("agent_config").delete().eq("agent_id", agent_id).execute()

    await asyncio.to_thread(_delete)
    _CONFIG_CACHE.pop(agent_id, None)
    _CONFIG_CACHE_TS.pop(agent_id, None)
    _PHONE_MAP_CACHE.clear()
    return JSONResponse({"status": "ok", "deleted": agent_id})


@app.get("/api/agent-for-number")
async def agent_for_number(to: str):
    agent_id = await resolve_agent_id_for_number(to)
    return JSONResponse({"to": to, "agent_id": agent_id})


# ═══════════════════════════════════════════════════════════════
# NEW: UPGRADE #18 — /api/call-live-facts
# Receives live-call facts/history/outcome from server.py so that
# in-call data isn't lost when a call drops before the post-call
# recording pipeline runs (or if that pipeline fails/is delayed).
# call_handler.py performs the actual Supabase write — server.py
# never gets a Supabase client, keeping this file the single writer.
# ═══════════════════════════════════════════════════════════════

@app.post("/api/call-live-facts")
async def post_call_live_facts(request: Request):
    if INTERNAL_API_KEY:
        provided = request.headers.get("X-Internal-Key", "")
        if provided != INTERNAL_API_KEY:
            raise HTTPException(status_code=403, detail="Invalid internal API key")

    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"status": "bad_request"}, status_code=400)

    call_sid = body.get("call_sid", "")
    if not call_sid:
        return JSONResponse({"status": "bad_request", "reason": "call_sid required"}, status_code=400)

    facts   = body.get("facts", {}) or {}
    outcome = body.get("outcome")
    history = body.get("history", []) or []

    await save_live_facts(call_sid, facts, outcome, history)
    return JSONResponse({"status": "ok", "call_sid": call_sid})


@app.get("/health")
async def health():
    try:
        res   = await asyncio.to_thread(
            lambda: _get_supabase().table("calls").select("id", count="exact").execute()
        )
        count = res.count or 0
    except Exception:
        count = -1

    cfg = await get_agent_config(DEFAULT_AGENT_ID)

    return JSONResponse({
        "status":             "ok",
        "calls_stored":       count,
        "config_keys_loaded": list(cfg.keys()),
        "agents_cached":      list(_CONFIG_CACHE.keys()),
        "timestamp":          datetime.utcnow().isoformat(),
    })

# ── entrypoint ────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("call_handler:app", host="0.0.0.0", port=8000, reload=True)
