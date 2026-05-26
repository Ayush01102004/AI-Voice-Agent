"""
call_handler.py
FastAPI server — Twilio webhook receiver + lead pipeline

Endpoints:
  POST /twilio-webhook       ← Twilio posts here after every call ends
  GET  /api/leads            ← lead list
  GET  /api/stats            ← summary stats
  GET  /api/transcript/{sid} ← transcript viewer
  GET  /health               ← health check

Run:
  uvicorn call_handler:app --host 0.0.0.0 --port 8000 --reload
"""

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

# ── env ───────────────────────────────────────────────────────

load_dotenv()

DEEPGRAM_API_KEY     = os.getenv("DEEPGRAM_API_KEY", "")
GROQ_API_KEY         = os.getenv("GROQ_API_KEY", "")
MAKE_HOT_LEAD_WEBHOOK = os.getenv("MAKE_HOT_LEAD_WEBHOOK", "")

if not DEEPGRAM_API_KEY:
    raise ValueError("DEEPGRAM_API_KEY missing from .env")
if not GROQ_API_KEY:
    raise ValueError("GROQ_API_KEY missing from .env")

CALLS_FILE  = "calls.json"
groq_client = AsyncGroq(api_key=GROQ_API_KEY)

# ── app ───────────────────────────────────────────────────────

app = FastAPI(title="Inbox Infotech — Call Handler", version="2.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

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

    print(f"[twilio] call_sid={call_sid} status={status} duration={duration}s")

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
        "received_at":   datetime.utcnow().isoformat(),
    }

    background_tasks.add_task(process_recording_pipeline, call_sid, recording_url, call_meta)
    print(f"[twilio] queued pipeline for {call_sid}")
    return JSONResponse({"status": "received", "call_sid": call_sid})


# ── transcription ─────────────────────────────────────────────

async def transcribe_recording(audio_bytes: bytes) -> str:
    print(f"[transcribe] sending {len(audio_bytes):,} bytes")

    async with httpx.AsyncClient(timeout=120) as client:
        response = await client.post(
            "https://api.deepgram.com/v1/listen"
            "?model=nova-3&punctuate=true&diarize=true&smart_format=true&utterances=true",
            headers={"Authorization": f"Token {DEEPGRAM_API_KEY}", "Content-Type": "audio/mp3"},
            content=audio_bytes,
        )

    if response.status_code != 200:
        print(f"[transcribe] failed {response.status_code}")
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
    current_speaker  = None
    current_words: List[str] = []

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

Scoring rules — apply strictly:
HOT  (score 8-10): clear interest + budget indicator + decision maker + urgency
WARM (score 4-7) : interested but vague on budget/timeline, or not decision maker
COLD (score 1-3) : no interest, declined, hung up, wrong number, voicemail
"""

_COLD_FALLBACK = {
    "pain_points": [], "budget": "not mentioned", "requirements": [],
    "timeline": "not mentioned", "decision_maker": False, "industry": "unknown",
    "intent_level": "low", "lead_score": 1, "lead_category": "COLD",
    "summary": "No transcript available.", "next_action": "Retry call later.",
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

        # sanitise LLM output
        extracted.setdefault("pain_points", [])
        extracted.setdefault("requirements", [])
        extracted.setdefault("interested_services", [])
        extracted.setdefault("lead_score", 1)
        extracted.setdefault("lead_category", "COLD")
        extracted["lead_score"] = max(1, min(10, int(extracted["lead_score"])))
        cat = extracted["lead_category"].upper()
        extracted["lead_category"] = cat if cat in ("HOT", "WARM", "COLD") else "COLD"

        print(f"[extract] {call_sid} → {extracted['lead_category']} score={extracted['lead_score']}")
        return extracted

    except Exception as e:
        print(f"[extract] failed: {e}")
        return {**_COLD_FALLBACK, "summary": "Extraction failed.", "next_action": "Manual review required."}


# ── storage ───────────────────────────────────────────────────

async def save_record(record: Dict[str, Any]) -> None:
    try:
        with open(CALLS_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
        print(f"[storage] saved {record['call_sid']}")
    except Exception as e:
        print(f"[storage] failed: {e}")


def load_all_records() -> List[Dict[str, Any]]:
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


# ── Make.com trigger ──────────────────────────────────────────

async def trigger_hot_lead_workflow(call_sid: str, extracted: Dict[str, Any], meta: Dict[str, Any]) -> None:
    if not MAKE_HOT_LEAD_WEBHOOK:
        print("[make] webhook not configured")
        return

    payload = {
        "call_sid":            call_sid,
        "to_number":           meta.get("to_number"),
        "duration_sec":        meta.get("duration_sec"),
        "recording_url":       meta.get("recording_url"),
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
            resp = await client.post(MAKE_HOT_LEAD_WEBHOOK, json=payload)
        print(f"[make] {resp.status_code} for {call_sid}")
    except Exception as e:
        print(f"[make] failed: {e}")


# ── pipeline ──────────────────────────────────────────────────

async def process_recording_pipeline(call_sid: str, recording_url: str, call_meta: Dict[str, Any]) -> None:
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
        "call_sid":  call_sid,
        "meta":      call_meta,
        "transcript": transcript,
        "extracted": extracted,
        "timestamp": datetime.utcnow().isoformat(),
    })

    if extracted.get("lead_category") == "HOT":
        print(f"[pipeline] HOT lead — triggering Make.com")
        await trigger_hot_lead_workflow(call_sid, extracted, call_meta)

    print(f"[pipeline] completed {call_sid}")


# ── GET /api/leads ────────────────────────────────────────────

@app.get("/api/leads")
async def get_leads(category: Optional[str] = None, limit: int = 100):
    records = load_all_records()
    leads = []

    for r in records:
        extracted = r.get("extracted", {})
        meta      = r.get("meta", {})
        cat       = extracted.get("lead_category", "COLD")

        if category and cat.upper() != category.upper():
            continue

        leads.append({
            "call_sid":      r.get("call_sid"),
            "timestamp":     r.get("timestamp"),
            "to_number":     meta.get("to_number"),
            "duration_sec":  meta.get("duration_sec"),
            "lead_category": cat,
            "lead_score":    extracted.get("lead_score", 1),
            "intent_level":  extracted.get("intent_level", "low"),
            "summary":       extracted.get("summary", ""),
            "next_action":   extracted.get("next_action", ""),
            "pain_points":   extracted.get("pain_points", []),
            "interested_services": extracted.get("interested_services", []),
            "recording_url": meta.get("recording_url", ""),
        })

    leads.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
    return JSONResponse({"total": len(leads), "leads": leads[:limit]})


# ── GET /api/stats ────────────────────────────────────────────

@app.get("/api/stats")
async def get_stats():
    records = load_all_records()
    total   = len(records)

    hot  = sum(1 for r in records if r.get("extracted", {}).get("lead_category") == "HOT")
    warm = sum(1 for r in records if r.get("extracted", {}).get("lead_category") == "WARM")
    cold = sum(1 for r in records if r.get("extracted", {}).get("lead_category") == "COLD")

    avg_score = (
        sum(r.get("extracted", {}).get("lead_score", 0) for r in records) / total
        if total else 0
    )

    return JSONResponse({
        "total_calls":    total,
        "hot":            hot,
        "warm":           warm,
        "cold":           cold,
        "avg_lead_score": round(avg_score, 1),
        "conversion_rate": round(hot / total * 100, 1) if total else 0,
    })


# ── GET /api/transcript/{call_sid} ────────────────────────────

@app.get("/api/transcript/{call_sid}")
async def get_transcript(call_sid: str):
    for record in load_all_records():
        if record.get("call_sid") == call_sid:
            raw = record.get("transcript", "")
            parsed = [
                {"role": line.split(":")[0].strip(), "text": ":".join(line.split(":")[1:]).strip()}
                for line in raw.splitlines() if ":" in line
            ]
            return JSONResponse({"call_sid": call_sid, "transcript": parsed})

    raise HTTPException(status_code=404, detail=f"No transcript for {call_sid}")


# ── GET /health ───────────────────────────────────────────────

@app.get("/health")
async def health():
    return JSONResponse({
        "status":       "ok",
        "calls_stored": len(load_all_records()),
        "timestamp":    datetime.utcnow().isoformat(),
    })


# ── entrypoint ────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("call_handler:app", host="0.0.0.0", port=8000, reload=True)