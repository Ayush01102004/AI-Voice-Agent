"""
Deepgram Voice Agent — Plivo Audio Streaming
Python 3.10+ | Deepgram SDK v5+ | aiohttp v3+ | plivo SDK v4+

Endpoints:
  POST /plivo/answer  — Plivo Answer URL webhook (returns Record+Stream XML)
  GET  /ws/plivo      — Plivo Audio Streaming WebSocket
  GET  /health        — Health check
  GET  /ping          — Liveness probe

Audio format stays audio/x-mulaw;rate=8000 end-to-end (same as the old
Telnyx setup) so the Deepgram Voice Agent settings, AMD/ghost-call RMS
detection, and audio queue plumbing below are UNCHANGED from the Telnyx
version — only the WS transport envelope, webhook/XML, and hangup
mechanics are Plivo-specific (each change point is commented CHANGED/NEW
inline where it happens).
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
import plivo
from aiohttp import web
from deepgram import DeepgramClient
from deepgram.agent.v1.types import (
    AgentV1SendFunctionCallResponse,
    AgentV1Settings,
    AgentV1SettingsAgent,
    AgentV1SettingsAgentListen,
    AgentV1SettingsAgentListenProvider_V1,
    AgentV1SettingsAudio,
    AgentV1SettingsAudioInput,
    AgentV1SettingsAudioOutput,
)
from deepgram.types.think_settings_v1 import ThinkSettingsV1
from deepgram.types.think_settings_v1provider import ThinkSettingsV1Provider_OpenAi
from deepgram.types.speak_settings_v1 import SpeakSettingsV1
from deepgram.types.speak_settings_v1provider import SpeakSettingsV1Provider_Deepgram
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
PLIVO_AUTH_ID     = os.getenv("PLIVO_AUTH_ID", "")
PLIVO_AUTH_TOKEN  = os.getenv("PLIVO_AUTH_TOKEN", "")
# NEW: same var call_handler.py uses for the Plivo Application's answer_url —
# reused here so the CLI dialer (_cli_dialer_loop) can derive the public
# host without needing an in-flight request to read headers from.
PLIVO_ANSWER_URL  = os.getenv("PLIVO_ANSWER_URL", "")
INTERNAL_API_KEY  = os.getenv("INTERNAL_API_KEY", "")  # shared secret for calling call_handler.py

if not DEEPGRAM_API_KEY:
    raise ValueError("DEEPGRAM_API_KEY missing")
if not PLIVO_AUTH_ID or not PLIVO_AUTH_TOKEN:
    raise ValueError("PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN missing — needed for signature verification and call hangup")

plivo_client = plivo.RestClient(PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN)

# ── Constants ─────────────────────────────────────────────────────────────────

KEEPALIVE_INTERVAL_S      = 8.0
FRAME_DURATION_S          = 0.020
SILENCE_THRESHOLD         = 80.0
GHOST_CALL_TIMEOUT_S      = 18.0   # CHANGED: was 10.0 — longer grace period before auto-hangup on silence
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

def build_dg_settings(system_prompt: str, agent_name: str, lead_name: Optional[str]) -> AgentV1Settings:
    return AgentV1Settings(
        audio=AgentV1SettingsAudio(
            input=AgentV1SettingsAudioInput(encoding="mulaw", sample_rate=8000),
            output=AgentV1SettingsAudioOutput(encoding="mulaw", sample_rate=8000, container="none"),
        ),
        agent=AgentV1SettingsAgent(
            listen=AgentV1SettingsAgentListen(
                provider=AgentV1SettingsAgentListenProvider_V1(type="deepgram", model="nova-3")
            ),
            think=ThinkSettingsV1(
                provider=ThinkSettingsV1Provider_OpenAi(
                    type="open_ai", model="gpt-4o-mini"
                ),
                prompt=system_prompt,
                functions=FUNCTIONS,
            ),
            speak=SpeakSettingsV1(
                provider=SpeakSettingsV1Provider_Deepgram(type="deepgram", model="aura-2-helena-en")
            ),
            greeting=build_greeting(lead_name),
        ),
    )
def build_recovery_settings(s: "Session", base_settings: AgentV1Settings) -> AgentV1Settings:
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
    recovered.agent.think.prompt += recovery
    recovered.agent.greeting = None
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
        "call_sid", "stream_sid", "agent_id", "agent_id_hint",
        "to_number", "from_number",
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
        self.agent_id        = "default"
        self.agent_id_hint   = ""
        self.to_number       = ""
        self.from_number     = ""
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
# NEW: tracks call_uuids that have already received a Record+Stream
# response from plivo_answer() — see dedupe note there.
_answered_call_uuids: set = set()

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

async def plivo_clear_audio(ws: web.WebSocketResponse, stream_id: str) -> None:
    """Plivo's barge-in event — no stream_id needed in the payload since
    each call gets its own dedicated WS connection, but Plivo does expect
    this exact event name (CHANGED from Telnyx's {"event":"clear"})."""
    if ws_open(ws):
        try:
            await ws.send_str(json.dumps({"event": "clearAudio"}))
        except Exception:
            pass

async def send_audio_to_plivo(ws: web.WebSocketResponse, audio: bytes, stream_id: str) -> None:
    """CHANGED: Plivo's outbound audio event is "playAudio" (not "media"
    like Telnyx/Twilio), and the media object needs explicit contentType +
    sampleRate fields — Plivo doesn't infer format from the inbound stream."""
    if not ws_open(ws):
        return
    try:
        await ws.send_str(json.dumps({
            "event": "playAudio",
            "media": {
                "contentType": "audio/x-mulaw",
                "sampleRate":  8000,
                "payload":     base64.b64encode(audio).decode(),
            },
        }))
    except Exception as e:
        log.warning("audio→plivo: %s", e)

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
    log.info("[DG-CKPT] acquiring dg_lock…")
    with lock:
        log.info("[DG-CKPT] lock acquired, calling deepgram_client.agent.v1.connect()")
        cm     = deepgram_client.agent.v1.connect()
        socket = cm.__enter__()
        log.info("[DG-CKPT] Deepgram __enter__ returned socket=%s", socket)
        return cm, socket

def _dg_close(cm, lock: threading.Lock) -> None:
    with lock:
        try:
            cm.__exit__(None, None, None)
        except Exception as e:
            log.warning("dg_close: %s", e)

# ── Config fetch ──────────────────────────────────────────────────────────────

DEFAULT_AGENT_ID = "default"

# NEW: config cache is now keyed per agent_id so 10 personas served by one
# deployment each get independent cache entries/TTLs instead of fighting
# over one global config.
_config_cache: Dict[str, Dict[str, Any]] = {}       # {agent_id: {...}}
_config_cache_ts: Dict[str, float] = {}              # {agent_id: monotonic_ts}
_config_cache_lock = asyncio.Lock()  # NEW: prevents thundering-herd concurrent fetches
_CONFIG_CACHE_TTL_S = 60.0

async def fetch_agent_config(agent_id: str = DEFAULT_AGENT_ID, force: bool = False) -> Dict[str, Any]:
    global _config_cache, _config_cache_ts

    # NEW: lock wraps the whole check+fetch so concurrent callers don't all
    # hit CALL_HANDLER_URL at once when cache expires under load.
    async with _config_cache_lock:
        now       = time.monotonic()
        cached    = _config_cache.get(agent_id)
        cached_ts = _config_cache_ts.get(agent_id, 0.0)
        if not force and (now - cached_ts) < _CONFIG_CACHE_TTL_S and cached:
            return cached

        for attempt in range(CONFIG_FETCH_RETRIES):
            if attempt:
                await asyncio.sleep(CONFIG_FETCH_BACKOFF_S * attempt)
            try:
                async with aiohttp.ClientSession() as sess:
                    async with sess.get(
                        f"{CALL_HANDLER_URL}/api/config",
                        params={"agent_id": agent_id},
                        timeout=aiohttp.ClientTimeout(total=5),
                    ) as resp:
                        if resp.status == 200:
                            cfg = await resp.json()
                            _config_cache[agent_id]    = cfg
                            _config_cache_ts[agent_id] = now
                            return cfg
                        log.warning("config HTTP %s attempt %d (agent_id=%s)", resp.status, attempt + 1, agent_id)
            except Exception as e:
                log.warning("config attempt %d (agent_id=%s): %s", attempt + 1, agent_id, e)

        log.warning("config fetch failed for agent_id=%s — using cache or defaults", agent_id)
        return _config_cache.get(agent_id, {})


# NEW: resolve which agent_id a call belongs to, based on the Telnyx "to"
# number. Cached briefly — call volume shouldn't hammer call_handler for
# a mapping that changes maybe once a week.
_phone_map_cache: Dict[str, str] = {}
_phone_map_cache_ts: float = 0.0
_PHONE_MAP_TTL_S = 300.0

async def resolve_agent_id(to_number: Optional[str]) -> str:
    global _phone_map_cache, _phone_map_cache_ts
    if not to_number:
        return DEFAULT_AGENT_ID

    now = time.monotonic()
    if to_number in _phone_map_cache and (now - _phone_map_cache_ts) < _PHONE_MAP_TTL_S:
        return _phone_map_cache[to_number]

    try:
        async with aiohttp.ClientSession() as sess:
            async with sess.get(
                f"{CALL_HANDLER_URL}/api/agent-for-number",
                params={"to": to_number},
                timeout=aiohttp.ClientTimeout(total=5),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    agent_id = data.get("agent_id", DEFAULT_AGENT_ID)
                    _phone_map_cache[to_number] = agent_id
                    _phone_map_cache_ts = now
                    return agent_id
    except Exception as e:
        log.warning("agent-for-number lookup failed for %s: %s", to_number, e)

    return DEFAULT_AGENT_ID

async def resolve_agent_for_call(to_number: str) -> Optional[str]:
    """STRICT number-to-agent binding: this number must be explicitly
    linked to an agent (dashboard's Agent Profiles -> Assign). No pool
    round-robin fallback — an unmapped number returns None and the
    caller must reject the call rather than silently routing it to a
    default/random agent. This applies to both inbound and outbound,
    since Plivo's `To` param is the same field either way."""
    try:
        async with aiohttp.ClientSession() as sess:
            async with sess.get(
                f"{CALL_HANDLER_URL}/api/agent-for-number",
                params={"to": to_number},
                timeout=aiohttp.ClientTimeout(total=5),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    mapped = data.get("agent_id")
                    if mapped:
                        return mapped
    except Exception as e:
        log.error("agent-for-number lookup failed for to=%s: %s", to_number, e)

    log.error("NO AGENT MAPPED for to=%s — call cannot be routed", to_number)
    return None

# ── Call result persistence ───────────────────────────────────────────────────
# NEW: hook so lead facts + transcript survive even if the call drops before
# an explicit end_conversation() call. Wire this to your actual Supabase
# client/table — left as a safe no-op + log if not yet implemented, so
# _cleanup() never breaks even before you wire persistence in.

async def save_call_result(
    call_sid: str,
    facts: Dict[str, Any],
    outcome: Optional[str],
    history: List[Dict[str, str]],
) -> None:
    # CHANGED: no longer a stub. POSTs to call_handler.py's
    # /api/call-live-facts, which performs the actual Supabase write.
    # server.py never touches the DB directly — call_handler.py stays
    # the single writer to the "calls" table.
    headers = {"X-Internal-Key": INTERNAL_API_KEY} if INTERNAL_API_KEY else {}
    try:
        async with aiohttp.ClientSession() as sess:
            async with sess.post(
                f"{CALL_HANDLER_URL}/api/call-live-facts",
                json={
                    "call_sid": call_sid,
                    "facts":    facts,
                    "outcome":  outcome,
                    "history":  history,
                },
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=5),
            ) as resp:
                if resp.status != 200:
                    clog(call_sid, f"save_call_result HTTP {resp.status}")
    except Exception as e:
        clog(call_sid, f"save_call_result failed: {e}")


async def save_call_transcript(
    call_sid:      str,
    history:       List[Dict[str, str]],
    to_number:     str,
    from_number:   str,
    duration_sec:  float,
    agent_id:      str,
) -> None:
    """NEW: replaces the old record-download-transcribe pipeline. The
    transcript already exists as text (s.history, built live from
    Deepgram's ConversationText events during the call), so this just
    ships that text straight to call_handler.py's /api/call-transcript,
    which runs it through Groq for lead scoring — no audio recording,
    no download, no re-transcription needed."""
    if not history:
        clog(call_sid, "save_call_transcript skipped — empty history")
        return
    headers = {"X-Internal-Key": INTERNAL_API_KEY} if INTERNAL_API_KEY else {}
    try:
        async with aiohttp.ClientSession() as sess:
            async with sess.post(
                f"{CALL_HANDLER_URL}/api/call-transcript",
                json={
                    "call_sid":     call_sid,
                    "history":      history,
                    "to_number":    to_number,
                    "from_number":  from_number,
                    "duration_sec": duration_sec,
                    "agent_id":     agent_id,
                    "source":       "Plivo",
                },
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                if resp.status != 200:
                    clog(call_sid, f"save_call_transcript HTTP {resp.status}")
                else:
                    clog(call_sid, "save_call_transcript OK — Groq scoring queued")
    except Exception as e:
        clog(call_sid, f"save_call_transcript failed: {e}")

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

async def hangup_call(call_sid: str) -> None:
    """
    CHANGED: this is new for Plivo. Telnyx's original code only closed the
    WS to end a call — that's NOT enough for Plivo when keepCallAlive="true"
    on the <Stream> (which we set so a dropped WS doesn't kill the call
    mid-setup). Closing the WS only stops the audio stream; the underlying
    PSTN call stays connected in silence until this REST hangup runs.
    """
    if not call_sid:
        return
    try:
        await asyncio.to_thread(plivo_client.calls.delete, call_uuid=call_sid)
        clog(call_sid, "plivo REST hangup sent")
    except Exception as e:
        clog(call_sid, f"plivo REST hangup failed (call may already be over): {e}")

async def ghost_call_hangup(ws: web.WebSocketResponse, s: Session) -> None:
    with s.lock:
        if s.ghost_fired:
            return
        s.ghost_fired = True
    clog(s.call_sid, f"[GUARD-CKPT] ghost call fired — {GHOST_CALL_TIMEOUT_S}s silence")
    log_outcome(s.call_sid, CallOutcome.NO_RESPONSE, "ghost call silence timeout")
    await plivo_clear_audio(ws, s.stream_sid)
    await hangup_call(s.call_sid)
    await ws.close()

async def amd_max_wait_guard(ws: web.WebSocketResponse, s: Session) -> None:
    try:
        await asyncio.sleep(AMD_MAX_WAIT_S)
        with s.lock:
            if not s.amd_done:
                s.call_type = CallType.HUMAN
                s.amd_done  = True
        clog(s.call_sid, "[GUARD-CKPT] AMD max-wait fired — defaulting HUMAN")
    except asyncio.CancelledError:
        clog(s.call_sid, "[GUARD-CKPT] AMD guard cancelled (call ended before wait elapsed)")

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

        # CHANGED: hard limit now speaks a closing line instead of dropping
        # silently. Reuses the same InjectAgentMessage + pending_hangup path
        # as the 4-min warning, so AgentAudioDone still drives the graceful
        # hangup timing. Falls back to old immediate-drop if inject fails.
        socket = s.agent_conn
        injected = False
        if socket:
            try:
                await asyncio.to_thread(
                    socket.send,
                    json.dumps({
                        "type":    "InjectAgentMessage",
                        "message": "I've got to wrap up now — thank you so much for your time today. Have a great day!",
                    })
                )
                injected = True
            except Exception as e:
                clog(s.call_sid, f"hard-limit inject error: {e}")

        with s.lock:
            s.pending_hangup = True
            s.outcome        = CallOutcome.CALL_DROPPED

        if not injected and not s.agent_speaking:
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
    await hangup_call(call_sid)   # CHANGED: actually ends the PSTN call (see hangup_call() note)
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
                await send_audio_to_plivo(ws, audio, s.stream_sid)
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
                clog(call_sid, "DG ready — starting media sender")
                _start_media_sender(s)

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
                    run(plivo_clear_audio(ws, s.stream_sid))
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
                # NOT started here — same race as initial connect. New
                # listener below resends Settings on Welcome and starts
                # the sender itself on SettingsApplied.

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
    stream_sid = start.get("streamId") or data.get("streamId", "")
    call_sid   = start.get("callId") or stream_sid

    # CHANGED: agent_id was resolved once already, at answer-time, in
    # plivo_answer() — it rode here via the WS URL's query string (see
    # plivo_ws_handler) rather than a second DB round-trip per call.
    agent_id_hint = s.agent_id_hint

    s.stream_sid      = stream_sid
    s.call_sid        = call_sid
    s.call_start_time = time.monotonic()
    s.reconnect_lock  = asyncio.Lock()
    s.loop            = asyncio.get_running_loop()
    clog(call_sid, "call started")

    try:
        # [CHECKPOINT 1] agent resolution
        agent_id      = agent_id_hint or await resolve_agent_id(None)
        s.agent_id    = agent_id
        clog(call_sid, f"[CKPT1] routed to agent_id={agent_id}")

        # [CHECKPOINT 2] config fetch
        cfg           = await fetch_agent_config(agent_id)
        clog(call_sid, f"[CKPT2] config fetched — keys={list(cfg.keys())}")
        agent_name    = cfg.get("agent_name", "").strip() or "Assistant"
        lead_name     = cfg.get("lead_name",  "").strip() or None
        system_prompt = cfg.get("system_prompt", "").strip() or build_system_prompt(agent_name, lead_name)
        settings      = build_dg_settings(system_prompt, agent_name, lead_name)
        clog(call_sid, f"[CKPT2b] agent_name={agent_name} lead_name={lead_name} prompt_len={len(system_prompt)}")

        s.dg_settings = settings
        if lead_name:
            s.facts["lead_name"] = lead_name

        # [CHECKPOINT 3] Deepgram connect — most likely failure point if
        # nothing prints past here: DEEPGRAM_API_KEY invalid/missing,
        # network block, or SDK version mismatch.
        clog(call_sid, "[CKPT3] connecting to Deepgram…")
        cm, socket = await asyncio.to_thread(_dg_connect, s.dg_lock)
        s._cm        = cm
        s.agent_conn = socket
        clog(call_sid, "[CKPT3b] Deepgram connected OK")

        s.send_q      = sync_queue.Queue(maxsize=SEND_QUEUE_MAXSIZE)
        s.audio_queue = asyncio.Queue()

        # [CHECKPOINT 4] tasks spun up — media sender now starts itself
        # inside the listener on SettingsApplied (not here), so it can
        # never send audio to DG before Settings is acked.
        clog(call_sid, "[CKPT4] tasks starting")

        s.audio_sender_task = asyncio.ensure_future(audio_sender_task(ws, s))
        s.listener          = asyncio.ensure_future(
            asyncio.to_thread(agent_listener_thread, socket, ws, s, settings)
        )
        s.keepalive_task = asyncio.ensure_future(keepalive_loop(s))
        s.duration_task  = asyncio.ensure_future(duration_guard(ws, s))
        s.amd_task       = asyncio.ensure_future(amd_max_wait_guard(ws, s))
        clog(call_sid, "[CKPT5] all tasks launched — session live")

        _sessions[call_sid] = s
        return True

    except Exception as e:
        clog(call_sid, f"[CKPT-FAIL] setup failed: {type(e).__name__}: {e}")
        log_outcome(call_sid, CallOutcome.CALL_DROPPED, f"setup error: {e}")
        s.outcome = CallOutcome.CALL_DROPPED
        return False

# ── Media frame processing ────────────────────────────────────────────────────
# CHANGED: split into _should_analyze / _check_ghost_call / _check_amd so the
# "not s.agent_speaking" gate is checked once, rms computed once, and each
# detector (ghost / AMD) is an independent, testable function.

def _should_analyze(s: Session) -> bool:
    """Skip rms calc entirely once both detectors are done and agent isn't speaking."""
    return not s.agent_speaking and (not s.ghost_fired or not s.amd_done)

def _check_ghost_call(ws: web.WebSocketResponse, s: Session, rms: float, loop: asyncio.AbstractEventLoop) -> None:
    if s.ghost_fired:
        return
    if rms < SILENCE_THRESHOLD:
        with s.lock:
            s.silence_seconds += FRAME_DURATION_S
            silence = s.silence_seconds
        if silence >= GHOST_CALL_TIMEOUT_S:
            run_async(ghost_call_hangup(ws, s), loop)
    else:
        with s.lock:
            s.silence_seconds = 0.0

def _check_amd(ws: web.WebSocketResponse, s: Session, rms: float, loop: asyncio.AbstractEventLoop) -> None:
    if s.amd_done:
        return
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
                run_async(_perform_hangup(ws, s.call_sid), loop)
    else:
        with s.lock:
            s.amd_speech_start = None

def _process_media(ws: web.WebSocketResponse, s: Session, raw: bytes, loop: asyncio.AbstractEventLoop) -> None:
    enqueue_audio(s.send_q, raw)

    if not _should_analyze(s):
        return

    rms = ulaw_rms(raw)  # computed once, shared by both checks
    _check_ghost_call(ws, s, rms, loop)
    _check_amd(ws, s, rms, loop)

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

    # NEW: persist lead facts + transcript even if end_conversation() was
    # never called (crash / drop / hard duration limit).
    try:
        await save_call_result(call_sid, dict(s.facts), s.outcome, list(s.history))
    except Exception as e:
        clog(call_sid, f"save_call_result error: {e}")

    # NEW: text-transcript pipeline replaces the old record-download-
    # transcribe flow entirely — sends s.history straight to Groq via
    # call_handler.py's /api/call-transcript.
    try:
        duration = time.monotonic() - s.call_start_time if s.call_start_time else 0.0
        await save_call_transcript(
            call_sid, list(s.history), s.to_number, s.from_number,
            duration, s.agent_id,
        )
    except Exception as e:
        clog(call_sid, f"save_call_transcript error: {e}")

    clog(call_sid, f"cleanup done — outcome={s.outcome}")

# ── Plivo answer webhook ──────────────────────────────────────────────────────
# CHANGED: entirely new for Plivo. Returns XML (not TeXML) with a bidirectional
# <Stream> for the live AI conversation. No <Record>/audio download — the
# transcript is sent as text (s.history) to call_handler.py's
# /api/call-transcript at cleanup instead.
# agent_id is resolved ONCE here (not per audio frame) and baked into the
# Stream's <Parameter> so plivo_ws_handler() below reads it straight off
# the start event with zero extra network round-trips.

async def _verify_plivo_signature(request: web.Request) -> Dict[str, str]:
    """
    Returns the parsed form params if verification passes (or is skipped
    because credentials aren't configured for local testing). Raises
    web.HTTPForbidden if verification is enabled and fails.
    """
    form   = await request.post()
    params = dict(form)

    signature = request.headers.get("X-Plivo-Signature-V3", "")
    nonce     = request.headers.get("X-Plivo-Signature-V3-Nonce", "")

    if not signature or not nonce:
        log.warning("plivo webhook missing signature headers — rejecting")
        raise web.HTTPForbidden(reason="Missing Plivo signature headers")

    # Behind a reverse proxy / tunnel, request.url reflects the local
    # (http://127.0.0.1:PORT/...) view, not the public HTTPS URL Plivo
    # actually signed the request against — rebuild from the Host header
    # (which the proxy/tunnel does forward correctly) to match.
    host = request.headers.get("X-Forwarded-Host") or request.headers.get("Host", "")
    scheme = request.headers.get("X-Forwarded-Proto", "https")
    url = f"{scheme}://{host}{request.path_qs}"
    try:
        valid = plivo.utils.validate_v3_signature(
            "POST", url, nonce, PLIVO_AUTH_TOKEN, signature, params
        )
    except Exception as exc:
        log.warning("plivo signature verify error: %s", exc)
        raise web.HTTPForbidden(reason="Signature verification error")

    if not valid:
        raise web.HTTPForbidden(reason="Invalid Plivo signature")

    return params

async def plivo_answer(request: web.Request) -> web.Response:
    params    = await _verify_plivo_signature(request)
    call_uuid = params.get("CallUUID", "")
    to_number = params.get("To", "")
    from_number = params.get("From", "")

    # DEDUPE: Plivo has been observed hitting answer_url twice for the same
    # call_uuid on outbound calls (~1s apart). Re-issuing <Record> on a
    # call that already has one active causes Plivo to tear the call down
    # right after pickup — matches the "call ends immediately" symptom.
    # First hit proceeds normally and marks the call_uuid seen; any repeat
    # hit for that same call_uuid gets a harmless no-op response instead
    # of a second Record+Stream.
    if call_uuid and call_uuid in _answered_call_uuids:
        clog(call_uuid, f"DUPLICATE answer webhook — to={to_number} — ignoring, call already answered")
        return web.Response(
            text='<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
            content_type="application/xml",
        )
    if call_uuid:
        _answered_call_uuids.add(call_uuid)
        # bound growth — call_uuids are one-shot, safe to drop oldest once large
        if len(_answered_call_uuids) > 500:
            _answered_call_uuids.pop()

    # OUTBOUND: for calls we initiate ourselves (see /api/outbound-call),
    # the answer_url carries an explicit ?agent_id=... query param — this
    # takes priority and skips the To-based lookup entirely, because on
    # outbound legs Plivo's "To" is the customer's number, not one of our
    # Plivo numbers, so resolve_agent_for_call() could never match it.
    # INBOUND calls have no agent_id on the query string, so they fall
    # through to the existing strict number-to-agent binding.
    explicit_agent_id = request.query.get("agent_id", "")
    if explicit_agent_id:
        agent_id = explicit_agent_id
        clog(call_uuid, f"answer webhook (outbound) — to={to_number} → agent_id={agent_id}")
    else:
        # STRICT number-to-agent binding: this number must be explicitly
        # assigned to an agent. No fallback — unmapped number = call
        # rejected, not silently routed to a default/random agent.
        agent_id = await resolve_agent_for_call(to_number)
        if agent_id is None:
            clog(call_uuid, f"REJECTED — no agent mapped for to={to_number}")
            return web.Response(
                text='<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>',
                content_type="application/xml",
            )
        clog(call_uuid, f"answer webhook — to={to_number} → agent_id={agent_id}")

    host = request.headers.get("X-Forwarded-Host") or request.headers.get("Host", f"localhost:{PORT}")
    ws_url = (
        f"wss://{host}/ws/plivo?agent_id={agent_id}&amp;call_uuid={call_uuid}"
        f"&amp;to={to_number}&amp;from={from_number}"
    )
    clog(call_uuid, f"ws_url={ws_url}")
    stream_status_url = f"{CALL_HANDLER_URL}/plivo/stream-status"

    # CHANGED: agent_id rides in the WS URL's query string, not Plivo's
    # <Stream extraHeaders="..."> attribute — extraHeaders values are
    # restricted to [A-Z][a-z][0-9] only, which would silently mangle
    # agent_ids containing underscores (e.g. "sales_us"). A query param
    # on the WS URL has no such restriction and is the pattern Plivo's
    # own docs recommend for passing custom data to a stream endpoint.

    # <Record> REMOVED — we no longer download/transcribe the mp3. The
    # transcript already exists live from Deepgram's ConversationText
    # events (s.history) and gets POSTed as text directly to
    # call_handler.py's /api/call-transcript at cleanup. This also
    # removes the dependency on tunnel B being reachable mid-call for
    # Record's action URL, and the earlier 403-on-download problem goes
    # away entirely since nothing downloads audio anymore.
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<Response>'
        f'<Stream bidirectional="true" keepCallAlive="true" '
        f'contentType="audio/x-mulaw;rate=8000" '
        f'statusCallbackUrl="{stream_status_url}">'
        f'{ws_url}'
        f'</Stream>'
        '</Response>'
    )
    return web.Response(text=xml, content_type="application/xml")

# ── Outbound call trigger ──────────────────────────────────────────────────────
# NEW: shared core — takes a destination number + agent_id, looks up that
# agent's own Plivo number (call_handler.py's /api/number-for-agent) to
# use as caller ID, then places the call via Plivo's REST API with an
# answer_url carrying ?agent_id=... explicitly — see plivo_answer() above
# for why this is required (outbound "To" = customer number, can't be
# used for routing). Used by both the HTTP endpoint and the console
# dialer prompt below, so both paths stay identical.
async def place_outbound_call(to_number: str, agent_id: str, host: str) -> Dict[str, Any]:
    to_number = (to_number or "").strip()
    agent_id  = (agent_id or "").strip()
    if not to_number or not agent_id:
        return {"error": "'to' and 'agent_id' are required"}

    try:
        async with aiohttp.ClientSession() as sess:
            async with sess.get(
                f"{CALL_HANDLER_URL}/api/number-for-agent",
                params={"agent_id": agent_id},
                timeout=aiohttp.ClientTimeout(total=5),
            ) as resp:
                data = await resp.json() if resp.status == 200 else {}
    except Exception as e:
        log.error("number-for-agent lookup failed for agent_id=%s: %s", agent_id, e)
        return {"error": "failed to look up agent's number"}

    from_number = data.get("number")
    if not from_number:
        return {"error": f"agent_id={agent_id} has no Plivo number assigned — assign one in Agent Profiles first"}

    answer_url = f"https://{host}/plivo/answer?agent_id={agent_id}"

    try:
        result = await asyncio.to_thread(
            plivo_client.calls.create,
            from_=from_number,
            to_=to_number,
            answer_url=answer_url,
            answer_method="POST",
        )
    except Exception as e:
        log.error("outbound call create failed — to=%s agent_id=%s: %s", to_number, agent_id, e)
        return {"error": f"Plivo call create failed: {e}"}

    call_uuid = getattr(result, "request_uuid", None) or (result.get("request_uuid") if isinstance(result, dict) else None)
    log.info("outbound call placed — to=%s from=%s agent_id=%s call_uuid=%s", to_number, from_number, agent_id, call_uuid)
    return {"status": "ok", "to": to_number, "from": from_number, "agent_id": agent_id, "call_uuid": call_uuid}


async def outbound_call(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON body"}, status=400)

    to_number = (body.get("to") or "").strip()
    agent_id  = (body.get("agent_id") or "").strip()
    host = request.headers.get("X-Forwarded-Host") or request.headers.get("Host", f"localhost:{PORT}")

    result = await place_outbound_call(to_number, agent_id, host)
    if "error" not in result:
        return web.json_response(result, status=200)
    if "required" in result["error"]:
        return web.json_response(result, status=400)
    if "assigned" in result["error"]:
        return web.json_response(result, status=400)
    return web.json_response(result, status=502)


# ── Console dialer prompt ───────────────────────────────────────────────────────
# NEW: runtime CLI prompt — lets you trigger an outbound call by typing a
# number directly in the terminal running `python server.py`, no curl/
# Postman needed. Runs as a background task alongside the web server;
# does not block request handling. Derives the public host from
# PLIVO_ANSWER_URL (same domain server.py's own answer webhook uses),
# so it works through the Cloudflare tunnel automatically. Disable by
# setting ENABLE_CLI_DIALER=false in .env if running as a service with
# no attached terminal (stdin would just block otherwise).
ENABLE_CLI_DIALER = os.getenv("ENABLE_CLI_DIALER", "true").lower() == "true"

async def _cli_dialer_loop():
    if not PLIVO_ANSWER_URL:
        log.warning("CLI dialer disabled — PLIVO_ANSWER_URL not set")
        return
    host = PLIVO_ANSWER_URL.split("://", 1)[-1].split("/", 1)[0]
    print(f"\n[dialer] outbound calling ready — host={host}")
    while True:
        try:
            to_number = await asyncio.to_thread(input, "[dialer] number to call (blank to skip): ")
            to_number = to_number.strip()
            if not to_number:
                continue
            agent_id = await asyncio.to_thread(input, "[dialer] agent_id [default]: ")
            agent_id = agent_id.strip() or DEFAULT_AGENT_ID
            result = await place_outbound_call(to_number, agent_id, host)
            if "error" in result:
                print(f"[dialer] FAILED: {result['error']}")
            else:
                print(f"[dialer] call placed — to={result['to']} from={result['from']} agent_id={result['agent_id']} call_uuid={result['call_uuid']}")
        except (EOFError, KeyboardInterrupt):
            log.info("CLI dialer stopped")
            return
        except Exception as e:
            log.error("CLI dialer error: %s", e)


# ── Plivo WS handler ──────────────────────────────────────────────────────────
# CHANGED: event names "start"/"stop"/"media" are IDENTICAL to the old
# Telnyx loop, and media.payload is read the exact same way — only the
# "start" field paths differ (see _start_session above). agent_id comes
# off the WS URL's query string (set in plivo_answer() above), read here
# at upgrade time and stashed on the Session before the message loop starts.

async def plivo_ws_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(max_msg_size=0)
    await ws.prepare(request)
    log.info("WS connected — agent_id=%s call_uuid=%s", request.query.get("agent_id", ""), request.query.get("call_uuid", ""))

    s               = Session()
    s.agent_id_hint = request.query.get("agent_id", "")   # from the WS URL, see plivo_answer()
    s.to_number     = request.query.get("to", "")
    s.from_number   = request.query.get("from", "")
    loop            = asyncio.get_running_loop()

    try:
        async for message in ws:
            if message.type != aiohttp.WSMsgType.TEXT:
                if message.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
                    log.info("[WS-CKPT] non-text message type=%s — breaking loop (exc=%s)", message.type, ws.exception())
                    break
                continue

            try:
                data  = json.loads(message.data)
                event = data.get("event")
            except json.JSONDecodeError:
                log.warning("[WS-CKPT] non-JSON message received, skipping: %.200s", message.data)
                continue

            if event == "connected":
                log.info("[WS-CKPT] 'connected' event received")
                continue

            elif event == "start":
                log.info("[WS-CKPT] 'start' event received — calling _start_session")
                ok = await _start_session(ws, s, data)
                log.info("[WS-CKPT] _start_session returned ok=%s", ok)
                if not ok:
                    await ws.close()
                    break

            elif event == "stop":
                clog(s.call_sid, "[WS-CKPT] 'stop' event — call ended by Plivo")
                break

            elif event == "media":
                if not s.agent_conn or not s.send_q:
                    continue
                payload = data.get("media", {}).get("payload")
                if payload:
                    _process_media(ws, s, base64.b64decode(payload), loop)

            else:
                log.info("[WS-CKPT] unknown event type received: %s", event)

    except Exception as e:
        log.error("[WS-CKPT] exception in WS loop: %s: %s", type(e).__name__, e)
    finally:
        log.info("[WS-CKPT] WS loop exited — running cleanup, call_sid=%s", getattr(s, "call_sid", None))
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
        "agent_name":      cfg.get("agent_name", "Assistant"),
    })
    return web.Response(text=body, content_type="application/json")

# ── Main ──────────────────────────────────────────────────────────────────────

async def main() -> None:
    app = web.Application()
    app.router.add_post("/plivo/answer", plivo_answer)
    app.router.add_post("/api/outbound-call", outbound_call)
    app.router.add_get("/ws/plivo",      plivo_ws_handler)
    app.router.add_get("/health",        health)
    app.router.add_get("/ping",          ping)

    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", PORT).start()
    log.info("server :%d — /plivo/answer | /ws/plivo | /health | /ping | /api/outbound-call", PORT)

    if ENABLE_CLI_DIALER:
        asyncio.create_task(_cli_dialer_loop())

    await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("server stopped")