"""
call_handler.py
FastAPI server — CallHippo + Twilio webhook receiver + lead pipeline

Endpoints:
  POST /callhippo-webhook      ← CallHippo posts here after every call ends
  POST /twilio-webhook         ← Twilio posts here after every call ends
  POST /extract                ← internal, called by server.py after browser sessions
  GET  /api/leads              ← dashboard lead list
  GET  /api/stats              ← dashboard summary stats
  GET  /api/transcript/{sid}   ← dashboard conversation view

Run:
  uvicorn call_handler:app --host 0.0.0.0 --port 8000 --reload
"""

import asyncio
import json
import os
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from groq import AsyncGroq

# ── env ───────────────────────────────────────────────────────────────────────

load_dotenv()

DEEPGRAM_API_KEY      = os.getenv("DEEPGRAM_API_KEY", "")
GROQ_API_KEY          = os.getenv("GROQ_API_KEY", "")
MAKE_HOT_LEAD_WEBHOOK = os.getenv("MAKE_HOT_LEAD_WEBHOOK", "")
CALLHIPPO_API_KEY     = os.getenv("CALLHIPPO_API_KEY", "")

if not DEEPGRAM_API_KEY:
    raise ValueError("DEEPGRAM_API_KEY missing from .env")
if not GROQ_API_KEY:
    raise ValueError("GROQ_API_KEY missing from .env")

CALLS_FILE = "calls.json"

groq_client = AsyncGroq(api_key=GROQ_API_KEY)

# ── app ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="Inbox Infotech — Call Handler", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],       # tighten to your React domain in production
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── in-memory transcript store (survives process lifetime, not restarts) ──────
# Keys: call_sid → list of {"role": str, "text": str}
_transcript_store: Dict[str, List[Dict[str, str]]] = {}


# =============================================================================
# POST /callhippo-webhook
# =============================================================================

@app.post("/callhippo-webhook")
async def callhippo_webhook(request: Request, background_tasks: BackgroundTasks):
    """
    CallHippo POSTs here after every call ends (JSON body).
    We respond 200 immediately, then process the recording in the background.
    """
    try:
        body: Dict[str, Any] = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    call_sid      = body.get("callSid", "")
    status        = body.get("status", "")
    recording_url = body.get("recordingUrl", "")
    duration      = body.get("durationSeconds", 0)
    from_number   = body.get("fromNumber", "")
    to_number     = body.get("toNumber", "")
    start_time    = body.get("startTime", "")
    end_time      = body.get("endTime", "")
    hangup_by     = body.get("hangupBy", "")
    caller_name   = body.get("callerName", "")
    country       = body.get("countryName", "")
    tags          = body.get("tags", [])
    dispositions  = body.get("dispositions", [])
    extra         = body.get("extraParams", {}) or {}
    campaign_id   = extra.get("campaignId", "")
    agent_id      = extra.get("agentId", "")
    crm_uid       = extra.get("crmUniqueId", "")
    virtual_num   = extra.get("virtualNumber", "")

    print(f"[callhippo-webhook] call_sid={call_sid} | status={status} | duration={duration}s")

    if status != "Completed":
        return JSONResponse({"status": "skipped", "reason": f"status is {status}"})
    if not recording_url:
        return JSONResponse({"status": "skipped", "reason": "no recordingUrl"})
    if not call_sid:
        return JSONResponse({"status": "skipped", "reason": "no callSid"})

    call_meta = {
        "call_sid":      call_sid,
        "source":        "callhippo",
        "from_number":   from_number,
        "to_number":     to_number,
        "duration_sec":  duration,
        "start_time":    start_time,
        "end_time":      end_time,
        "hangup_by":     hangup_by,
        "caller_name":   caller_name,
        "country":       country,
        "tags":          tags,
        "dispositions":  dispositions,
        "campaign_id":   campaign_id,
        "agent_id":      agent_id,
        "crm_uid":       crm_uid,
        "virtual_num":   virtual_num,
        "recording_url": recording_url,
        "received_at":   datetime.utcnow().isoformat(),
    }

    background_tasks.add_task(process_recording_pipeline, call_sid, recording_url, call_meta)
    print(f"[callhippo-webhook] queued background processing for {call_sid}")
    return JSONResponse({"status": "received", "call_sid": call_sid})


# =============================================================================
# POST /twilio-webhook
# =============================================================================

@app.post("/twilio-webhook")
async def twilio_webhook(request: Request, background_tasks: BackgroundTasks):
    """
    Twilio POSTs here after every call ends (form-encoded body — NOT JSON).
    Set this URL in Twilio Console → Phone Number → Voice → Status Callback URL.

    Key differences from CallHippo:
      - Body is form-encoded (application/x-www-form-urlencoded)
      - Status field is "CallStatus" with value "completed" (lowercase)
      - Recording URL needs .mp3 appended to download the audio file
      - CallSid is the session identifier (no separate streamSid needed here)
    """
    # Twilio sends form data, not JSON
    form = await request.form()
    body = dict(form)

    call_sid      = body.get("CallSid", "")
    status        = body.get("CallStatus", "")          # "completed", "busy", "no-answer", etc.
    recording_url = body.get("RecordingUrl", "")
    duration      = int(body.get("CallDuration", 0))
    from_number   = body.get("From", "")
    to_number     = body.get("To", "")
    direction     = body.get("Direction", "")           # "inbound" or "outbound-api"
    caller_name   = body.get("CallerName", "")
    from_city     = body.get("FromCity", "")
    from_country  = body.get("FromCountry", "")

    print(f"[twilio-webhook] call_sid={call_sid} | status={status} | duration={duration}s")

    # Twilio uses lowercase "completed"
    if status != "completed":
        print(f"[twilio-webhook] skipping — status={status}")
        return JSONResponse({"status": "skipped", "reason": f"status is {status}"})

    if not call_sid:
        print("[twilio-webhook] skipping — no CallSid")
        return JSONResponse({"status": "skipped", "reason": "no CallSid"})

    # Twilio recording URL requires .mp3 suffix to download audio
    if recording_url and not recording_url.endswith(".mp3"):
        recording_url += ".mp3"

    if not recording_url:
        print("[twilio-webhook] skipping — no RecordingUrl")
        return JSONResponse({"status": "skipped", "reason": "no RecordingUrl"})

    call_meta = {
        "call_sid":      call_sid,
        "source":        "twilio",
        "from_number":   from_number,
        "to_number":     to_number,
        "duration_sec":  duration,
        "direction":     direction,
        "caller_name":   caller_name,
        "from_city":     from_city,
        "from_country":  from_country,
        "recording_url": recording_url,
        "received_at":   datetime.utcnow().isoformat(),
    }

    background_tasks.add_task(process_recording_pipeline, call_sid, recording_url, call_meta)
    print(f"[twilio-webhook] queued background processing for {call_sid}")
    # Twilio expects a 204 or 200 with empty/minimal body
    return JSONResponse({"status": "received", "call_sid": call_sid})


# =============================================================================
# Transcription via Deepgram pre-recorded API
# =============================================================================

async def transcribe_recording(audio_bytes: bytes) -> str:
    """
    Sends MP3 bytes directly to Deepgram's pre-recorded endpoint.
    diarize=true → Speaker 0 / Speaker 1 labels → mapped to Agent / Customer.
    Returns a formatted transcript string.
    """
    print(f"[transcribe] sending {len(audio_bytes):,} bytes to Deepgram...")

    async with httpx.AsyncClient(timeout=120) as client:
        response = await client.post(
            "https://api.deepgram.com/v1/listen"
            "?model=nova-3"
            "&punctuate=true"
            "&diarize=true"
            "&smart_format=true"
            "&utterances=true",
            headers={
                "Authorization": f"Token {DEEPGRAM_API_KEY}",
                "Content-Type": "audio/mp3",
            },
            content=audio_bytes,
        )

    if response.status_code != 200:
        print(f"[transcribe] Deepgram error {response.status_code}: {response.text[:200]}")
        return ""

    data = response.json()

    try:
        words = (
            data["results"]["channels"][0]["alternatives"][0].get("words", [])
        )
    except (KeyError, IndexError):
        try:
            return data["results"]["channels"][0]["alternatives"][0]["transcript"]
        except Exception:
            return ""

    if not words:
        return ""

    # ── build diarized transcript ─────────────────────────────────────────────
    lines: List[str] = []
    current_speaker: Optional[int] = None
    current_words: List[str] = []

    for word in words:
        speaker_id = word.get("speaker", 0)
        punct_word = word.get("punctuated_word", word.get("word", ""))

        if speaker_id != current_speaker:
            if current_words and current_speaker is not None:
                label = "Agent" if current_speaker == 0 else "Customer"
                lines.append(f"{label}: {' '.join(current_words)}")
            current_speaker = speaker_id
            current_words = [punct_word]
        else:
            current_words.append(punct_word)

    if current_words and current_speaker is not None:
        label = "Agent" if current_speaker == 0 else "Customer"
        lines.append(f"{label}: {' '.join(current_words)}")

    transcript = "\n".join(lines)
    print(f"[transcribe] done — {len(lines)} speaker turns, {len(transcript)} chars")
    return transcript


# =============================================================================
# Extraction via Groq / Llama
# =============================================================================

EXTRACTION_PROMPT_TEMPLATE = """
You are an expert sales analyst at Inbox Infotech.
Analyze the following sales call transcript and extract structured information.

Inbox Infotech services:
- AI / ML Development
- IoT Solutions
- CRM / ERP Systems
- Mobile App Development
- Web Development
- Cloud & DevOps
- API Integration
- Automation Solutions

Transcript:
{transcript}

Return ONLY valid JSON (no markdown, no explanation) with this exact structure:
{{
    "pain_points": ["list each specific pain point the customer mentioned"],
    "budget": "budget range or 'not mentioned'",
    "requirements": ["specific technical or business requirements mentioned"],
    "timeline": "urgency or timeline the customer mentioned, or 'not mentioned'",
    "decision_maker": true or false,
    "industry": "customer company industry or 'unknown'",
    "intent_level": "high or medium or low",
    "lead_score": integer 1 to 10,
    "lead_category": "HOT or WARM or COLD",
    "summary": "2-3 sentence factual summary of what was discussed",
    "next_action": "specific, concrete recommended next step for the sales team",
    "interested_services": ["which Inbox Infotech services the customer showed interest in"]
}}

Scoring rules — apply strictly:
HOT  (score 8–10): clear interest + budget indicator + is/involves decision maker + some urgency
WARM (score 4–7): interested but vague on budget/timeline, or not the decision maker
COLD (score 1–3): no interest, declined, hung up early, wrong number, voicemail only
"""

async def extract_insights(call_sid: str, transcript: str) -> Dict[str, Any]:
    """
    Sends transcript to Groq/Llama for structured extraction.
    Falls back to a COLD record if transcript is empty or extraction fails.
    """
    if not transcript or not transcript.strip():
        print(f"[extract] empty transcript for {call_sid} — marking COLD")
        return {
            "pain_points": [],
            "budget": "not mentioned",
            "requirements": [],
            "timeline": "not mentioned",
            "decision_maker": False,
            "industry": "unknown",
            "intent_level": "low",
            "lead_score": 1,
            "lead_category": "COLD",
            "summary": "No transcribable audio — call may have been voicemail or silent.",
            "next_action": "Retry call at a different time.",
            "interested_services": [],
        }

    print(f"[extract] sending to Groq for {call_sid}...")

    try:
        response = await groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {
                    "role": "system",
                    "content": "You are a sales analyst. Always respond with valid JSON only. Your entire response must be a single JSON object.",
                },
                {
                    "role": "user",
                    "content": EXTRACTION_PROMPT_TEMPLATE.format(transcript=transcript),
                },
            ],
            response_format={"type": "json_object"},
            temperature=0.1,
            max_tokens=800,
        )

        raw = response.choices[0].message.content
        extracted = json.loads(raw)

        extracted.setdefault("lead_category", "COLD")
        extracted.setdefault("lead_score", 1)
        extracted.setdefault("summary", "")
        extracted.setdefault("next_action", "")
        extracted.setdefault("pain_points", [])
        extracted.setdefault("requirements", [])
        extracted.setdefault("interested_services", [])

        extracted["lead_score"] = max(1, min(10, int(extracted.get("lead_score", 1))))

        cat = extracted["lead_category"].upper()
        extracted["lead_category"] = cat if cat in ("HOT", "WARM", "COLD") else "COLD"

        print(
            f"[extract] done — category={extracted['lead_category']} "
            f"score={extracted['lead_score']} intent={extracted.get('intent_level')}"
        )
        return extracted

    except json.JSONDecodeError as e:
        print(f"[extract] JSON parse error: {e}")
    except Exception as e:
        print(f"[extract] Groq error: {e}")

    return {
        "pain_points": [],
        "budget": "not mentioned",
        "requirements": [],
        "timeline": "not mentioned",
        "decision_maker": False,
        "industry": "unknown",
        "intent_level": "low",
        "lead_score": 1,
        "lead_category": "COLD",
        "summary": "Extraction failed — review transcript manually.",
        "next_action": "Manual review required.",
        "interested_services": [],
    }


# =============================================================================
# Storage (JSON lines → swap with PostgreSQL later)
# =============================================================================

async def save_record(record: Dict[str, Any]) -> None:
    """Appends one JSON record per line to calls.json."""
    try:
        with open(CALLS_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
        print(f"[storage] saved {record['call_sid']}")
    except Exception as e:
        print(f"[storage] write error: {e}")


def load_all_records() -> List[Dict[str, Any]]:
    """Reads all records from calls.json into a list."""
    records: List[Dict[str, Any]] = []
    try:
        with open(CALLS_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        records.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
    except FileNotFoundError:
        pass
    return records


# =============================================================================
# HOT lead Make.com trigger
# =============================================================================

async def trigger_hot_lead_workflow(
    call_sid: str,
    extracted: Dict[str, Any],
    meta: Dict[str, Any],
) -> None:
    """POSTs to Make.com webhook when lead_category == HOT."""
    if not MAKE_HOT_LEAD_WEBHOOK:
        print("[make] MAKE_HOT_LEAD_WEBHOOK not set — skipping")
        return

    payload = {
        "call_sid":            call_sid,
        "source":              meta.get("source", "unknown"),
        "to_number":           meta.get("to_number"),
        "caller_name":         meta.get("caller_name"),
        "lead_category":       extracted.get("lead_category"),
        "lead_score":          extracted.get("lead_score"),
        "intent_level":        extracted.get("intent_level"),
        "summary":             extracted.get("summary"),
        "pain_points":         extracted.get("pain_points"),
        "requirements":        extracted.get("requirements"),
        "interested_services": extracted.get("interested_services"),
        "next_action":         extracted.get("next_action"),
        "budget":              extracted.get("budget"),
        "timeline":            extracted.get("timeline"),
        "campaign_id":         meta.get("campaign_id"),
        "agent_id":            meta.get("agent_id"),
        "duration_sec":        meta.get("duration_sec"),
        "recording_url":       meta.get("recording_url"),
    }

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(MAKE_HOT_LEAD_WEBHOOK, json=payload)
        print(f"[make] HOT lead webhook → {resp.status_code} for {call_sid}")
    except Exception as e:
        print(f"[make] webhook error: {e}")


# =============================================================================
# Full pipeline — called by background task (shared by CallHippo + Twilio)
# =============================================================================

async def process_recording_pipeline(
    call_sid: str,
    recording_url: str,
    call_meta: Dict[str, Any],
) -> None:
    """
    Shared post-call pipeline for both CallHippo and Twilio:
    download → transcribe → extract → store → HOT trigger

    call_meta["source"] tells you which provider triggered this run.
    """
    source = call_meta.get("source", "unknown")
    print(f"\n[pipeline] starting for {call_sid} (source={source})")

    # ── Step 1: download MP3 ──────────────────────────────────────────────────
    try:
        print("[pipeline] downloading recording…")
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.get(recording_url)
            resp.raise_for_status()
            audio_bytes = resp.content
        print(f"[pipeline] downloaded {len(audio_bytes):,} bytes")
    except Exception as e:
        print(f"[pipeline] download failed: {e}")
        return

    # ── Step 2: transcribe ────────────────────────────────────────────────────
    transcript = await transcribe_recording(audio_bytes)

    _transcript_store[call_sid] = [
        {"role": line.split(":")[0].strip(), "text": ":".join(line.split(":")[1:]).strip()}
        for line in transcript.splitlines()
        if ":" in line
    ]

    # ── Step 3: extract insights ──────────────────────────────────────────────
    extracted = await extract_insights(call_sid, transcript)

    # ── Step 4: save record ───────────────────────────────────────────────────
    record = {
        "call_sid":   call_sid,
        "meta":       call_meta,
        "transcript": transcript,
        "extracted":  extracted,
        "timestamp":  datetime.utcnow().isoformat(),
    }
    await save_record(record)

    # ── Step 5: trigger Make.com if HOT ──────────────────────────────────────
    if extracted.get("lead_category") == "HOT":
        print("[pipeline] HOT lead — triggering Make.com")
        await trigger_hot_lead_workflow(call_sid, extracted, call_meta)

    print(f"[pipeline] complete for {call_sid} ✓\n")


# =============================================================================
# POST /extract — internal (called by server.py after browser sessions)
# =============================================================================

@app.post("/extract")
async def extract_from_browser_session(
    request: Request,
    background_tasks: BackgroundTasks,
):
    """
    Called internally by server.py when a browser-based voice session ends.
    Expects: {"call_sid": str, "transcript": [{"role": str, "text": str}]}
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    call_sid        = body.get("call_sid", f"browser_{datetime.utcnow().timestamp()}")
    transcript_list: List[Dict[str, str]] = body.get("transcript", [])

    if not transcript_list:
        return JSONResponse({"status": "skipped", "reason": "empty transcript"})

    transcript_str = "\n".join(
        f"{t.get('role','?')}: {t.get('text','')}" for t in transcript_list
    )

    _transcript_store[call_sid] = transcript_list

    async def _run():
        extracted = await extract_insights(call_sid, transcript_str)
        meta = {
            "call_sid":    call_sid,
            "source":      "browser",
            "received_at": datetime.utcnow().isoformat(),
        }
        record = {
            "call_sid":   call_sid,
            "meta":       meta,
            "transcript": transcript_str,
            "extracted":  extracted,
            "timestamp":  datetime.utcnow().isoformat(),
        }
        await save_record(record)
        if extracted.get("lead_category") == "HOT":
            await trigger_hot_lead_workflow(call_sid, extracted, meta)

    background_tasks.add_task(_run)
    return JSONResponse({"status": "queued", "call_sid": call_sid})


# =============================================================================
# GET /api/leads
# =============================================================================

@app.get("/api/leads")
async def get_leads(
    category: Optional[str] = None,
    source: Optional[str] = None,      # filter: twilio / callhippo / browser
    limit: int = 100,
):
    """
    Returns all stored call records, newest first.
    Optional filters: ?category=HOT  ?source=twilio
    """
    records = load_all_records()

    leads = []
    for r in records:
        extracted = r.get("extracted", {})
        meta      = r.get("meta", {})
        cat       = extracted.get("lead_category", "COLD")
        src       = meta.get("source", "unknown")

        if category and cat.upper() != category.upper():
            continue
        if source and src.lower() != source.lower():
            continue

        leads.append({
            "call_sid":            r.get("call_sid"),
            "timestamp":           r.get("timestamp"),
            "source":              src,
            "to_number":           meta.get("to_number"),
            "caller_name":         meta.get("caller_name", ""),
            "duration_sec":        meta.get("duration_sec", 0),
            "campaign_id":         meta.get("campaign_id", ""),
            "lead_category":       cat,
            "lead_score":          extracted.get("lead_score", 1),
            "intent_level":        extracted.get("intent_level", "low"),
            "summary":             extracted.get("summary", ""),
            "next_action":         extracted.get("next_action", ""),
            "pain_points":         extracted.get("pain_points", []),
            "interested_services": extracted.get("interested_services", []),
            "recording_url":       meta.get("recording_url", ""),
        })

    leads.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
    return JSONResponse({"total": len(leads), "leads": leads[:limit]})


# =============================================================================
# GET /api/stats
# =============================================================================

@app.get("/api/stats")
async def get_stats():
    """Returns aggregated stats for the dashboard header cards."""
    records = load_all_records()
    total = len(records)

    hot  = sum(1 for r in records if r.get("extracted", {}).get("lead_category") == "HOT")
    warm = sum(1 for r in records if r.get("extracted", {}).get("lead_category") == "WARM")
    cold = sum(1 for r in records if r.get("extracted", {}).get("lead_category") == "COLD")

    twilio_calls    = sum(1 for r in records if r.get("meta", {}).get("source") == "twilio")
    callhippo_calls = sum(1 for r in records if r.get("meta", {}).get("source") == "callhippo")

    avg_score = (
        sum(r.get("extracted", {}).get("lead_score", 0) for r in records) / total
        if total else 0
    )

    total_duration  = sum(r.get("meta", {}).get("duration_sec", 0) for r in records)
    conversion_rate = round((hot / total * 100), 1) if total else 0

    return JSONResponse({
        "total_calls":        total,
        "twilio_calls":       twilio_calls,
        "callhippo_calls":    callhippo_calls,
        "hot":                hot,
        "warm":               warm,
        "cold":               cold,
        "avg_lead_score":     round(avg_score, 1),
        "total_duration_sec": total_duration,
        "conversion_rate":    conversion_rate,
    })


# =============================================================================
# GET /api/transcript/{call_sid}
# =============================================================================

@app.get("/api/transcript/{call_sid}")
async def get_transcript(call_sid: str):
    """Returns the diarized transcript for a specific call."""
    if call_sid in _transcript_store:
        return JSONResponse({
            "call_sid":   call_sid,
            "transcript": _transcript_store[call_sid],
            "source":     "memory",
        })

    for record in load_all_records():
        if record.get("call_sid") == call_sid:
            raw = record.get("transcript", "")
            parsed = [
                {
                    "role": line.split(":")[0].strip(),
                    "text": ":".join(line.split(":")[1:]).strip(),
                }
                for line in raw.splitlines()
                if ":" in line
            ]
            return JSONResponse({
                "call_sid":   call_sid,
                "transcript": parsed,
                "source":     "disk",
            })

    raise HTTPException(status_code=404, detail=f"No transcript for call_sid={call_sid}")


# =============================================================================
# Health check
# =============================================================================

@app.get("/health")
async def health():
    records = load_all_records()
    return JSONResponse({
        "status":       "ok",
        "calls_stored": len(records),
        "timestamp":    datetime.utcnow().isoformat(),
    })


# =============================================================================
# Entry point
# =============================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("call_handler:app", host="0.0.0.0", port=8000, reload=True)