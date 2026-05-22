"""
Deepgram Voice Agent - Python WebSocket Server
Compatible: Python 3.10+, Deepgram SDK v5+, aiohttp v3+, Windows

CallHippo + Twilio integration.

Both CallHippo Live Audio and Twilio Media Streams stream mulaw @ 8kHz
over WebSocket — the audio pipeline is identical for both providers.

Endpoints:
  POST /                  ← CallHippo call-status webhook (ack only)
  GET  /ws                ← CallHippo Live Audio WebSocket
  POST /twilio/voice      ← Twilio webhook — returns TwiML to open Media Stream
  GET  /ws/twilio         ← Twilio Media Streams WebSocket
  GET  /ws/browser        ← optional browser test client (linear16 @ 24kHz)
  GET  /health            ← health check
"""

import asyncio
import base64
import json
import os
from typing import Dict, Any

import aiohttp
from aiohttp import web
from deepgram import DeepgramClient
from deepgram.agent.v1.types import AgentV1SendFunctionCallResponse
from dotenv import load_dotenv

# ── env ───────────────────────────────────────────────────────────────────────

load_dotenv()

DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")
if not DEEPGRAM_API_KEY:
    raise ValueError("DEEPGRAM_API_KEY not found in .env")

PORT = 5002

# ── audio profiles ────────────────────────────────────────────────────────────

# CallHippo and Twilio both use mulaw @ 8kHz — same profile for both
PHONE_AUDIO = {
    "input":  {"encoding": "mulaw", "sample_rate": 8000},
    "output": {"encoding": "mulaw", "sample_rate": 8000, "container": "none"},
}

# Browser test client uses linear16 @ 24kHz
BROWSER_AUDIO = {
    "input":  {"encoding": "linear16", "sample_rate": 24000},
    "output": {"encoding": "linear16", "sample_rate": 24000, "container": "none"},
}

sessions: Dict[Any, Dict[str, Any]] = {}

# ── config ────────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """
You are a friendly and confident sales caller from Inbox Infotech.
You are speaking naturally on a real-time phone call.

STYLE:
- Speak naturally like a real human
- Keep replies short and conversational
- Be slightly persuasive, avoid long explanations

RULES:
- Never sound robotic or repeat yourself
- Stay relevant and concise

SERVICES:
- AI / ML Development  |  IoT Solutions  |  CRM / ERP
- Mobile & Web Development  |  Cloud & DevOps
- API Integration  |  Automation Solutions

GOAL:
Understand customer needs and guide the conversation naturally.
"""

FUNCTIONS = [
    {
        "name": "end_conversation",
        "description": "End the conversation naturally when customer says goodbye / that's all / thanks etc.",
        "parameters": {
            "type": "object",
            "properties": {
                "reason": {"type": "string", "description": "Why the conversation is ending"}
            },
            "required": ["reason"],
        },
    }
]


def build_settings(phone_mode: bool) -> dict:
    """Build Deepgram Agent settings dict based on session mode."""
    audio = PHONE_AUDIO if phone_mode else BROWSER_AUDIO
    return {
        "type": "Settings",
        "audio": audio,
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


# ── helpers ───────────────────────────────────────────────────────────────────


def ws_is_open(ws: web.WebSocketResponse) -> bool:
    try:
        return not ws.closed
    except Exception:
        return False


async def send_audio_to_client(
    ws: web.WebSocketResponse,
    audio_bytes: bytes,
    mode: str,          # "callhippo" | "twilio" | "browser"
    call_sid: str = "",
    stream_sid: str = "",
) -> None:
    """
    Forward Deepgram mulaw output back to the connected client.

    CallHippo expects:
      { "event": "media", "callSid": "<sid>", "media": { "payload": "<b64>" } }

    Twilio expects:
      { "event": "media", "streamSid": "<sid>", "media": { "payload": "<b64>" } }

    Browser expects:
      { "event": "audio", "media": { "payload": "<b64>" } }
    """
    try:
        if not ws_is_open(ws):
            return
        payload = base64.b64encode(audio_bytes).decode()

        if mode == "twilio":
            msg = json.dumps({
                "event": "media",
                "streamSid": stream_sid,
                "media": {"payload": payload},
            })
        elif mode == "callhippo":
            msg = json.dumps({
                "event": "media",
                "callSid": call_sid,
                "media": {"payload": payload},
            })
        else:
            msg = json.dumps({
                "event": "audio",
                "media": {"payload": payload},
            })

        await ws.send_str(msg)
    except Exception as e:
        print(f"[audio→client error] {e}")


# ── agent listener thread ─────────────────────────────────────────────────────


def agent_listener_thread(
    socket,
    ws: web.WebSocketResponse,
    loop: asyncio.AbstractEventLoop,
    mode: str,          # "callhippo" | "twilio" | "browser"
    call_sid: str,
    stream_sid: str = "",
) -> None:
    """
    Drains Deepgram V1SocketClient (blocking iterator). Runs in threadpool.

    Message types:
      bytes                      → raw PCM/mulaw audio → forward to client
      Welcome                    → send Settings
      SettingsApplied            → ready
      FunctionCallRequest        → execute fn, send response
      ConversationText           → transcript log
      Error                      → log code + description
      AgentThinking / noise      → suppressed
    """
    try:
        for msg in socket:
            if isinstance(msg, bytes):
                asyncio.run_coroutine_threadsafe(
                    send_audio_to_client(ws, msg, mode, call_sid, stream_sid),
                    loop,
                )
                continue

            msg_type = getattr(msg, "type", None)

            if msg_type == "Welcome":
                print(
                    f"[agent] welcome (request_id={getattr(msg, 'request_id', '?')}) "
                    f"mode={mode} — sending settings"
                )
                try:
                    socket._send(build_settings(phone_mode=(mode != "browser")))
                    print("[agent] settings sent")
                except Exception as e:
                    print(f"[settings error] {e}")

            elif msg_type == "SettingsApplied":
                print("[agent] settings applied — ready")

            elif msg_type == "Error":
                code = getattr(msg, "code", "?")
                desc = getattr(msg, "description", "?")
                print(f"[agent ERROR] code={code} | {desc}")

            elif msg_type == "FunctionCallRequest":
                for fn in msg.functions:
                    print(f"[function call] {fn.name}({fn.arguments})")
                    try:
                        args = json.loads(fn.arguments)
                    except Exception:
                        args = {}

                    if fn.name == "end_conversation":
                        content = {
                            "success": True,
                            "message": "Thank you for your time. Have a great day!",
                            "reason": args.get("reason", ""),
                        }
                    else:
                        content = {"success": False, "error": f"Unknown function: {fn.name}"}

                    try:
                        socket.send_function_call_response(
                            AgentV1SendFunctionCallResponse(
                                id=fn.id,
                                name=fn.name,
                                content=json.dumps(content),
                            )
                        )
                    except Exception as e:
                        print(f"[fn response error] {e}")

            elif msg_type == "ConversationText":
                role = getattr(msg, "role", "?")
                text = getattr(msg, "content", getattr(msg, "text", ""))
                print(f"[{role}] {text}")

            elif msg_type in (
                "AgentThinking", "UserStartedSpeaking", "AgentStartedSpeaking",
                "AgentAudioDone", "History",
            ):
                pass  # suppress noise

            elif msg_type is not None:
                print(f"[agent msg] {msg_type}")

    except Exception as e:
        print(f"[listener error] {e}")
    finally:
        print("[agent] listener exited")


# ── HTTP: CallHippo call-status webhook ───────────────────────────────────────


async def callhippo_status_webhook(request: web.Request) -> web.Response:
    """
    CallHippo POSTs call-status events here (e.g. call started, ringing).
    Post-call processing (transcription, lead extraction) is handled by
    call_handler.py on port 8000 — this handler just acknowledges.
    """
    try:
        body = await request.json()
        event    = body.get("event", body.get("status", "unknown"))
        call_sid = body.get("callSid", body.get("call_sid", "?"))
        print(f"[webhook] CallHippo event={event} call_sid={call_sid}")
    except Exception:
        pass  # non-JSON ping — ignore body, still 200
    return web.Response(text="OK", status=200)


# ── HTTP: Twilio TwiML webhook ────────────────────────────────────────────────


async def twilio_twiml(request: web.Request) -> web.Response:
    """
    Twilio calls this HTTP POST when an inbound call arrives.
    We respond with TwiML XML instructing Twilio to open a Media Stream
    WebSocket back to this server at /ws/twilio.

    Twilio reads the Host header to know your public URL (ngrok / production).
    """
    host = request.headers.get("Host", "localhost:5002")
    twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://{host}/ws/twilio" />
  </Connect>
</Response>"""
    print(f"[twilio] TwiML served — stream url=wss://{host}/ws/twilio")
    return web.Response(text=twiml, content_type="application/xml")


# ── WebSocket: Twilio Media Streams ──────────────────────────────────────────


async def twilio_ws_handler(request: web.Request) -> web.WebSocketResponse:
    """
    Handles Twilio Media Streams WebSocket connections.

    Twilio Media Streams protocol:
      → { "event": "connected" }
      → { "event": "start",
           "streamSid": "<sid>",
           "start": { "callSid": "<sid>", ... } }
      → { "event": "media",
           "media": { "payload": "<b64 mulaw @ 8kHz>" } }
      → { "event": "stop" }

    Key difference from CallHippo:
      - Session ID for audio replies uses streamSid (not callSid)
      - callSid is nested inside start.callSid
    """
    ws = web.WebSocketResponse(max_msg_size=0)
    await ws.prepare(request)

    print("[server] Twilio client connected")
    sessions[ws] = {
        "agent_conn": None,
        "listener":   None,
        "_cm":        None,
        "call_sid":   "",
        "stream_sid": "",
    }

    try:
        async for message in ws:
            if message.type == aiohttp.WSMsgType.TEXT:
                try:
                    data  = json.loads(message.data)
                    event = data.get("event")

                    # ── handshake ─────────────────────────────────────────
                    if event == "connected":
                        print("[server] Twilio connected handshake")
                        continue

                    # ── session start ─────────────────────────────────────
                    if event == "start":
                        stream_sid = data.get("streamSid", "")
                        call_sid   = data.get("start", {}).get("callSid", stream_sid)
                        sessions[ws]["call_sid"]   = call_sid
                        sessions[ws]["stream_sid"] = stream_sid
                        print(f"[server] Twilio start — call_sid={call_sid} stream_sid={stream_sid}")

                        loop   = asyncio.get_running_loop()
                        client = DeepgramClient(api_key=DEEPGRAM_API_KEY)

                        cm     = client.agent.v1.connect()
                        socket = await asyncio.to_thread(cm.__enter__)

                        sessions[ws]["agent_conn"] = socket
                        sessions[ws]["_cm"]        = cm

                        listener = asyncio.ensure_future(
                            asyncio.to_thread(
                                agent_listener_thread,
                                socket, ws, loop,
                                "twilio",       # mode
                                call_sid,
                                stream_sid,
                            )
                        )
                        sessions[ws]["listener"] = listener
                        print(f"[server] Deepgram agent connected for Twilio call_sid={call_sid}")
                        continue

                    # ── call ended ────────────────────────────────────────
                    if event == "stop":
                        print(f"[server] Twilio stop — call_sid={sessions[ws].get('call_sid', '?')}")
                        break

                    # ── audio chunk ───────────────────────────────────────
                    if event == "media":
                        s = sessions.get(ws)
                        if s and s["agent_conn"]:
                            payload = data.get("media", {}).get("payload")
                            if payload:
                                audio_bytes = base64.b64decode(payload)
                                await asyncio.to_thread(s["agent_conn"].send_media, audio_bytes)

                except json.JSONDecodeError:
                    pass
                except Exception as e:
                    print(f"[twilio ws error] {e}")

            elif message.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
                break

    finally:
        print("[server] Twilio client disconnected — cleaning up")
        s = sessions.pop(ws, {})

        listener = s.get("listener")
        if listener:
            listener.cancel()

        cm = s.get("_cm")
        if cm:
            try:
                await asyncio.to_thread(cm.__exit__, None, None, None)
            except Exception as e:
                print(f"[cleanup error] {e}")

        print(f"[server] Twilio session cleaned (call_sid={s.get('call_sid', '?')})")

    return ws


# ── WebSocket: CallHippo Live Audio ───────────────────────────────────────────


async def callhippo_ws_handler(request: web.Request) -> web.WebSocketResponse:
    """
    Handles CallHippo Live Audio WebSocket connections.

    CallHippo Live Audio protocol:
      → { "event": "connected" }           handshake
      → { "event": "start",
           "callSid": "<sid>",
           "start": { "callSid": "<sid>", ... } }   session start
      → { "event": "media",
           "callSid": "<sid>",
           "media": { "payload": "<b64 mulaw>" } }  audio chunk
      → { "event": "stop", "callSid": "<sid>" }     call ended
    """
    ws = web.WebSocketResponse(max_msg_size=0)
    await ws.prepare(request)

    print("[server] CallHippo client connected")
    sessions[ws] = {
        "agent_conn": None,
        "listener":   None,
        "_cm":        None,
        "call_sid":   "",
    }

    try:
        async for message in ws:
            if message.type == aiohttp.WSMsgType.TEXT:
                try:
                    data  = json.loads(message.data)
                    event = data.get("event")

                    if event == "connected":
                        print("[server] CallHippo connected handshake")
                        continue

                    if event == "start":
                        call_sid = (
                            data.get("callSid")
                            or data.get("start", {}).get("callSid", "")
                        )
                        sessions[ws]["call_sid"] = call_sid
                        print(f"[server] CallHippo start — call_sid={call_sid} — connecting to Deepgram…")

                        loop   = asyncio.get_running_loop()
                        client = DeepgramClient(api_key=DEEPGRAM_API_KEY)

                        cm     = client.agent.v1.connect()
                        socket = await asyncio.to_thread(cm.__enter__)

                        sessions[ws]["agent_conn"] = socket
                        sessions[ws]["_cm"]        = cm

                        listener = asyncio.ensure_future(
                            asyncio.to_thread(
                                agent_listener_thread,
                                socket, ws, loop,
                                "callhippo",    # mode
                                call_sid,
                            )
                        )
                        sessions[ws]["listener"] = listener
                        print(f"[server] Deepgram agent connected for CallHippo call_sid={call_sid}")
                        continue

                    if event == "stop":
                        call_sid = data.get("callSid", sessions[ws].get("call_sid", "?"))
                        print(f"[server] CallHippo stop event — call_sid={call_sid}")
                        break

                    if event == "media":
                        s = sessions.get(ws)
                        if s and s["agent_conn"]:
                            payload = data.get("media", {}).get("payload")
                            if payload:
                                audio_bytes = base64.b64decode(payload)
                                await asyncio.to_thread(s["agent_conn"].send_media, audio_bytes)

                except json.JSONDecodeError:
                    pass
                except Exception as e:
                    print(f"[callhippo ws error] {e}")

            elif message.type == aiohttp.WSMsgType.BINARY:
                s = sessions.get(ws)
                if s and s["agent_conn"]:
                    await asyncio.to_thread(s["agent_conn"].send_media, message.data)

            elif message.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
                break

    finally:
        print("[server] CallHippo client disconnected — cleaning up")
        s = sessions.pop(ws, {})

        listener = s.get("listener")
        if listener:
            listener.cancel()

        cm = s.get("_cm")
        if cm:
            try:
                await asyncio.to_thread(cm.__exit__, None, None, None)
            except Exception as e:
                print(f"[cleanup error] {e}")

        print(f"[server] CallHippo session cleaned (call_sid={s.get('call_sid', '?')})")

    return ws


# ── WebSocket: browser test client (optional) ─────────────────────────────────


async def browser_ws_handler(request: web.Request) -> web.WebSocketResponse:
    """
    Optional browser test client — linear16 @ 24kHz.
    Connect your HTML test page to ws://localhost:5002/ws/browser

    Protocol:
      → raw binary bytes          microphone PCM audio
      → { "event": "start" }      begin session
      ← { "event": "audio", "media": { "payload": "<b64>" } }  agent speech
    """
    ws = web.WebSocketResponse(max_msg_size=0)
    await ws.prepare(request)

    print("[server] browser client connected")
    sessions[ws] = {
        "agent_conn": None,
        "listener":   None,
        "_cm":        None,
        "call_sid":   "browser",
    }

    try:
        async for message in ws:
            if message.type == aiohttp.WSMsgType.BINARY:
                s = sessions.get(ws)
                if s and s["agent_conn"]:
                    await asyncio.to_thread(s["agent_conn"].send_media, message.data)
                continue

            if message.type == aiohttp.WSMsgType.TEXT:
                try:
                    data  = json.loads(message.data)
                    event = data.get("event")

                    if event == "start":
                        print("[server] browser session start — connecting to Deepgram…")
                        loop   = asyncio.get_running_loop()
                        client = DeepgramClient(api_key=DEEPGRAM_API_KEY)

                        cm     = client.agent.v1.connect()
                        socket = await asyncio.to_thread(cm.__enter__)

                        sessions[ws]["agent_conn"] = socket
                        sessions[ws]["_cm"]        = cm

                        listener = asyncio.ensure_future(
                            asyncio.to_thread(
                                agent_listener_thread,
                                socket, ws, loop,
                                "browser",      # mode
                                "browser",
                            )
                        )
                        sessions[ws]["listener"] = listener
                        print("[server] Deepgram agent connected [browser]")

                    elif event == "media":
                        s = sessions.get(ws)
                        if s and s["agent_conn"]:
                            payload = data.get("media", {}).get("payload")
                            if payload:
                                await asyncio.to_thread(
                                    s["agent_conn"].send_media,
                                    base64.b64decode(payload),
                                )

                except json.JSONDecodeError:
                    pass
                except Exception as e:
                    print(f"[browser ws error] {e}")

            elif message.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
                break

    finally:
        print("[server] browser client disconnected — cleaning up")
        s = sessions.pop(ws, {})

        listener = s.get("listener")
        if listener:
            listener.cancel()

        cm = s.get("_cm")
        if cm:
            try:
                await asyncio.to_thread(cm.__exit__, None, None, None)
            except Exception as e:
                print(f"[cleanup error] {e}")

        print("[server] browser session cleaned")

    return ws


# ── health check ──────────────────────────────────────────────────────────────


async def health(request: web.Request) -> web.Response:
    return web.Response(
        text=json.dumps({"status": "ok", "active_sessions": len(sessions)}),
        content_type="application/json",
    )


# ── main ──────────────────────────────────────────────────────────────────────


async def main() -> None:
    app = web.Application()

    # CallHippo status webhook (HTTP POST)
    app.router.add_post("/",               callhippo_status_webhook)

    # Twilio TwiML webhook (HTTP POST) — Twilio calls this when a call arrives
    app.router.add_post("/twilio/voice",   twilio_twiml)

    # Twilio Media Streams WebSocket
    app.router.add_get("/ws/twilio",       twilio_ws_handler)

    # CallHippo Live Audio WebSocket
    app.router.add_get("/ws",              callhippo_ws_handler)

    # Optional browser test client
    app.router.add_get("/ws/browser",      browser_ws_handler)

    # Health
    app.router.add_get("/health",          health)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", PORT)
    await site.start()

    print(f"[server] listening on port {PORT}")
    print(f"[server] CallHippo status webhook  : POST http://0.0.0.0:{PORT}/")
    print(f"[server] CallHippo Live Audio WS   : ws://0.0.0.0:{PORT}/ws")
    print(f"[server] Twilio TwiML webhook      : POST http://0.0.0.0:{PORT}/twilio/voice")
    print(f"[server] Twilio Media Streams WS   : ws://0.0.0.0:{PORT}/ws/twilio")
    print(f"[server] Browser test client WS    : ws://0.0.0.0:{PORT}/ws/browser")
    print(f"[server] Health check              : GET  http://0.0.0.0:{PORT}/health")
    print("[server] Ctrl+C to stop")

    await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[server] stopped")