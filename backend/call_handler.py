"""
call_handler.py  —  FastAPI + Supabase
Plivo webhook receiver + transcription + lead extraction + N8N trigger

Run:
  pip install fastapi uvicorn httpx groq python-dotenv supabase plivo resend
  uvicorn call_handler:app --host 0.0.0.0 --port 8000 --reload --log-level warning --no-access-log

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

Upgrades vs v3.5.0 — Plivo migration:
  19. Telnyx webhook/signature replaced by Plivo    [POST /plivo/recording, X-Plivo-Signature-V3]
  20. GET  /api/plivo/numbers                       [list rented numbers + which agent owns each]
  21. POST /api/plivo/link-number                   [bind a number to an agent: Plivo Application
                                                       + agents.phone_number, one call from the dashboard]

Upgrades vs v3.6.0 — Forms email, no OAuth:
  22. POST /api/send-form-email                     [Resend-based transactional send, replaces
                                                       Gmail OAuth — zero setup for end users,
                                                       single admin-side API key, real delivery
                                                       status logged to form_send_log]
"""

import asyncio
import base64
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx
import plivo
import resend
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from groq import AsyncGroq
from supabase import create_client, Client

# ── env ───────────────────────────────────────────────────────

load_dotenv()

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("call_handler")
logging.getLogger("httpx").setLevel(logging.WARNING)   # silence per-request noise
logging.getLogger("hpack").setLevel(logging.WARNING)

DEEPGRAM_API_KEY          = os.getenv("DEEPGRAM_API_KEY", "")
GROQ_API_KEY              = os.getenv("GROQ_API_KEY", "")
N8N_WEBHOOK_URL           = os.getenv("N8N_WEBHOOK_URL", "")
SUPABASE_URL              = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
PLIVO_AUTH_ID             = os.getenv("PLIVO_AUTH_ID", "")        # UPGRADE #19
PLIVO_AUTH_TOKEN          = os.getenv("PLIVO_AUTH_TOKEN", "")     # UPGRADE #19
PLIVO_ANSWER_URL          = os.getenv("PLIVO_ANSWER_URL", "")     # e.g. https://<server.py-domain>/plivo/answer
PLIVO_APP_NAME            = os.getenv("PLIVO_APP_NAME", "ai-voice-agent")  # shared Application, one for all agents/numbers
INTERNAL_API_KEY          = os.getenv("INTERNAL_API_KEY", "")   # shared secret for server.py → call_handler.py calls
RESEND_API_KEY            = os.getenv("RESEND_API_KEY", "")     # UPGRADE #22 — Forms page email send
RESEND_FROM_EMAIL         = os.getenv("RESEND_FROM_EMAIL", "Inbox Infotech <onboarding@resend.dev>")
ALLOWED_ORIGINS           = [
    o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o.strip()
]

for name, val in [
    ("DEEPGRAM_API_KEY",          DEEPGRAM_API_KEY),
    ("GROQ_API_KEY",              GROQ_API_KEY),
    ("SUPABASE_URL",              SUPABASE_URL),
    ("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY),
    ("PLIVO_AUTH_ID",             PLIVO_AUTH_ID),
    ("PLIVO_AUTH_TOKEN",          PLIVO_AUTH_TOKEN),
]:
    if not val:
        raise ValueError(f"{name} missing from .env")

groq_client:  AsyncGroq       = AsyncGroq(api_key=GROQ_API_KEY)
supabase:     Optional[Client] = None
plivo_client: plivo.RestClient = plivo.RestClient(PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN)

if RESEND_API_KEY:
    resend.api_key = RESEND_API_KEY   

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
            logger.debug("Config refreshed — agent_id=%s keys=%d", agent_id, len(cfg))
        except Exception as e:
            logger.warning("Config fetch failed — agent_id=%s using cache/defaults: %s", agent_id, e)
    return _CONFIG_CACHE.get(agent_id, {})


async def get_system_prompt(agent_id: str = DEFAULT_AGENT_ID) -> str:
    cfg    = await get_agent_config(agent_id)
    prompt = cfg.get("system_prompt", "").strip()
    if not prompt:
        logger.debug("No system_prompt in DB — agent_id=%s using default", agent_id)
        return _DEFAULT_SYSTEM_PROMPT
    return prompt

_PHONE_MAP_CACHE: Dict[str, str] = {}
_PHONE_MAP_CACHE_TS: float = 0.0
_PHONE_MAP_TTL = 300.0  # 5 min - mapping changes rarely, ok to lag briefly

def _fetch_phone_map_sync() -> Dict[str, str]:
 
    rows = (
        _get_supabase()
        .table("agent_numbers")
        .select("number, agent_id")
        .execute()
        .data or []
    )
    return {r["number"]: r["agent_id"] for r in rows if r.get("number")}


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
            logger.warning("Phone map fetch failed, using stale/empty cache: %s", e)
    return _PHONE_MAP_CACHE.get(to_number, DEFAULT_AGENT_ID)

# ── lifespan ──────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global supabase
    supabase = create_client(
        supabase_url=SUPABASE_URL,
        supabase_key=SUPABASE_SERVICE_ROLE_KEY,
    )
    logger.info("Supabase client initialised")
    try:
        await get_agent_config(DEFAULT_AGENT_ID, force=True)
        prompt_preview = (await get_system_prompt(DEFAULT_AGENT_ID))[:80].replace("\n", " ")
        logger.info("Startup complete — default agent config loaded")
        await resolve_agent_id_for_number(None)  # warms phone map cache
    except Exception as e:
        logger.error("Startup config pre-warm failed: %s", e)

    yield
    logger.info("Shutdown complete")

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
def _with_retry(fn, *args, retries: int = 2, delay: float = 0.15, **kwargs):
    last_exc: Optional[Exception] = None
    for attempt in range(retries + 1):
        try:
            return fn(*args, **kwargs)
        except (httpx.ReadError, httpx.RemoteProtocolError, ConnectionError) as e:
            last_exc = e
            if attempt < retries:
                logger.debug("Transient Supabase read error, retry %d/%d: %s", attempt + 1, retries, e)
                time.sleep(delay)
            else:
                logger.warning("Supabase call failed after %d retries: %s", retries, e)
    raise last_exc

async def _verify_plivo_signature(request: Request) -> Dict[str, str]:
    form   = await request.form()
    params = dict(form)

    signature = request.headers.get("X-Plivo-Signature-V3", "")
    nonce     = request.headers.get("X-Plivo-Signature-V3-Nonce", "")

    if not signature or not nonce:
        raise HTTPException(status_code=403, detail="Missing Plivo signature headers")

    url = str(request.url)
    try:
        valid = plivo.utils.validate_v3_signature(
            "POST", url, nonce, PLIVO_AUTH_TOKEN, signature, params
        )
    except Exception as exc:
        logger.warning("Plivo signature verification error: %s", exc)
        raise HTTPException(status_code=403, detail="Signature verification error")

    if not valid:
        raise HTTPException(status_code=403, detail="Invalid Plivo signature")

    return params


@app.post("/plivo/recording")
async def plivo_recording(request: Request, background_tasks: BackgroundTasks):
    params = await _verify_plivo_signature(request)

    call_uuid     = params.get("CallUUID", "")
    # Plivo's Record action callback field name for the file URL —
    # checked defensively across the couple of casings Plivo has used.
    recording_url = params.get("RecordUrl") or params.get("RecordingUrl") or ""
    duration_sec  = int(float(params.get("RecordingDuration", 0) or 0))
    from_number   = params.get("From", "")
    to_number     = params.get("To", "")
    source        = request.headers.get("X-Lead-Source", "Outbound Call")

    agent_id_hint = request.query_params.get("agent_id", "")

    logger.info("Recording received — call_uuid=%s agent_id=%s", call_uuid, agent_id_hint or "unassigned")

    if not call_uuid or not recording_url:
        return JSONResponse({"status": "skipped", "reason": "missing call_uuid or recording url"})

    call_meta = {
        "call_sid":      call_uuid,
        "from_number":   from_number,
        "to_number":     to_number,
        "duration_sec":  duration_sec,
        "recording_url": recording_url,
        "source":        source,
        "agent_id_hint": agent_id_hint,
        "received_at":   datetime.utcnow().isoformat(),
    }
    background_tasks.add_task(process_recording_pipeline, call_uuid, recording_url, call_meta)
    return JSONResponse({"status": "received", "call_uuid": call_uuid})


@app.post("/plivo/stream-status")
async def plivo_stream_status(request: Request):
    """Informational only — Plivo's <Stream statusCallbackUrl> pings this
    on stream start/stop. No DB write needed; the recording callback above
    is the authoritative source for the finished-call pipeline. Kept as a
    real endpoint (not a 404) purely so Plivo's callback retries don't pile
    up warnings in the Plivo console."""
    try:
        params = await _verify_plivo_signature(request)
        logger.debug("Stream status: %s", params.get("StreamEvent", params))
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("Stream status parse error: %s", e)
    return JSONResponse({"status": "ok"})

# ═══════════════════════════════════════════════════════════════
# TRANSCRIPTION
# ═══════════════════════════════════════════════════════════════

async def transcribe_recording(audio_bytes: bytes) -> str:
    logger.debug("Sending %d bytes to Deepgram", len(audio_bytes))

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
        logger.error("Transcription failed (%d): %s", response.status_code, response.text[:200])
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
    logger.debug("Transcription complete — %d turns", len(lines))
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

        logger.info("Lead extracted — call_sid=%s category=%s score=%s", call_sid, extracted["lead_category"], extracted["lead_score"])
        return extracted

    except Exception as e:
        logger.error("Lead extraction failed: %s", e)
        return {**_COLD_FALLBACK, "summary": "Extraction failed.", "next_action": "Manual review required."}

# ═══════════════════════════════════════════════════════════════
# SUPABASE STORAGE
# ═══════════════════════════════════════════════════════════════

def _save_record_sync(row: Dict[str, Any]) -> None:
    _get_supabase().table("calls").upsert(row, on_conflict="call_sid").execute()


def _safe_duration(raw: Any) -> float:
    """duration_sec arrives as a raw float (time.monotonic() delta) from
    server.py. Sending that straight into an `integer` Supabase column
    throws error 22P02 ('invalid input syntax for type integer') and the
    WHOLE upsert gets rejected — not just this field — which is why the
    transcript/lead_category/lead_score never landed even though
    /api/call-live-facts had already written a partial row moments
    earlier. Coerce defensively regardless of the column's exact type."""
    try:
        return round(float(raw), 1)
    except (TypeError, ValueError):
        return 0.0

async def save_record(record: Dict[str, Any]) -> None:
    meta      = record.get("meta", {})
    extracted = record.get("extracted", {})

    # NEW: agent pool — trust the agent_id the call actually ran under
    # (passed through from plivo_answer()'s pool pick) over a re-guess
    # from to_number, since routing is no longer number-based.
    agent_id = meta.get("agent_id_hint") or await resolve_agent_id_for_number(meta.get("to_number"))

    row = {
        "call_sid":      record["call_sid"],
        "from_number":   meta.get("from_number"),
        "to_number":     meta.get("to_number"),
        "duration_sec":  _safe_duration(meta.get("duration_sec", 0)),
        "transcript":    record.get("transcript", ""),
        "lead_category": extracted.get("lead_category", "COLD"),
        "lead_score":    extracted.get("lead_score", 1),
        "extracted":     extracted,
        "recording_url": meta.get("recording_url", ""),
        "source":        meta.get("source", "Unknown"),
        "name":          extracted.get("name", ""),
        "company":       extracted.get("company", ""),   # UPGRADE #14 side-effect — schema now has this column
        "agent_id":      agent_id,
    }

    try:
        await asyncio.to_thread(_save_record_sync, row)
        logger.debug("Call record saved — call_sid=%s", record["call_sid"])
    except Exception as e:
        logger.error("Supabase write failed: %s", e)


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
        logger.debug("Live facts saved — call_sid=%s", call_sid)
    except Exception as e:
        logger.error("Live facts save failed — call_sid=%s: %s", call_sid, e)

# ═══════════════════════════════════════════════════════════════
# N8N HOT LEAD TRIGGER
# ═══════════════════════════════════════════════════════════════

async def trigger_hot_lead_workflow(
    call_sid:  str,
    extracted: Dict[str, Any],
    meta:      Dict[str, Any],
) -> None:
    if not N8N_WEBHOOK_URL:
        logger.debug("N8N webhook not configured — skipping")
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
        logger.info("N8N workflow triggered — call_sid=%s status=%d", call_sid, resp.status_code)
    except Exception as e:
        logger.error("N8N trigger failed: %s", e)

# ═══════════════════════════════════════════════════════════════
# PIPELINE
# ═══════════════════════════════════════════════════════════════

async def process_recording_pipeline(
    call_sid:      str,
    recording_url: str,
    call_meta:     Dict[str, Any],
) -> None:
    logger.debug("Pipeline started — call_sid=%s", call_sid)

    try:
        audio_bytes = None
        last_err    = None
        # Plivo's Record action fires the instant the call ends, but the
        # mp3 isn't always finished processing/uploading on their media
        # server yet — an immediate GET can 403 even with correct auth.
        # Retry with backoff before giving up.
        for attempt, delay in enumerate((0, 2, 4, 8)):
            if delay:
                await asyncio.sleep(delay)
            try:
                async with httpx.AsyncClient(timeout=60) as client:
                    resp = await client.get(
                        recording_url,
                        auth=(PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN),
                    )
                    resp.raise_for_status()
                    audio_bytes = resp.content
                break
            except Exception as e:
                last_err = e
                logger.warning(
                    "Recording download attempt %d failed: %s", attempt + 1, e
                )
        if audio_bytes is None:
            raise last_err
        logger.debug("Recording downloaded — %d bytes", len(audio_bytes))
    except Exception as e:
        logger.error("Recording download failed: %s", e)
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
        logger.info("HOT lead — triggering N8N workflow")
        await trigger_hot_lead_workflow(call_sid, extracted, call_meta)

    logger.debug("Pipeline completed — call_sid=%s", call_sid)

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
            "company":             (r.get("extracted") or {}).get("company", ""),
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



def _fetch_agent_profile_sync(agent_id: str) -> Dict[str, Optional[str]]:
    """Name + phone live only on the `agents` table now — this is the single
    source of truth server.py reads for the spoken agent name, so the
    dashboard dropdown and what the agent says on calls can never disagree."""
    row = (
        _get_supabase()
        .table("agents")
        .select("name, phone_number")
        .eq("agent_id", agent_id)
        .maybe_single()
        .execute()
        .data
    )
    return row or {}


@app.get("/api/config")
async def get_config(agent_id: str = DEFAULT_AGENT_ID):
    cfg     = await get_agent_config(agent_id)
    profile = await asyncio.to_thread(_fetch_agent_profile_sync, agent_id)

    # Keys safe to expose to server.py (never expose service role creds)
    safe_keys = {
        "system_prompt", "company_name",
        "calendly_link", "followup_delay", "notification_email",
        "lead_name",    # UPGRADE #14: server.py uses this for greeting + recovery memory
    }
    filtered = {k: v for k, v in cfg.items() if k in safe_keys}
    filtered["agent_id"]      = agent_id
    filtered["agent_name"]    = (profile.get("name") or "").strip() or "Assistant"
    filtered["phone_number"]  = profile.get("phone_number")

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
# ═══════════════════════════════════════════════════════════════

_DEFAULT_AGENT_CONFIG_KEYS = ("system_prompt", "lead_name")

@app.get("/api/agents")
async def list_agents():
    rows = await asyncio.to_thread(
        _with_retry,
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


# ═══════════════════════════════════════════════════════════════
# ═══════════════════════════════════════════════════════════════

@app.patch("/api/agents/{agent_id}/toggle")
async def toggle_agent(agent_id: str, request: Request):
    body      = await request.json()
    is_active = bool(body.get("is_active"))

    def _update():
        _get_supabase().table("agents").update({
            "is_active":  is_active,
            "updated_at": datetime.utcnow().isoformat(),
        }).eq("agent_id", agent_id).execute()

    await asyncio.to_thread(_update)
    return JSONResponse({"status": "ok", "agent_id": agent_id, "is_active": is_active})


@app.get("/api/agents/active-count")
async def active_agent_count():
    def _counts():
        total  = _get_supabase().table("agents").select("agent_id", count="exact").execute()
        active = _get_supabase().table("agents").select("agent_id", count="exact").eq("is_active", True).execute()
        return (active.count or 0), (total.count or 0)

    active_n, total_n = await asyncio.to_thread(_with_retry, _counts)
    return JSONResponse({"count": active_n, "total": total_n})


@app.get("/api/agents/active-ids")
async def active_agent_ids():
    """Feeds server.py's pick_agent_from_pool() — server.py has no direct
    Supabase access (call_handler.py is the only DB reader/writer), so
    this is the HTTP equivalent of the 'SELECT agent_id WHERE is_active'
    query the pool picker needs, cached client-side same as /api/config."""
    def _ids():
        rows = _get_supabase().table("agents").select("agent_id").eq("is_active", True).execute().data or []
        return [r["agent_id"] for r in rows]

    ids = await asyncio.to_thread(_with_retry, _ids)
    return JSONResponse({"agent_ids": ids})


@app.get("/api/agent-for-number")
async def agent_for_number(to: str):
    # Distinguish "explicitly mapped to the default agent" from "no
    # mapping exists" — resolve_agent_id_for_number() collapses both into
    # the string "default", which made explicit links to that agent
    # indistinguishable from an unmapped number. Check the phone map
    # directly here so callers (server.py's pool-vs-explicit routing) can
    # tell them apart via agent_id being null.
    await resolve_agent_id_for_number(to)  # ensures _PHONE_MAP_CACHE is warm
    agent_id = (
        _PHONE_MAP_CACHE.get(to)
        or _PHONE_MAP_CACHE.get(f"+{to}")
        or _PHONE_MAP_CACHE.get(to.lstrip("+"))
    )
    return JSONResponse({"to": to, "agent_id": agent_id})


@app.get("/api/number-for-agent")
async def number_for_agent(agent_id: str):
    """Reverse of /api/agent-for-number: given an agent_id, return the
    Plivo number assigned to it (agent_numbers), for use as the From/
    caller-ID on outbound calls. If an agent owns multiple numbers,
    returns the first found — assign a single dedicated outbound number
    per agent if this matters for a given campaign."""
    def _lookup():
        rows = (
            _get_supabase()
            .table("agent_numbers")
            .select("number")
            .eq("agent_id", agent_id)
            .limit(1)
            .execute()
            .data or []
        )
        return rows[0]["number"] if rows else None

    number = await asyncio.to_thread(_with_retry, _lookup)
    return JSONResponse({"agent_id": agent_id, "number": number})


# ═══════════════════════════════════════════════════════════════
# ═══════════════════════════════════════════════════════════════

_plivo_app_id_cache: Optional[str] = None

async def _ensure_shared_application() -> str:
    """Finds (or creates once) the single Plivo Application every rented
    number gets bound to. Cached in-process after the first lookup."""
    global _plivo_app_id_cache
    if _plivo_app_id_cache:
        return _plivo_app_id_cache

    if not PLIVO_ANSWER_URL:
        raise HTTPException(
            status_code=500,
            detail="PLIVO_ANSWER_URL not configured — set it to server.py's public /plivo/answer URL",
        )

    def _find_or_create() -> str:
        existing = plivo_client.applications.list()
        for app_obj in existing:
            if getattr(app_obj, "app_name", None) == PLIVO_APP_NAME:
                if getattr(app_obj, "answer_url", None) != PLIVO_ANSWER_URL:
                    plivo_client.applications.update(
                        app_id=app_obj.app_id,
                        answer_url=PLIVO_ANSWER_URL,
                        answer_method="POST",
                    )
                    logger.info("Plivo app answer_url updated — app_id=%s -> %s", app_obj.app_id, PLIVO_ANSWER_URL)
                return app_obj.app_id
        created = plivo_client.applications.create(
            app_name=PLIVO_APP_NAME,
            answer_url=PLIVO_ANSWER_URL,
            answer_method="POST",
        )
        return created["app_id"]

    app_id = await asyncio.to_thread(_find_or_create)
    _plivo_app_id_cache = app_id
    logger.info("Plivo shared application ready — app_id=%s", app_id)
    return app_id


@app.get("/api/plivo/numbers")
async def list_plivo_numbers():
    """Every number rented on this Plivo account, cross-referenced with
    which agent (if any) currently owns it — powers the dashboard's
    'available Plivo numbers' picker on the Agent Profiles page.

    CHANGED: ownership now comes from agent_numbers (many numbers can
    point at the same agent_id — e.g. an India DID and a US DID both
    routed to "Alex" — agents.phone_number is no longer used for this)."""
    def _list_all() -> List[Dict[str, Any]]:
        out, offset = [], 0
        while True:
            page = plivo_client.numbers.list(limit=20, offset=offset)
            if not page:
                break
            out.extend(page)
            if len(page) < 20:
                break
            offset += 20
        return out

    try:
        numbers = await asyncio.to_thread(_with_retry, _list_all)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Plivo numbers.list failed: {e}")

    def _load_ownership():
        agent_numbers_rows = (
            _get_supabase().table("agent_numbers").select("number, agent_id").execute().data or []
        )
        agents_rows = (
            _get_supabase().table("agents").select("agent_id, name").execute().data or []
        )
        return agent_numbers_rows, agents_rows

    agent_numbers_rows, agents_rows = await asyncio.to_thread(_with_retry, _load_ownership)
    agent_name_by_id = {a["agent_id"]: a["name"] for a in agents_rows}
    owner_agent_id_by_number = {r["number"]: r["agent_id"] for r in agent_numbers_rows}

    result = []
    for n in numbers:
        number = getattr(n, "number", None) or n.get("number") if isinstance(n, dict) else getattr(n, "number", "")
        owner_agent_id = owner_agent_id_by_number.get(number) or owner_agent_id_by_number.get(f"+{number}")
        result.append({
            "number":       number,
            "region":       getattr(n, "region", None) or (n.get("region") if isinstance(n, dict) else None),
            "voice_enabled": getattr(n, "voice_enabled", None) if not isinstance(n, dict) else n.get("voice_enabled"),
            "monthly_rental_rate": getattr(n, "monthly_rental_rate", None) if not isinstance(n, dict) else n.get("monthly_rental_rate"),
            "assigned_agent_id":   owner_agent_id,
            "assigned_agent_name": agent_name_by_id.get(owner_agent_id) if owner_agent_id else None,
        })

    return JSONResponse({"numbers": result})


@app.post("/api/plivo/link-number")
async def link_plivo_number(request: Request):
    """Bind a rented Plivo number to an agent: attaches the shared
    Application to the number (so it actually routes calls to us) and
    upserts agent_numbers. One call from the dashboard's Agent Profiles
    page does both — no manual Plivo console steps.

    CHANGED: writes agent_numbers (number is the primary key) instead of
    agents.phone_number — this is what allows one agent to hold several
    numbers while every number still resolves to exactly one agent. If
    the number was previously assigned to a different agent, this call
    reassigns it (upsert on the number PK, not an insert-only)."""
    body     = await request.json()
    agent_id = (body.get("agent_id") or "").strip()
    number   = (body.get("number") or "").strip()
    region   = (body.get("region") or "").strip() or None

    if not agent_id or not number:
        raise HTTPException(status_code=400, detail="agent_id and number are required")

    app_id = await _ensure_shared_application()

    def _bind():
        plivo_client.numbers.update(number=number, app_id=app_id)

    try:
        await asyncio.to_thread(_bind)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Plivo number.update failed: {e}")

    def _save():
        _get_supabase().table("agent_numbers").upsert({
            "number":      number,
            "agent_id":    agent_id,
            "region":      region,
            "assigned_at": datetime.utcnow().isoformat(),
        }, on_conflict="number").execute()

    await asyncio.to_thread(_save)
    _PHONE_MAP_CACHE.clear()   # routing cache is now stale — next call resolves fresh
    logger.info("Number linked — number=%s agent_id=%s", number, agent_id)
    return JSONResponse({"status": "ok", "agent_id": agent_id, "number": number})


@app.post("/api/plivo/unlink-number")
async def unlink_plivo_number(request: Request):
    """Remove a number from whichever agent currently owns it. Leaves the
    Plivo Application attached (so re-assigning later is instant) — only
    the agent_numbers row is deleted."""
    body   = await request.json()
    number = (body.get("number") or "").strip()
    if not number:
        raise HTTPException(status_code=400, detail="number is required")

    def _delete():
        _get_supabase().table("agent_numbers").delete().eq("number", number).execute()

    await asyncio.to_thread(_delete)
    _PHONE_MAP_CACHE.clear()
    logger.info("Number unlinked — number=%s", number)
    return JSONResponse({"status": "ok", "number": number})


# ═══════════════════════════════════════════════════════════════
# ═══════════════════════════════════════════════════════════════

def _build_form_email_html(name: str, form_url: str) -> str:
    safe_name = name or "there"
    return f"""
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px">
      <h2 style="color:#111">Hi {safe_name},</h2>
      <p style="color:#555;font-size:15px;line-height:1.6">
        Please fill out this quick form so we can understand your requirements better.
      </p>
      <a href="{form_url}"
        style="display:inline-block;margin-top:8px;padding:12px 28px;background:#6366f1;
               color:#fff;border-radius:8px;text-decoration:none;font-weight:600">
        Open Form →
      </a>
      <p style="color:#aaa;font-size:12px;margin-top:24px">
        Or copy: <a href="{form_url}">{form_url}</a>
      </p>
    </div>
    """


def _send_form_email_sync(to_email: str, name: str, form_url: str) -> Dict[str, Any]:
    """Sync — always call via asyncio.to_thread. Raises on failure."""
    if not RESEND_API_KEY:
        raise RuntimeError("RESEND_API_KEY not set on server — see .env setup notes")
    return resend.Emails.send({
        "from":    RESEND_FROM_EMAIL,
        "to":      to_email,
        "subject": "Quick Form – Help Us Understand Your Requirements",
        "html":    _build_form_email_html(name, form_url),
    })


def _log_form_send(name: str, to_email: str, form_url: str, status: str,
                    provider_id: Optional[str] = None, error: Optional[str] = None) -> None:
    _get_supabase().table("form_send_log").insert({
        "lead_name":   name,
        "lead_email":  to_email,
        "form_url":    form_url,
        "sent_by":     "system",
        "status":      status,
        "provider_id": provider_id,
        "error":       error,
    }).execute()


@app.post("/api/send-form-email")
async def send_form_email_route(request: Request):
    body     = await request.json()
    to_email = (body.get("lead_email") or "").strip()
    name     = (body.get("lead_name") or "").strip()
    form_url = (body.get("form_url") or "").strip()

    if not to_email or not form_url:
        raise HTTPException(status_code=400, detail="lead_email and form_url are required")

    try:
        result      = await asyncio.to_thread(_send_form_email_sync, to_email, name, form_url)
        provider_id = result.get("id") if isinstance(result, dict) else None
        await asyncio.to_thread(_log_form_send, name, to_email, form_url, "sent", provider_id, None)
        logger.info("Form email sent — to=%s provider_id=%s", to_email, provider_id)
        return JSONResponse({"status": "ok", "provider_id": provider_id})
    except Exception as e:
        await asyncio.to_thread(_log_form_send, name, to_email, form_url, "failed", None, str(e))
        logger.error("Form email send failed — to=%s: %s", to_email, e)
        raise HTTPException(status_code=502, detail=f"Email send failed: {e}")


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


# ═══════════════════════════════════════════════════════════════
# NEW — /api/call-transcript
# Replaces the record-download-transcribe pipeline for the normal
# case: server.py already has the full transcript as text (built
# live from Deepgram's ConversationText events), so this skips
# audio recording, download, and re-transcription entirely and
# goes straight to Groq extraction + the same Supabase row shape
# process_recording_pipeline() used to produce.
# ═══════════════════════════════════════════════════════════════

def format_transcript_from_history(history: List[Dict[str, str]]) -> str:
    """Same "Agent: ..." / "Customer: ..." line shape transcribe_recording()
    produced, so extract_insights()'s prompt sees a consistent format
    whichever path a call came through."""
    lines: List[str] = []
    for turn in history:
        role = (turn.get("role") or "").lower()
        text = (turn.get("text") or "").strip()
        if not text:
            continue
        label = "Agent" if role == "assistant" else "Customer" if role == "user" else role.title()
        lines.append(f"{label}: {text}")
    return "\n".join(lines)


@app.post("/api/call-transcript")
async def post_call_transcript(request: Request, background_tasks: BackgroundTasks):
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

    history = body.get("history", []) or []
    call_meta = {
        "to_number":      body.get("to_number", ""),
        "from_number":    body.get("from_number", ""),
        "duration_sec":   body.get("duration_sec", 0),
        "source":         body.get("source", "Plivo"),
        "agent_id_hint":  body.get("agent_id", ""),
    }

    logger.info("Transcript received — call_sid=%s turns=%d", call_sid, len(history))
    background_tasks.add_task(process_transcript_pipeline, call_sid, history, call_meta)
    return JSONResponse({"status": "ok", "call_sid": call_sid})


async def process_transcript_pipeline(
    call_sid:  str,
    history:   List[Dict[str, str]],
    call_meta: Dict[str, Any],
) -> None:
    transcript = format_transcript_from_history(history)
    if not transcript.strip():
        logger.warning("Transcript pipeline skipped — empty transcript, call_sid=%s", call_sid)
        return

    extracted = await extract_insights(call_sid, transcript)

    await save_record({
        "call_sid":   call_sid,
        "meta":       call_meta,
        "transcript": transcript,
        "extracted":  extracted,
    })

    # N8N hot-lead trigger disabled for now — no workflow configured yet,
    # just testing the agent. Re-enable once N8N_WEBHOOK_URL is wired up.
    # if extracted.get("lead_category") == "HOT":
    #     logger.info("HOT lead — triggering N8N workflow")
    #     await trigger_hot_lead_workflow(call_sid, extracted, call_meta)

    logger.debug("Transcript pipeline completed — call_sid=%s", call_sid)


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
    uvicorn.run(
        "call_handler:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="warning",   # hides "Started server process", access lines, etc.
        access_log=False,      # hides per-request "GET /api/... 200 OK" spam
    )