"""
call_handler.py  —  FastAPI + Supabase
Twilio webhook receiver + transcription + lead extraction + Make.com trigger

Run:
  pip install fastapi uvicorn httpx groq python-dotenv supabase
  uvicorn call_handler:app --host 0.0.0.0 --port 8000 --reload

Upgrades vs v3.2.0:
  8. source field written to calls table         [Top Sources chart support]
  9. name extracted from transcript + saved      [Leads page name column]
  10. lifespan replaces deprecated on_event()   [FastAPI v0.93+ clean startup]
  11. system_prompt fetched from agent_config DB [no more hardcoded prompt]
  12. agent_config cache with TTL=5min           [prompt edits apply fast]
"""

import asyncio
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
from fastapi.responses import JSONResponse
from groq import AsyncGroq
from supabase import create_client, Client

# ── env ───────────────────────────────────────────────────────

load_dotenv()

DEEPGRAM_API_KEY      = os.getenv("DEEPGRAM_API_KEY", "")
GROQ_API_KEY          = os.getenv("GROQ_API_KEY", "") 
N8N_WEBHOOK_URL       = os.getenv("N8N_WEBHOOK_URL", "")
SUPABASE_URL          = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

for name, val in [
    ("DEEPGRAM_API_KEY",          DEEPGRAM_API_KEY),
    ("GROQ_API_KEY",              GROQ_API_KEY),
    ("SUPABASE_URL",              SUPABASE_URL),
    ("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY),
]:
    if not val:
        raise ValueError(f"{name} missing from .env")

groq_client: AsyncGroq       = AsyncGroq(api_key=GROQ_API_KEY)
supabase:    Optional[Client] = None  # initialised in lifespan

# ── UPGRADE #12: agent_config cache ──────────────────────────
# Fetched once at startup, refreshed every TTL seconds so prompt
# edits from the dashboard apply without a server restart.

_CONFIG_CACHE: Dict[str, str] = {}
_CONFIG_CACHE_TS: float = 0.0
_CONFIG_TTL: float = 300.0  # 5 minutes

# Fallback prompt — only used if agent_config table is empty/unreachable
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


def _fetch_agent_config_sync() -> Dict[str, str]:
    """Fetch all agent_config rows synchronously (called via to_thread)."""
    rows = (
        _get_supabase()
        .table("agent_config")
        .select("key, value")
        .execute()
        .data or []
    )
    return {r["key"]: r["value"] for r in rows}


async def get_agent_config(force: bool = False) -> Dict[str, str]:
    """Return cached agent_config, refreshing if stale or forced."""
    global _CONFIG_CACHE, _CONFIG_CACHE_TS
    now = time.monotonic()
    if force or not _CONFIG_CACHE or (now - _CONFIG_CACHE_TS) > _CONFIG_TTL:
        try:
            _CONFIG_CACHE = await asyncio.to_thread(_fetch_agent_config_sync)
            _CONFIG_CACHE_TS = now
            print(f"[config] refreshed — {len(_CONFIG_CACHE)} keys")
        except Exception as e:
            print(f"[config] fetch failed, using cache/defaults: {e}")
    return _CONFIG_CACHE


async def get_system_prompt() -> str:
    """Return system_prompt from DB, falling back to hardcoded default."""
    cfg = await get_agent_config()
    prompt = cfg.get("system_prompt", "").strip()
    if not prompt:
        print("[config] system_prompt not in DB — using default")
        return _DEFAULT_SYSTEM_PROMPT
    return prompt


# ── UPGRADE #10: lifespan replaces deprecated @on_event ───────

@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── startup ──
    global supabase
    supabase = create_client(
        supabase_url=SUPABASE_URL,
        supabase_key=SUPABASE_SERVICE_ROLE_KEY,
    )
    print("[startup] Supabase client ready")

    # Pre-warm config cache so first call has the prompt immediately
    try:
        await get_agent_config(force=True)
        prompt_preview = (await get_system_prompt())[:80].replace("\n", " ")
        print(f"[startup] system_prompt loaded: '{prompt_preview}…'")
    except Exception as e:
        print(f"[startup] config pre-warm failed: {e}")

    yield  # app runs

    # ── shutdown ──
    print("[shutdown] clean exit")


# ── app ───────────────────────────────────────────────────────

app = FastAPI(
    title="Inbox Infotech — Call Handler",
    version="3.3.0",
    lifespan=lifespan,         # UPGRADE #10
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Supabase guard ────────────────────────────────────────────

def _get_supabase() -> Client:
    if supabase is None:
        raise RuntimeError("Supabase client not initialised yet")
    return supabase


# ── POST /twilio-webhook ──────────────────────────────────────

@app.post("/twilio-webhook")
async def twilio_webhook(request: Request, background_tasks: BackgroundTasks):
    form = await request.form()
    body = dict(form)

    call_sid      = body.get("CallSid", "")
    status        = body.get("CallStatus", "")
    recording_url = body.get("RecordingUrl", "")
    duration      = int(body.get("CallDuration", 0))
    from_number   = body.get("From", "")
    to_number     = body.get("To", "")

    # UPGRADE #8: tag source — Twilio webhook = inbound or Make.com-triggered.
    # N8N passes X-leads-source header when it triggers the call;
    # plain Twilio callbacks won't have it so we default to 'Inbound Call'.
    source = request.headers.get("X-Lead-Source", "Inbound Call")

    print(f"[twilio] call_sid={call_sid} status={status} duration={duration}s source={source}")

    if status != "completed":
        return JSONResponse({"status": "skipped", "reason": f"status={status}"})
    if not call_sid:
        return JSONResponse({"status": "skipped", "reason": "missing CallSid"})
    if not recording_url:
        return JSONResponse({"status": "skipped", "reason": "missing RecordingUrl"})

    if not recording_url.endswith(".mp3"):
        recording_url += ".mp3"

    call_meta = {
        "call_sid":      call_sid,
        "from_number":   from_number,
        "to_number":     to_number,
        "duration_sec":  duration,
        "recording_url": recording_url,
        "source":        source,          # UPGRADE #8
        "received_at":   datetime.utcnow().isoformat(),
    }

    background_tasks.add_task(
        process_recording_pipeline, call_sid, recording_url, call_meta
    )
    print(f"[twilio] queued pipeline for {call_sid}")
    return JSONResponse({"status": "received", "call_sid": call_sid})


# ── transcription ─────────────────────────────────────────────

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


# ── extraction ────────────────────────────────────────────────

# UPGRADE #9: added "name" field to extraction prompt + schema
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

Scoring rules — apply strictly:
HOT  (score 8-10): clear interest + budget indicator + decision maker + urgency
WARM (score 4-7) : interested but vague on budget/timeline, or not decision maker
COLD (score 1-3) : no interest, declined, hung up, wrong number, voicemail
"""

_COLD_FALLBACK: Dict[str, Any] = {
    "name":               "",
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

        # Defaults + validation
        extracted.setdefault("name", "")
        extracted.setdefault("pain_points", [])
        extracted.setdefault("requirements", [])
        extracted.setdefault("interested_services", [])
        extracted.setdefault("lead_score", 1)
        extracted.setdefault("lead_category", "COLD")
        extracted["lead_score"] = max(1, min(10, int(extracted["lead_score"])))
        cat = extracted["lead_category"].upper()
        extracted["lead_category"] = cat if cat in ("HOT", "WARM", "COLD") else "COLD"
        # Sanitise name — strip whitespace, never let LLM hallucinate "Unknown"
        name = str(extracted.get("name", "")).strip()
        extracted["name"] = name if name.lower() not in ("", "unknown", "n/a", "none") else ""

        print(f"[extract] {call_sid} → {extracted['lead_category']} score={extracted['lead_score']} name='{extracted['name']}'")
        return extracted

    except Exception as e:
        print(f"[extract] failed: {e}")
        return {**_COLD_FALLBACK, "summary": "Extraction failed.", "next_action": "Manual review required."}


# ── Supabase storage ──────────────────────────────────────────

def _save_record_sync(row: Dict[str, Any]) -> None:
    _get_supabase().table("calls").upsert(row).execute()


async def save_record(record: Dict[str, Any]) -> None:
    meta      = record.get("meta", {})
    extracted = record.get("extracted", {})

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
        # UPGRADE #8: persist source so dashboard Top Sources chart works
        "source":        meta.get("source", "Unknown"),
        # UPGRADE #9: top-level name column for fast queries / display
        "name":          extracted.get("name", ""),
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


# ── Make.com HOT lead trigger ─────────────────────────────────

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
        "name":                extracted.get("name", ""),   # UPGRADE #9
        "duration_sec":        meta.get("duration_sec"),
        "recording_url":       meta.get("recording_url"),
        "source":              meta.get("source", "Unknown"),  # UPGRADE #8
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


# ── pipeline ──────────────────────────────────────────────────

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


# ── GET /api/leads ────────────────────────────────────────────

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
            "name":                r.get("name", ""),                          # UPGRADE #9
            "source":              r.get("source", "Unknown"),                 # UPGRADE #8
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


# ── GET /api/stats ────────────────────────────────────────────

@app.get("/api/stats")
async def get_stats():
    try:
        rows = await asyncio.to_thread(_load_stats_sync)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    total = len(rows)
    hot   = sum(1 for r in rows if r.get("lead_category") == "HOT")
    warm  = sum(1 for r in rows if r.get("lead_category") == "WARM")
    cold  = sum(1 for r in rows if r.get("lead_category") == "COLD")
    avg_score = (sum(r.get("lead_score", 0) for r in rows) / total if total else 0)

    return JSONResponse({
        "total_calls":     total,
        "hot":             hot,
        "warm":            warm,
        "cold":            cold,
        "avg_lead_score":  round(avg_score, 1),
        "conversion_rate": round(hot / total * 100, 1) if total else 0,
    })


# ── GET /api/transcript/{call_sid} ────────────────────────────

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


# ── GET /api/config ───────────────────────────────────────────
# Exposed so server.py can fetch the prompt via HTTP if preferred
# (alternative to a shared Supabase client in that process).

@app.get("/api/config")
async def get_config():
    cfg = await get_agent_config()
    # Never expose service role key or internal values — only agent config
    safe_keys = {
        "system_prompt", "agent_name", "company_name",
        "calendly_link", "followup_delay", "notification_email",
    }
    return JSONResponse({k: v for k, v in cfg.items() if k in safe_keys})


# ── POST /api/config/refresh ──────────────────────────────────
# server.py calls this to force-bust the cache after a prompt save.

@app.post("/api/config/refresh")
async def refresh_config():
    await get_agent_config(force=True)
    return JSONResponse({"status": "ok", "keys": list(_CONFIG_CACHE.keys())})


# ── GET /health ───────────────────────────────────────────────

@app.get("/health")
async def health():
    try:
        res   = await asyncio.to_thread(
            lambda: _get_supabase().table("calls").select("id", count="exact").execute()
        )
        count = res.count or 0
    except Exception:
        count = -1

    cfg = await get_agent_config()

    return JSONResponse({
        "status":             "ok",
        "calls_stored":       count,
        "config_keys_loaded": list(cfg.keys()),
        "timestamp":          datetime.utcnow().isoformat(),
    })


# ── entrypoint ────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("call_handler:app", host="0.0.0.0", port=8000, reload=True)