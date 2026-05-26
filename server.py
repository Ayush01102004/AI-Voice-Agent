"""
Deepgram Voice Agent — Twilio Media Streams
Python 3.10+ | Deepgram SDK v5+ | aiohttp v3+

Flow:
  Twilio call → POST /twilio/voice (TwiML) → wss://.../ws/twilio → Deepgram Agent → caller

Endpoints:
  POST /twilio/voice   — Twilio webhook, returns TwiML to open Media Stream
  GET  /ws/twilio      — Twilio Media Streams WebSocket
  GET  /health         — Health check
"""

import asyncio
import base64
import json
import os
from typing import Any, Dict

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

PORT = 5002

# ── config ────────────────────────────────────────────────────

SYSTEM_PROMPT = """
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
"""

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

SETTINGS = {
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
            "provider": {"type": "open_ai", "model": "gpt-4o-mini"},
            "prompt": SYSTEM_PROMPT,
            "functions": FUNCTIONS,
        },
        "speak": {
            "provider": {"type": "deepgram", "model": "aura-2-helena-en"}
        },
        "greeting": "Hello! I am Inbox Infotech's AI assistant. How can I help you today?",
    },
}

# ── active sessions: ws → {agent_conn, listener, _cm, stream_sid} ────────────

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
                print("[agent] connected → sending settings")
                try:
                    socket._send(SETTINGS)
                except Exception as e:
                    print(f"[settings error] {e}")

            elif t == "SettingsApplied":
                print("[agent] ready")

            elif t == "Error":
                print(f"[agent ERROR] {getattr(msg, 'code', '?')} | {getattr(msg, 'description', '?')}")

            elif t == "FunctionCallRequest":
                for fn in msg.functions:
                    print(f"[fn] {fn.name}")
                    try:
                        args = json.loads(fn.arguments)
                    except Exception:
                        args = {}

                    content = (
                        {"success": True, "message": "Thank you for your time. Have a great day!", "reason": args.get("reason", "")}
                        if fn.name == "end_conversation"
                        else {"success": False, "error": f"Unknown function: {fn.name}"}
                    )

                    try:
                        socket.send_function_call_response(
                            AgentV1SendFunctionCallResponse(
                                id=fn.id, name=fn.name, content=json.dumps(content)
                            )
                        )
                    except Exception as e:
                        print(f"[fn response] {e}")

            elif t == "ConversationText":
                role = getattr(msg, "role", "?")
                text = getattr(msg, "content", getattr(msg, "text", ""))
                print(f"[{role}] {text}")

            elif t in ("AgentThinking", "UserStartedSpeaking", "AgentStartedSpeaking",
                       "AgentAudioDone", "History"):
                pass  # expected noise — no action needed

            elif t is not None:
                print(f"[agent msg] {t}")  # catch new Deepgram message types

    except Exception as e:
        print(f"[listener error] {e}")
    finally:
        print("[agent] listener exited")


# ── cleanup helper (shared by ws handler finally block) ───────


async def _cleanup(ws: web.WebSocketResponse) -> None:
    s = sessions.pop(ws, {})
    if s.get("listener"):
        s["listener"].cancel()
    if s.get("_cm"):
        try:
            await asyncio.to_thread(s["_cm"].__exit__, None, None, None)
        except Exception as e:
            print(f"[cleanup] {e}")


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

    sessions[ws] = {"agent_conn": None, "listener": None, "_cm": None, "stream_sid": ""}
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
                        print(f"[twilio] call started — call_sid={call_sid}")

                        loop   = asyncio.get_running_loop()
                        cm     = DeepgramClient(api_key=DEEPGRAM_API_KEY).agent.v1.connect()
                        socket = await asyncio.to_thread(cm.__enter__)

                        sessions[ws]["_cm"]        = cm
                        sessions[ws]["agent_conn"]  = socket
                        sessions[ws]["listener"]    = asyncio.ensure_future(
                            asyncio.to_thread(agent_listener_thread, socket, ws, loop, stream_sid)
                        )

                    elif event == "stop":
                        print("[twilio] call ended")
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
    return web.Response(
        text=json.dumps({"status": "ok", "active_sessions": len(sessions)}),
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
    print(f"  Ctrl+C to stop\n")

    await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[server] stopped")