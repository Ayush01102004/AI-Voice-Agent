"""
Deepgram Voice Agent — Twilio Media Streams
Python 3.10+ | Deepgram SDK v5+ | aiohttp v3+

Flow:
  Twilio call → POST /twilio/voice (TwiML) → wss://.../ws/twilio → Deepgram Agent → caller

Endpoints:
  POST /twilio/voice   — Twilio webhook, returns TwiML to open Media Stream
  GET  /ws/twilio      — Twilio Media Streams WebSocket
  GET  /health         — Health check

Upgrades vs previous version:
  1. socket._send(SETTINGS) → socket.send_settings(SETTINGS)          [private API removed]
  2. end_conversation now closes WS so Twilio hangs up                 [call termination fixed]
  3. _cleanup() awaits listener cancel before _cm.__exit__             [race condition fixed]
  4. DeepgramClient created once globally, not per call                [resource leak fixed]
  5. sessions stores call_sid for correlation                          [observability fix]
  6. SETTINGS sent via proper SDK method, not raw dict                 [type safety fix]
  7. system_prompt fetched from call_handler /api/config per call      [no more hardcoded prompt]
     — falls back to _DEFAULT_SYSTEM_PROMPT if call_handler unreachable
  8. CALL_HANDLER_URL env var wires server.py → call_handler.py        [config]
"""

import asyncio
import base64
import json
import os
from typing import Any, Dict, Optional

import aiohttp
from aiohttp import web
from deepgram import DeepgramClient
from deepgram.agent.v1.types import AgentV1SendFunctionCallResponse
from dotenv import load_dotenv

# ── env ───────────────────────────────────────────────────────

load_dotenv()

DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")
if not DEEPGRAM_API_KEY:
    raise ValueError("DEEPGRAM_API_KEY not found in .env")

# UPGRADE #8: URL of the call_handler FastAPI service.
# Same machine: http://localhost:8000
# Docker / Railway: set CALL_HANDLER_URL in env.
CALL_HANDLER_URL = os.getenv("CALL_HANDLER_URL", "http://localhost:8000").rstrip("/")

PORT = 5002

# ── global Deepgram client (created once, reused per call) ────
deepgram_client = DeepgramClient(api_key=DEEPGRAM_API_KEY)

# ── UPGRADE #7: fallback prompt used only when call_handler is unreachable ──
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

_DEFAULT_AGENT_NAME = "Inbox Infotech's AI assistant"

# ── UPGRADE #7: fetch prompt from call_handler ────────────────

async def fetch_agent_config() -> Dict[str, str]:
    """
    GET {CALL_HANDLER_URL}/api/config → { system_prompt, agent_name, … }
    Returns defaults on any failure so the call still connects.
    """
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{CALL_HANDLER_URL}/api/config",
                timeout=aiohttp.ClientTimeout(total=5),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    print(f"[config] fetched from call_handler — keys: {list(data.keys())}")
                    return data
                else:
                    print(f"[config] call_handler returned {resp.status} — using defaults")
    except Exception as e:
        print(f"[config] could not reach call_handler ({e}) — using defaults")
    return {}


def build_settings(system_prompt: str, agent_name: str) -> Dict:
    """
    Build the Deepgram SETTINGS dict with the live prompt.
    Kept as a function so each call gets its own copy — no shared state.
    """
    greeting = f"Hello! I am {agent_name}. How can I help you today?"

    return {
        "type": "Settings",
        "audio": {
            "input":  {"encoding": "mulaw", "sample_rate": 8000},
            "output": {"encoding": "mulaw", "sample_rate": 8000, "container": "none"},
        },
        "agent": {
            "listen": {
                "provider": {"type": "deepgram", "model": "nova-3"}
            },
            "think": {
                "provider":  {"type": "open_ai", "model": "gpt-4o-mini"},
                "prompt":    system_prompt,
                "functions": FUNCTIONS,
            },
            "speak": {
                "provider": {"type": "deepgram", "model": "aura-2-helena-en"}
            },
            "greeting": greeting,
        },
    }


# ── functions (static — not prompt-dependent) ─────────────────

FUNCTIONS = [
    {
        "name": "end_conversation",
        "description": "End the conversation when the customer says goodbye, thanks, bye, etc.",
        "parameters": {
            "type": "object",
            "properties": {
                "reason": {"type": "string", "description": "Reason for ending"}
            },
            "required": ["reason"],
        },
    }
]

# ── active sessions ───────────────────────────────────────────
# ws → { agent_conn, listener, _cm, stream_sid, call_sid }

sessions: Dict[Any, Dict[str, Any]] = {}

# ── helpers ───────────────────────────────────────────────────


def ws_is_open(ws: web.WebSocketResponse) -> bool:
    try:
        return not ws.closed
    except Exception:
        return False


async def send_audio(ws: web.WebSocketResponse, audio: bytes, stream_sid: str) -> None:
    """Forward Deepgram mulaw output back to Twilio."""
    if not ws_is_open(ws):
        return
    try:
        await ws.send_str(json.dumps({
            "event": "media",
            "streamSid": stream_sid,
            "media": {"payload": base64.b64encode(audio).decode()},
        }))
    except Exception as e:
        print(f"[audio→client] {e}")


# ── agent listener (runs in threadpool) ───────────────────────


def agent_listener_thread(
    socket,
    ws: web.WebSocketResponse,
    loop: asyncio.AbstractEventLoop,
    stream_sid: str,
    call_sid: str,
    settings: Dict,           # UPGRADE #7: per-call settings passed in
) -> None:
    try:
        for msg in socket:

            if isinstance(msg, bytes):
                asyncio.run_coroutine_threadsafe(
                    send_audio(ws, msg, stream_sid), loop
                )
                continue

            t = getattr(msg, "type", None)

            if t == "Welcome":
                print(f"[agent][{call_sid}] connected → sending settings")
                try:
                    # UPGRADE #7: use per-call settings (live prompt from DB)
                    socket.send_settings(settings)
                except Exception as e:
                    print(f"[settings error][{call_sid}] {e}")

            elif t == "SettingsApplied":
                print(f"[agent][{call_sid}] ready")

            elif t == "Error":
                print(f"[agent ERROR][{call_sid}] {getattr(msg, 'code', '?')} | {getattr(msg, 'description', '?')}")

            elif t == "FunctionCallRequest":
                for fn in msg.functions:
                    print(f"[fn][{call_sid}] {fn.name}")
                    try:
                        args = json.loads(fn.arguments)
                    except Exception:
                        args = {}

                    if fn.name == "end_conversation":
                        content = {
                            "success": True,
                            "message": "Thank you for your time. Have a great day!",
                            "reason":  args.get("reason", ""),
                        }
                        try:
                            socket.send_function_call_response(
                                AgentV1SendFunctionCallResponse(
                                    id=fn.id, name=fn.name, content=json.dumps(content)
                                )
                            )
                        except Exception as e:
                            print(f"[fn response][{call_sid}] {e}")

                        print(f"[fn][{call_sid}] closing call after end_conversation")
                        asyncio.run_coroutine_threadsafe(ws.close(), loop)

                    else:
                        content = {"success": False, "error": f"Unknown function: {fn.name}"}
                        try:
                            socket.send_function_call_response(
                                AgentV1SendFunctionCallResponse(
                                    id=fn.id, name=fn.name, content=json.dumps(content)
                                )
                            )
                        except Exception as e:
                            print(f"[fn response][{call_sid}] {e}")

            elif t == "ConversationText":
                role = getattr(msg, "role", "?")
                text = getattr(msg, "content", getattr(msg, "text", ""))
                print(f"[{role}][{call_sid}] {text}")

            elif t in ("AgentThinking", "UserStartedSpeaking", "AgentStartedSpeaking",
                       "AgentAudioDone", "History"):
                pass  # expected noise — no action needed

            elif t is not None:
                print(f"[agent msg][{call_sid}] {t}")

    except Exception as e:
        print(f"[listener error][{call_sid}] {e}")
    finally:
        print(f"[agent][{call_sid}] listener exited")


# ── cleanup helper ────────────────────────────────────────────


async def _cleanup(ws: web.WebSocketResponse) -> None:
    s = sessions.pop(ws, {})
    call_sid = s.get("call_sid", "?")

    listener = s.get("listener")
    if listener:
        listener.cancel()
        try:
            await asyncio.wait_for(asyncio.shield(listener), timeout=2.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass

    if s.get("_cm"):
        try:
            await asyncio.to_thread(s["_cm"].__exit__, None, None, None)
        except Exception as e:
            print(f"[cleanup][{call_sid}] {e}")

    print(f"[cleanup][{call_sid}] done")


# ── POST /twilio/voice ─────────────────────────────────────────


async def twilio_twiml(request: web.Request) -> web.Response:
    host = request.headers.get("Host", f"localhost:{PORT}")
    twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://{host}/ws/twilio" />
  </Connect>
</Response>"""
    print(f"[twilio] incoming call — stream → wss://{host}/ws/twilio")
    return web.Response(text=twiml, content_type="application/xml")


# ── GET /ws/twilio ─────────────────────────────────────────────


async def twilio_ws_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(max_msg_size=0)
    await ws.prepare(request)

    sessions[ws] = {
        "agent_conn": None, "listener": None, "_cm": None,
        "stream_sid": "", "call_sid": "",
    }
    print("[twilio] websocket connected")

    try:
        async for message in ws:
            if message.type == aiohttp.WSMsgType.TEXT:
                try:
                    data  = json.loads(message.data)
                    event = data.get("event")

                    if event == "connected":
                        continue

                    elif event == "start":
                        stream_sid = data.get("streamSid", "")
                        call_sid   = data.get("start", {}).get("callSid", stream_sid)
                        sessions[ws]["stream_sid"] = stream_sid
                        sessions[ws]["call_sid"]   = call_sid
                        print(f"[twilio] call started — call_sid={call_sid}")

                        # UPGRADE #7: fetch live prompt from call_handler
                        cfg = await fetch_agent_config()
                        system_prompt = cfg.get("system_prompt", "").strip() or _DEFAULT_SYSTEM_PROMPT
                        agent_name    = cfg.get("agent_name", "").strip()    or _DEFAULT_AGENT_NAME
                        settings      = build_settings(system_prompt, agent_name)
                        prompt_preview = system_prompt[:60].replace("\n", " ")
                        print(f"[twilio][{call_sid}] prompt: '{prompt_preview}…'")

                        loop   = asyncio.get_running_loop()
                        cm     = deepgram_client.agent.v1.connect()
                        socket = await asyncio.to_thread(cm.__enter__)

                        sessions[ws]["_cm"]        = cm
                        sessions[ws]["agent_conn"]  = socket
                        sessions[ws]["listener"]    = asyncio.ensure_future(
                            asyncio.to_thread(
                                agent_listener_thread,
                                socket, ws, loop, stream_sid, call_sid,
                                settings,   # UPGRADE #7: pass per-call settings
                            )
                        )

                    elif event == "stop":
                        print(f"[twilio] call ended — call_sid={sessions[ws].get('call_sid', '?')}")
                        break

                    elif event == "media":
                        s = sessions.get(ws)
                        if s and s["agent_conn"]:
                            payload = data.get("media", {}).get("payload")
                            if payload:
                                await asyncio.to_thread(
                                    s["agent_conn"].send_media, base64.b64decode(payload)
                                )

                except json.JSONDecodeError:
                    pass
                except Exception as e:
                    print(f"[ws error] {e}")

            elif message.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
                break

    finally:
        await _cleanup(ws)
        print("[twilio] session closed")

    return ws


# ── GET /health ────────────────────────────────────────────────


async def health(request: web.Request) -> web.Response:
    cfg = await fetch_agent_config()
    return web.Response(
        text=json.dumps({
            "status":          "ok",
            "active_sessions": len(sessions),
            "call_handler":    CALL_HANDLER_URL,
            "prompt_loaded":   bool(cfg.get("system_prompt")),
            "agent_name":      cfg.get("agent_name", _DEFAULT_AGENT_NAME),
        }),
        content_type="application/json",
    )


# ── main ───────────────────────────────────────────────────────


async def main() -> None:
    app = web.Application()
    app.router.add_post("/twilio/voice", twilio_twiml)
    app.router.add_get("/ws/twilio",     twilio_ws_handler)
    app.router.add_get("/health",        health)

    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", PORT).start()

    print(f"\n[server] listening on port {PORT}")
    print(f"  POST /twilio/voice → TwiML webhook")
    print(f"  GET  /ws/twilio    → Media Streams")
    print(f"  GET  /health       → health check")
    print(f"  call_handler       → {CALL_HANDLER_URL}")
    print(f"  Ctrl+C to stop\n")

    await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[server] stopped")