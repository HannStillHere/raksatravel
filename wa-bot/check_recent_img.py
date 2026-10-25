import asyncio
import json
import httpx
import websockets
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

API_KEY = "ptlc_tHvuUGvcoIURbsFjK6EmtwdXA0KTi9d0b2Oif0hWcUZ"
BASE_URL = "https://panel.ronzzyt.id/api/client"
SERVER_ID = "bb9a0b4e"

headers = {
    "Authorization": f"Bearer {API_KEY}",
    "Accept": "application/json"
}

async def get_recent_img_logs():
    async with httpx.AsyncClient(headers=headers, timeout=10.0) as client:
        r = await client.get(f"{BASE_URL}/servers/{SERVER_ID}/websocket")
        data = r.json().get("data", {})
        token = data.get("token")
        socket_url = data.get("socket")

    async with websockets.connect(socket_url, additional_headers={"Origin": "https://panel.ronzzyt.id"}, close_timeout=2) as ws:
        await ws.send(json.dumps({"event": "auth", "args": [token]}))
        await ws.send(json.dumps({"event": "send logs", "args": [None]}))

        logs = []
        try:
            for _ in range(120):
                msg = await asyncio.wait_for(ws.recv(), timeout=1.5)
                parsed = json.loads(msg)
                if parsed.get("event") == "console output":
                    logs.append(parsed.get("args", [""])[0])
        except Exception:
            pass

        print("=== RECENT 50 LOGS ===")
        print("\n".join(logs[-50:]))

asyncio.run(get_recent_img_logs())
