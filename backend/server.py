"""
Deepgram Voice Agent — Telnyx Media Streams
Python 3.10+ | Deepgram SDK v5+ | aiohttp v3+

Endpoints:
  POST /telnyx/voice  — TeXML webhook
  GET  /ws/telnyx     — Media Streams WebSocket
  GET  /health        — Health check
  GET  /ping          — Liveness probe
"""

import asyncio
import base64
import collections
import copy
import json
import logging
import math
import os
import queue as sync_queue
import threading
import time
from enum import Enum
from typing import Any, Callable, Dict, List, Optional

import aiohttp
from aiohttp import web
from deepgram import DeepgramClient
from deepgram.agent.v1.types import AgentV1SendFunctionCallResponse
from dotenv import load_dotenv

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
log = logging.getLogger("voice_agent")

# ── Env ───────────────────────────────────────────────────────────────────────

load_dotenv()

DEEPGRAM_API_KEY  = os.getenv("DEEPGRAM_API_KEY") or ""
CALL_HANDLER_URL  = os.getenv("CALL_HANDLER_URL", "http://localhost:8000").rstrip("/")
PORT              = int(os.getenv("PORT", "5002"))
TELNYX_PUBLIC_KEY = os.getenv("TELNYX_PUBLIC_KEY", "")

if not DEEPGRAM_API_KEY:
    raise ValueError("DEEPGRAM_API_KEY missing")

# ── Constants ─────────────────────────────────────────────────────────────────

KEEPALIVE_INTERVAL_S      = 8.0
FRAME_DURATION_S          = 0.020
SILENCE_THRESHOLD         = 80.0
GHOST_CALL_TIMEOUT_S      = 10.0
AMD_SPEECH_TIMEOUT_S      = 4.0
AMD_MAX_WAIT_S            = 8.0
WARNING_DURATION_S        = 4 * 60
MAX_CALL_DURATION_S       = 6 * 60
RECONNECT_DELAYS: List[float] = [0.0, 2.0, 5.0]
HISTORY_MAX_TURNS         = 30
HISTORY_REPLAY_TURNS      = 8
SEND_QUEUE_MAXSIZE        = 200
CONFIG_FETCH_RETRIES      = 3
CONFIG_FETCH_BACKOFF_S    = 1.0

VOICEMAIL_PHRASES = frozenset([
    "leave a message", "leave your message", "after the tone", "after the beep",
    "not available", "please record", "voicemail", "voice mail",
])

# ── Enums ─────────────────────────────────────────────────────────────────────

class CallState(str, Enum):
    VERIFY_IDENTITY  = "VERIFY_IDENTITY"
    PERMISSION_CHECK = "PERMISSION_CHECK"
    DISCOVERY        = "DISCOVERY"
    QUALIFICATION    = "QUALIFICATION"
    CLOSING          = "CLOSING"

class CallType(str, Enum):
    UNKNOWN   = "UNKNOWN"
    HUMAN     = "HUMAN"
    VOICEMAIL = "VOICEMAIL"
    IVR       = "IVR"

class CallOutcome(str, Enum):
    INTERESTED         = "INTERESTED"
    NOT_INTERESTED     = "NOT_INTERESTED"
    CALLBACK_REQUESTED = "CALLBACK_REQUESTED"
    VOICEMAIL          = "VOICEMAIL"
    WRONG_NUMBER       = "WRONG_NUMBER"
    DO_NOT_CALL        = "DO_NOT_CALL"
    EXISTING_CUSTOMER  = "EXISTING_CUSTOMER"
    NO_RESPONSE        = "NO_RESPONSE"
    IVR                = "IVR"
    CALL_DROPPED       = "CALL_DROPPED"

# ── Deepgram client ───────────────────────────────────────────────────────────

deepgram_client = DeepgramClient(api_key=DEEPGRAM_API_KEY)

# ── μ-law RMS ─────────────────────────────────────────────────────────────────

def _build_ulaw_table() -> List[int]:
    table = []
    for u in range(256):
        u    = ~u & 0xFF
        sign = u & 0x80
        exp  = (u >> 4) & 0x07
        mant = u & 0x0F
        s    = ((mant << 3) + 0x84) << exp
        s   -= 0x84
        table.append(-s if sign else s)
    return table

_ULAW_TABLE = _build_ulaw_table()

def ulaw_rms(data: bytes) -> float:
    if not data:
        return 0.0
    return math.sqrt(sum(_ULAW_TABLE[b] ** 2 for b in data) / len(data))

# ── LLM function definitions ──────────────────────────────────────────────────

FUNCTIONS: List[Dict] = [
    {
        "name": "end_conversation",
        "description": (
            "End the call when user says goodbye, is unresponsive, "
            "requests no contact, is wrong number, or conversation is complete."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "reason":  {"type": "string"},
                "outcome": {"type": "string", "enum": [o.value for o in CallOutcome]},
            },
            "required": ["reason", "outcome"],
        },
    },
    {
        "name": "update_lead_facts",
        "description": (
            "Call whenever new info is learned: company, budget, timeline, "
            "pain points, interested services. Partial updates OK."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "company":             {"type": "string"},
                "budget":              {"type": "string"},
                "timeline":            {"type": "string"},
                "pain_points":         {"type": "array", "items": {"type": "string"}},
                "interested_services": {"type": "array", "items": {"type": "string"}},
            },
            "required": [],
        },
    },
    {
        "name": "update_call_state",
        "description": "Advance the internal call stage.",
        "parameters": {
            "type": "object",
            "properties": {
                "state": {"type": "string", "enum": [s.value for s in CallState]},
            },
            "required": ["state"],
        },
    },
]

# ── System prompt ─────────────────────────────────────────────────────────────

_BASE_PROMPT = """
You are a friendly outbound sales caller from Inbox Infotech. Agent name: {agent_name}.
Speak naturally on a real-time phone call. Keep replies to 1-2 sentences. Warm, not pushy.

SERVICES: AI/ML | IoT | CRM/ERP | Mobile & Web | Cloud & DevOps | API Integration | Automation

CALL STAGES — follow in order, never skip:

VERIFY_IDENTITY:
  - Known lead: "Hello, may I please speak with {lead_name}?"
  - Unknown: "Hello, is this a good time to speak with you?"
  - Wrong person → end_conversation(WRONG_NUMBER)
  - Confirmed → move to PERMISSION_CHECK

PERMISSION_CHECK:
  - "Hi {lead_name}, this is {agent_name} from Inbox Infotech — did I catch you at a bad time?"
  - Busy → end_conversation(CALLBACK_REQUESTED)
  - DNC → end_conversation(DO_NOT_CALL)
  - Willing → move to DISCOVERY

DISCOVERY:
  - Ask one open question: "What's the biggest tech challenge your team is dealing with right now?"
  - Listen. Move to QUALIFICATION after their answer.

QUALIFICATION:
  - One question at a time: timeline, budget, decision authority.
  - Good fit → move to CLOSING
  - No fit → end_conversation(NOT_INTERESTED)

CLOSING:
  - Propose a short discovery call or demo.
  - Agree → end_conversation(INTERESTED)
  - Decline → end_conversation(NOT_INTERESTED)

RULES:
- After any reply revealing company/budget/timeline/pain points/services → call update_lead_facts immediately.
- After two unresponsive prompts → end_conversation(NO_RESPONSE).
""".strip()

def build_system_prompt(agent_name: str, lead_name: Optional[str]) -> str:
    return _BASE_PROMPT.format(
        agent_name=agent_name,
        lead_name=lead_name or "the decision maker",
    )

def build_greeting(lead_name: Optional[str]) -> str:
    if lead_name:
        return f"Hello, may I please speak with {lead_name}?"
    return "Hello, is this a good time to speak with the person who handles technology decisions?"

def build_dg_settings(system_prompt: str, agent_name: str, lead_name: Optional[str]) -> Dict:
    return {
        "type": "Settings",
        "audio": {
            "input":  {"encoding": "mulaw", "sample_rate": 8000},
            "output": {"encoding": "mulaw", "sample_rate": 8000, "container": "none"},
        },
        "agent": {
            "listen":   {"provider": {"type": "deepgram", "model": "nova-3"}},
            "think":    {
                "provider":  {"type": "open_ai", "model": "gpt-4o-mini"},
                "prompt":    system_prompt,
                "functions": FUNCTIONS,
            },
            "speak":    {"provider": {"type": "deepgram", "model": "aura-2-helena-en"}},
            "greeting": build_greeting(lead_name),
        },
    }

def build_recovery_settings(s: "Session", base_settings: Dict) -> Dict:
    facts   = s.facts
    history = list(s.history)
    replay  = history[-min(HISTORY_REPLAY_TURNS, len(history)):]
    turns   = "\n".join(f"  {t['role'].upper()}: {t['text']}" for t in replay) or "  (none)"
    pain    = ", ".join(facts.get("pain_points") or [])          or "none"
    svcs    = ", ".join(facts.get("interested_services") or [])  or "none"

    recovery = f"""

--- RECONNECT RECOVERY ---
You were briefly disconnected and have reconnected to the same call.
- Do NOT reintroduce yourself.
- Do NOT restart from VERIFY_IDENTITY.
- Resume naturally from state: {s.call_state}

Lead Facts:
  Name     : {facts.get('lead_name') or 'unknown'}
  Company  : {facts.get('company')   or 'unknown'}
  Budget   : {facts.get('budget')    or 'unknown'}
  Timeline : {facts.get('timeline')  or 'unknown'}
  Pain     : {pain}
  Services : {svcs}

Last {len(replay)} turns (most recent last):
{turns}
--- END RECOVERY ---"""

    recovered = copy.deepcopy(base_settings)
    recovered["agent"]["think"]["prompt"] += recovery
    recovered["agent"].pop("greeting", None)
    return recovered

# ── Session dataclass ─────────────────────────────────────────────────────────

class Session:
    """
    All mutable state for one call, keyed by call_sid.
    Lock discipline: acquire `lock` before reading/writing any field
    that is touched from both the asyncio loop and listener thread.
    Fields only ever accessed from a single context need no lock.
    """

    __slots__ = (
        # identity
        "call_sid", "stream_sid",
        # deepgram
        "_cm", "agent_conn", "dg_lock",
        # queues
        "send_q", "audio_queue",
        # tasks (asyncio, cancelled on cleanup)
        "audio_sender_task", "keepalive_task", "listener",
        "duration_task", "amd_task", "reconnect_lock",
        # barge-in / audio gen
        "agent_speaking", "generation_id",
        # silence / ghost
        "silence_seconds", "ghost_fired",
        # AMD
        "call_type", "amd_speech_start", "amd_done",
        # call state machine
        "call_state",
        # graceful hangup
        "pending_hangup",
        # outcome
        "outcome",
        # duration
        "call_start_time", "warning_sent",
        # memory
        "history", "facts",
        # settings (for reconnect)
        "dg_settings",
        # loop ref
        "loop",
        # thread lock
        "lock",
    )

    def __init__(self) -> None:
        self.call_sid        = ""
        self.stream_sid      = ""
        self._cm             = None
        self.agent_conn      = None
        self.dg_lock         = threading.Lock()
        self.send_q: Optional[sync_queue.Queue] = None
        self.audio_queue: Optional[asyncio.Queue] = None
        self.audio_sender_task = None
        self.keepalive_task    = None
        self.listener          = None
        self.duration_task     = None
        self.amd_task          = None
        self.reconnect_lock: Optional[asyncio.Lock] = None
        self.agent_speaking  = False
        self.generation_id   = 0
        self.silence_seconds = 0.0
        self.ghost_fired     = False
        self.call_type       = CallType.UNKNOWN
        self.amd_speech_start: Optional[float] = None
        self.amd_done        = False
        self.call_state      = CallState.VERIFY_IDENTITY
        self.pending_hangup  = False
        self.outcome: Optional[str] = None
        self.call_start_time: Optional[float] = None
        self.warning_sent    = False
        self.history: collections.deque = collections.deque(maxlen=HISTORY_MAX_TURNS)
        self.facts: Dict[str, Any] = {
            "lead_name": None, "company": None,
            "budget": None,    "timeline": None,
            "pain_points": [], "interested_services": [],
        }
        self.dg_settings: Dict = {}
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.lock = threading.Lock()

# ── Session registry (keyed by call_sid) ─────────────────────────────────────

_sessions: Dict[str, Session] = {}

# ── Structured logging ────────────────────────────────────────────────────────

def log_outcome(call_sid: str, outcome: str, reason: str) -> None:
    log.info(json.dumps({
        "event": "call_outcome", "call_sid": call_sid,
        "outcome": outcome, "reason": reason, "ts": time.time(),
    }))

def clog(call_sid: str, msg: str) -> None:
    log.info("[%s] %s", call_sid, msg)

# ── Async bridge utility ──────────────────────────────────────────────────────

def run_async(coro, loop: asyncio.AbstractEventLoop) -> None:
    """Fire-and-forget coroutine from any thread."""
    asyncio.run_coroutine_threadsafe(coro, loop)

# ── WS helpers ────────────────────────────────────────────────────────────────

def ws_open(ws: web.WebSocketResponse) -> bool:
    try:
        return not ws.closed
    except Exception:
        return False

async def telnyx_clear(ws: web.WebSocketResponse, stream_sid: str) -> None:
    if ws_open(ws) and stream_sid:
        try:
            await ws.send_str(json.dumps({"event": "clear", "streamSid": stream_sid}))
        except Exception:
            pass

async def send_audio_to_telnyx(ws: web.WebSocketResponse, audio: bytes, stream_sid: str) -> None:
    if not ws_open(ws):
        return
    try:
        await ws.send_str(json.dumps({
            "event": "media", "streamSid": stream_sid,
            "media": {"payload": base64.b64encode(audio).decode()},
        }))
    except Exception as e:
        log.warning("audio→telnyx: %s", e)

# ── Audio queue helpers ───────────────────────────────────────────────────────

def enqueue_audio(q: sync_queue.Queue, raw: bytes) -> None:
    """Drop-oldest-frame strategy under backpressure."""
    try:
        q.put_nowait(raw)
    except sync_queue.Full:
        try:
            q.get_nowait()
        except sync_queue.Empty:
            pass
        try:
            q.put_nowait(raw)
        except sync_queue.Full:
            pass

async def drain_audio_queue(q: asyncio.Queue) -> None:
    while not q.empty():
        try:
            q.get_nowait()
        except asyncio.QueueEmpty:
            break

# ── Deepgram CM (thread-safe) ─────────────────────────────────────────────────

def _dg_connect(lock: threading.Lock):
    with lock:
        cm     = deepgram_client.agent.v1.connect()
        socket = cm.__enter__()
        return cm, socket

def _dg_close(cm, lock: threading.Lock) -> None:
    with lock:
        try:
            cm.__exit__(None, None, None)
        except Exception as e:
            log.warning("dg_close: %s", e)

# ── Config fetch ──────────────────────────────────────────────────────────────

_config_cache: Dict[str, Any] = {}
_config_cache_ts: float = 0.0
_CONFIG_CACHE_TTL_S = 60.0

async def fetch_agent_config(force: bool = False) -> Dict[str, Any]:
    global _config_cache, _config_cache_ts
    now = time.monotonic()
    if not force and (now - _config_cache_ts) < _CONFIG_CACHE_TTL_S and _config_cache:
        return _config_cache

    for attempt in range(CONFIG_FETCH_RETRIES):
        if attempt:
            await asyncio.sleep(CONFIG_FETCH_BACKOFF_S * attempt)
        try:
            async with aiohttp.ClientSession() as sess:
                async with sess.get(
                    f"{CALL_HANDLER_URL}/api/config",
                    timeout=aiohttp.ClientTimeout(total=5),
                ) as resp:
                    if resp.status == 200:
                        _config_cache    = await resp.json()
                        _config_cache_ts = now
                        return _config_cache
                    log.warning("config HTTP %s attempt %d", resp.status, attempt + 1)
        except Exception as e:
            log.warning("config attempt %d: %s", attempt + 1, e)

    log.warning("config fetch failed — using cache or defaults")
    return _config_cache or {}

# ── Background tasks ──────────────────────────────────────────────────────────

async def keepalive_loop(s: Session) -> None:
    try:
        while True:
            await asyncio.sleep(KEEPALIVE_INTERVAL_S)
            try:
                await asyncio.to_thread(
                    s.agent_conn.send, json.dumps({"type": "KeepAlive"})
                )
            except Exception as e:
                clog(s.call_sid, f"keepalive failed: {e}")
                break
    except asyncio.CancelledError:
        pass

async def ghost_call_hangup(ws: web.WebSocketResponse, s: Session) -> None:
    with s.lock:
        if s.ghost_fired:
            return
        s.ghost_fired = True
    clog(s.call_sid, f"ghost call — {GHOST_CALL_TIMEOUT_S}s silence")
    log_outcome(s.call_sid, CallOutcome.NO_RESPONSE, "ghost call silence timeout")
    await telnyx_clear(ws, s.stream_sid)
    await ws.close()

async def amd_max_wait_guard(ws: web.WebSocketResponse, s: Session) -> None:
    try:
        await asyncio.sleep(AMD_MAX_WAIT_S)
        with s.lock:
            if not s.amd_done:
                s.call_type = CallType.HUMAN
                s.amd_done  = True
        clog(s.call_sid, "AMD max-wait — defaulting HUMAN")
    except asyncio.CancelledError:
        pass

async def duration_guard(ws: web.WebSocketResponse, s: Session) -> None:
    try:
        await asyncio.sleep(WARNING_DURATION_S)
        if not ws_open(ws):
            return

        with s.lock:
            already_warned = s.warning_sent
            s.warning_sent = True

        if not already_warned:
            socket = s.agent_conn
            injected = False
            if socket:
                try:
                    await asyncio.to_thread(
                        socket.send,
                        json.dumps({
                            "type":    "InjectAgentMessage",
                            "message": "I don't want to take too much of your time — shall we wrap up?",
                        })
                    )
                    injected = True
                except Exception as e:
                    clog(s.call_sid, f"duration inject error: {e}")

            if not injected:
                log_outcome(s.call_sid, CallOutcome.CALL_DROPPED, "max duration (inject unavailable)")
                with s.lock:
                    s.pending_hangup = True
                    s.outcome        = CallOutcome.CALL_DROPPED
                if not s.agent_speaking:
                    await _perform_hangup(ws, s.call_sid)
                return

        await asyncio.sleep(MAX_CALL_DURATION_S - WARNING_DURATION_S)
        if not ws_open(ws):
            return

        clog(s.call_sid, "hard duration limit reached")
        log_outcome(s.call_sid, CallOutcome.CALL_DROPPED, "hard duration limit")
        with s.lock:
            s.pending_hangup = True
            s.outcome        = CallOutcome.CALL_DROPPED
        if not s.agent_speaking:
            await _perform_hangup(ws, s.call_sid)
        await asyncio.sleep(5.0)
        if ws_open(ws):
            await ws.close()

    except asyncio.CancelledError:
        pass

async def _perform_hangup(ws: web.WebSocketResponse, call_sid: str) -> None:
    if not ws_open(ws):
        return
    clog(call_sid, "graceful hangup")
    await asyncio.sleep(1.0)
    try:
        await ws.close()
    except Exception:
        pass

# ── Threads ───────────────────────────────────────────────────────────────────

def media_sender_thread(s: Session) -> None:
    clog(s.call_sid, "media-sender started")
    try:
        while True:
            chunk = s.send_q.get()
            if chunk is None:
                break
            try:
                s.agent_conn.send_media(chunk)
            except Exception as e:
                clog(s.call_sid, f"media-sender error: {e}")
    finally:
        clog(s.call_sid, "media-sender stopped")

async def audio_sender_task(ws: web.WebSocketResponse, s: Session) -> None:
    try:
        while True:
            item = await s.audio_queue.get()
            if item is None:
                break
            gen_id, audio = item
            if gen_id == s.generation_id:
                await send_audio_to_telnyx(ws, audio, s.stream_sid)
    except asyncio.CancelledError:
        pass

# ── Function call handler ─────────────────────────────────────────────────────

def _send_fn_response(socket, fn_id: str, fn_name: str, content: Dict) -> None:
    try:
        socket.send_function_call_response(
            AgentV1SendFunctionCallResponse(id=fn_id, name=fn_name, content=json.dumps(content))
        )
    except Exception as e:
        log.warning("fn_response[%s]: %s", fn_name, e)

def handle_fn(socket, fn, s: Session, call_sid: str, close_ws: Callable) -> None:
    try:
        args = json.loads(fn.arguments)
    except Exception:
        args = {}

    if fn.name == "end_conversation":
        outcome = args.get("outcome", CallOutcome.CALL_DROPPED)
        reason  = args.get("reason", "")
        with s.lock:
            s.outcome        = outcome
            s.pending_hangup = True
        log_outcome(call_sid, outcome, reason)
        _send_fn_response(socket, fn.id, fn.name, {
            "success": True,
            "message": "Thank you for your time. Have a great day!",
            "reason":  reason,
            "outcome": outcome,
        })

    elif fn.name == "update_call_state":
        new_state = args.get("state", "")
        if new_state in CallState._value2member_map_:
            with s.lock:
                s.call_state = new_state
        _send_fn_response(socket, fn.id, fn.name, {"success": True, "state": new_state})

    elif fn.name == "update_lead_facts":
        with s.lock:
            for key in ("company", "budget", "timeline"):
                if args.get(key):
                    s.facts[key] = args[key]
            for key in ("pain_points", "interested_services"):
                if args.get(key):
                    existing = set(s.facts.get(key) or [])
                    existing.update(args[key])
                    s.facts[key] = list(existing)
            snapshot = dict(s.facts)
        clog(call_sid, f"facts updated: {snapshot}")
        _send_fn_response(socket, fn.id, fn.name, {"success": True, "facts": snapshot})

    else:
        _send_fn_response(socket, fn.id, fn.name, {"success": False, "error": f"unknown fn: {fn.name}"})

# ── Agent listener thread ─────────────────────────────────────────────────────

def agent_listener_thread(
    socket,
    ws: web.WebSocketResponse,
    s: Session,
    settings: Dict,
) -> None:
    loop     = s.loop
    call_sid = s.call_sid

    def run(coro):
        run_async(coro, loop)

    def close_ws():
        run(ws.close())

    try:
        for msg in socket:
            # Raw TTS audio bytes
            if isinstance(msg, bytes):
                with s.lock:
                    s.agent_speaking = True
                    gen_id = s.generation_id
                run(s.audio_queue.put((gen_id, msg)))
                continue

            t = getattr(msg, "type", None)

            if t == "Welcome":
                clog(call_sid, "DG connected → sending settings")
                try:
                    socket.send_settings(settings)
                except Exception as e:
                    clog(call_sid, f"send_settings error: {e}")

            elif t == "SettingsApplied":
                clog(call_sid, "DG ready")

            elif t == "Error":
                desc = getattr(msg, "description", "")
                log.error("[%s] DG error %s: %s", call_sid, getattr(msg, "code", "?"), desc)
                if "connection" in str(desc).lower() or "websocket" in str(desc).lower():
                    run(_reconnect_deepgram(ws, s))

            elif t == "UserStartedSpeaking":
                with s.lock:
                    s.generation_id += 1
                    gen_id           = s.generation_id
                    s.agent_speaking  = False
                    s.silence_seconds = 0.0
                    if s.call_type == CallType.UNKNOWN:
                        s.call_type = CallType.HUMAN
                        s.amd_done  = True
                run(drain_audio_queue(s.audio_queue))
                if s.stream_sid:
                    run(telnyx_clear(ws, s.stream_sid))
                clog(call_sid, f"barge-in gen={gen_id}")

            elif t == "AgentStartedSpeaking":
                with s.lock:
                    s.agent_speaking  = True
                    s.silence_seconds = 0.0

            elif t == "AgentAudioDone":
                with s.lock:
                    s.agent_speaking = False
                    pending = s.pending_hangup
                if pending:
                    run(_perform_hangup(ws, call_sid))

            elif t == "FunctionCallRequest":
                for fn in msg.functions:
                    clog(call_sid, f"fn: {fn.name}")
                    handle_fn(socket, fn, s, call_sid, close_ws)

            elif t == "ConversationText":
                role = getattr(msg, "role", "?")
                text = getattr(msg, "content", getattr(msg, "text", ""))
                clog(call_sid, f"{role}: {text}")
                with s.lock:
                    s.history.append({"role": role, "text": text})
                    amd_done = s.amd_done

                if not amd_done and role in ("user", "assistant"):
                    lower = text.lower()
                    if any(p in lower for p in VOICEMAIL_PHRASES):
                        with s.lock:
                            s.call_type = CallType.VOICEMAIL
                            s.amd_done  = True
                        log_outcome(call_sid, CallOutcome.VOICEMAIL, "voicemail phrase in transcript")
                        close_ws()
                    elif "press" in lower and ("for" in lower or "to" in lower):
                        with s.lock:
                            s.call_type = CallType.IVR
                            s.amd_done  = True
                        log_outcome(call_sid, CallOutcome.IVR, "IVR pattern in transcript")
                        close_ws()

    except Exception as e:
        log.error("[%s] listener error: %s", call_sid, e)
        if ws_open(ws):
            run(_reconnect_deepgram(ws, s))
    finally:
        clog(call_sid, "listener exited")
        run(s.audio_queue.put(None))
        run(ws.close())

# ── Reconnect ─────────────────────────────────────────────────────────────────

def _start_media_sender(s: Session) -> None:
    threading.Thread(
        target=media_sender_thread, args=(s,),
        daemon=True, name=f"media-sender-{s.call_sid}",
    ).start()

async def _reconnect_deepgram(ws: web.WebSocketResponse, s: Session) -> bool:
    async with s.reconnect_lock:
        for attempt, delay in enumerate(RECONNECT_DELAYS):
            if delay:
                await asyncio.sleep(delay)
            clog(s.call_sid, f"reconnect attempt {attempt + 1}")

            try:
                if old_cm := s._cm:
                    await asyncio.to_thread(_dg_close, old_cm, s.dg_lock)

                cm, socket = await asyncio.to_thread(_dg_connect, s.dg_lock)
                with s.lock:
                    s._cm        = cm
                    s.agent_conn = socket

                # Replace send queue + sender thread
                if old_sq := s.send_q:
                    old_sq.put(None)
                s.send_q = sync_queue.Queue(maxsize=SEND_QUEUE_MAXSIZE)
                _start_media_sender(s)

                # Replace keepalive
                if old_ka := s.keepalive_task:
                    old_ka.cancel()
                s.keepalive_task = asyncio.ensure_future(keepalive_loop(s))

                # Replace listener with recovery settings
                recovery = build_recovery_settings(s, s.dg_settings)
                if old_l := s.listener:
                    old_l.cancel()
                s.listener = asyncio.ensure_future(
                    asyncio.to_thread(agent_listener_thread, socket, ws, s, recovery)
                )

                clog(s.call_sid, f"reconnect success attempt {attempt + 1}")
                return True

            except Exception as e:
                clog(s.call_sid, f"reconnect attempt {attempt + 1} failed: {e}")

    clog(s.call_sid, "all reconnect attempts failed")
    log_outcome(s.call_sid, CallOutcome.CALL_DROPPED, "Deepgram reconnect failed")
    await ws.close()
    return False

# ── Session startup ───────────────────────────────────────────────────────────

async def _start_session(ws: web.WebSocketResponse, s: Session, data: Dict) -> bool:
    start      = data.get("start", {})
    stream_sid = data.get("streamSid", "")
    call_sid   = start.get("call_control_id") or start.get("callSid") or stream_sid

    s.stream_sid      = stream_sid
    s.call_sid        = call_sid
    s.call_start_time = time.monotonic()
    s.reconnect_lock  = asyncio.Lock()
    s.loop            = asyncio.get_running_loop()
    clog(call_sid, "call started")

    try:
        cfg           = await fetch_agent_config()
        agent_name    = cfg.get("agent_name", "").strip() or "Ella"
        lead_name     = cfg.get("lead_name",  "").strip() or None
        system_prompt = cfg.get("system_prompt", "").strip() or build_system_prompt(agent_name, lead_name)
        settings      = build_dg_settings(system_prompt, agent_name, lead_name)

        s.dg_settings = settings
        if lead_name:
            s.facts["lead_name"] = lead_name

        cm, socket = await asyncio.to_thread(_dg_connect, s.dg_lock)
        s._cm        = cm
        s.agent_conn = socket

        s.send_q      = sync_queue.Queue(maxsize=SEND_QUEUE_MAXSIZE)
        s.audio_queue = asyncio.Queue()

        _start_media_sender(s)

        s.audio_sender_task = asyncio.ensure_future(audio_sender_task(ws, s))
        s.listener          = asyncio.ensure_future(
            asyncio.to_thread(agent_listener_thread, socket, ws, s, settings)
        )
        s.keepalive_task = asyncio.ensure_future(keepalive_loop(s))
        s.duration_task  = asyncio.ensure_future(duration_guard(ws, s))
        s.amd_task       = asyncio.ensure_future(amd_max_wait_guard(ws, s))

        _sessions[call_sid] = s
        return True

    except Exception as e:
        clog(call_sid, f"setup failed: {e}")
        log_outcome(call_sid, CallOutcome.CALL_DROPPED, f"setup error: {e}")
        s.outcome = CallOutcome.CALL_DROPPED
        return False

# ── Media frame processing ────────────────────────────────────────────────────

def _process_media(ws: web.WebSocketResponse, s: Session, raw: bytes, loop: asyncio.AbstractEventLoop) -> None:
    enqueue_audio(s.send_q, raw)

    need_rms = (
        (not s.agent_speaking and not s.ghost_fired)
        or (not s.amd_done and not s.agent_speaking)
    )
    rms = ulaw_rms(raw) if need_rms else 0.0

    # Ghost-call detection
    if not s.agent_speaking and not s.ghost_fired:
        if rms < SILENCE_THRESHOLD:
            with s.lock:
                s.silence_seconds += FRAME_DURATION_S
                silence = s.silence_seconds
            if silence >= GHOST_CALL_TIMEOUT_S:
                run_async(ghost_call_hangup(ws, s), loop)
        else:
            with s.lock:
                s.silence_seconds = 0.0

    # AMD energy detection
    if not s.amd_done and not s.agent_speaking:
        if rms >= SILENCE_THRESHOLD:
            if s.amd_speech_start is None:
                with s.lock:
                    s.amd_speech_start = time.monotonic()
            else:
                elapsed = time.monotonic() - s.amd_speech_start
                if elapsed >= AMD_SPEECH_TIMEOUT_S:
                    with s.lock:
                        s.call_type = CallType.VOICEMAIL
                        s.amd_done  = True
                    log_outcome(s.call_sid, CallOutcome.VOICEMAIL, f"uninterrupted speech {elapsed:.1f}s")
                    run_async(ws.close(), loop)
        else:
            with s.lock:
                s.amd_speech_start = None

# ── Cleanup ───────────────────────────────────────────────────────────────────

async def _cleanup(s: Session) -> None:
    call_sid = s.call_sid
    _sessions.pop(call_sid, None)

    if not s.outcome:
        log_outcome(call_sid, CallOutcome.CALL_DROPPED, "session ended without outcome")

    for task in filter(None, [
        s.keepalive_task, s.audio_sender_task, s.listener,
        s.duration_task, s.amd_task,
    ]):
        task.cancel()
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=2.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass

    if q := s.send_q:
        q.put(None)

    if aq := s.audio_queue:
        await drain_audio_queue(aq)
        try:
            aq.put_nowait(None)
        except Exception:
            pass

    if cm := s._cm:
        await asyncio.to_thread(_dg_close, cm, s.dg_lock)

    clog(call_sid, f"cleanup done — outcome={s.outcome}")

# ── Telnyx webhook ────────────────────────────────────────────────────────────

async def telnyx_voice(request: web.Request) -> web.Response:
    if TELNYX_PUBLIC_KEY:
        try:
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
            sig       = request.headers.get("X-Telnyx-Signature-Ed25519", "")
            timestamp = request.headers.get("X-Telnyx-Timestamp", "")
            body      = await request.read()
            pub_key   = Ed25519PublicKey.from_public_bytes(base64.b64decode(TELNYX_PUBLIC_KEY))
            pub_key.verify(base64.b64decode(sig), (timestamp + "|").encode() + body)
        except Exception as exc:
            log.warning("sig verify failed: %s", exc)
            raise web.HTTPForbidden(reason="Invalid Telnyx signature")

    host = request.headers.get("Host", f"localhost:{PORT}")
    texml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<Response><Connect>'
        f'<Stream url="wss://{host}/ws/telnyx" />'
        '</Connect></Response>'
    )
    return web.Response(text=texml, content_type="application/xml")

# ── Telnyx WS handler ─────────────────────────────────────────────────────────

async def telnyx_ws_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(max_msg_size=0)
    await ws.prepare(request)

    s    = Session()
    loop = asyncio.get_running_loop()

    try:
        async for message in ws:
            if message.type != aiohttp.WSMsgType.TEXT:
                if message.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
                    break
                continue

            try:
                data  = json.loads(message.data)
                event = data.get("event")
            except json.JSONDecodeError:
                continue

            if event == "connected":
                continue

            elif event == "start":
                ok = await _start_session(ws, s, data)
                if not ok:
                    await ws.close()
                    break

            elif event == "stop":
                clog(s.call_sid, "call ended by Telnyx")
                break

            elif event == "media":
                if not s.agent_conn or not s.send_q:
                    continue
                payload = data.get("media", {}).get("payload")
                if payload:
                    _process_media(ws, s, base64.b64decode(payload), loop)

    finally:
        await _cleanup(s)

    return ws

# ── Health ────────────────────────────────────────────────────────────────────

async def ping(request: web.Request) -> web.Response:
    return web.Response(text='{"status":"ok"}', content_type="application/json")

async def health(request: web.Request) -> web.Response:
    cfg = await fetch_agent_config()
    body = json.dumps({
        "status":          "ok",
        "active_sessions": len(_sessions),
        "call_handler":    CALL_HANDLER_URL,
        "prompt_loaded":   bool(cfg.get("system_prompt")),
        "agent_name":      cfg.get("agent_name", "Ella"),
    })
    return web.Response(text=body, content_type="application/json")

# ── Main ──────────────────────────────────────────────────────────────────────

async def main() -> None:
    app = web.Application()
    app.router.add_post("/telnyx/voice", telnyx_voice)
    app.router.add_get("/ws/telnyx",     telnyx_ws_handler)
    app.router.add_get("/health",        health)
    app.router.add_get("/ping",          ping)

    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", PORT).start()
    log.info("server :%d — /telnyx/voice | /ws/telnyx | /health | /ping", PORT)
    await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("server stopped")