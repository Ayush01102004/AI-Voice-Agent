# Deepgram Voice Agent — Python Port

Direct port of the Node/TypeScript server to Python.  
Protocol identical → same `index.html` frontend works unchanged.

## Stack
- `server.py` — asyncio WebSocket server (`websockets` lib)
- `index.html` — browser frontend (unchanged from TS version)
- Deepgram Python SDK for Voice Agent API

## Setup

```bash
pip install -r requirements.txt
```

Add your key to `.env`:
```
DEEPGRAM_API_KEY=your_key_here
```

## Run

```bash
python server.py
```

Then open `index.html` in browser (serve via any static server or just open file directly).

## Architecture map (TS → Python)

| TypeScript | Python |
|---|---|
| `createClient` + `deepgram.agent()` | `DeepgramClient` + `client.agent()` |
| `agent.on(AgentEvents.Audio, cb)` | `agent.on(AgentWebSocketEvents.Audio, cb)` |
| `agent.configure({...})` | `agent.configure({...})` |
| `WebSocketServer` (ws lib) | `websockets.serve` |
| `sessions: Map<WebSocket, ...>` | `sessions: Dict[WebSocketServerProtocol, ...]` |
| `agent.send(buffer)` | `agent.send(bytes)` via `asyncio.to_thread` |
| `agent.close()` | `agent.finish()` |

## Notes
- Agent SDK calls are synchronous → wrapped in `asyncio.to_thread` to avoid blocking event loop
- Audio callbacks fire on SDK threads → `asyncio.run_coroutine_threadsafe` to post back to asyncio loop
- Base64 JSON protocol identical to TS version (browser ↔ server message format unchanged)
