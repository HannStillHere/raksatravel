import httpx
import asyncio
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

async def upload_and_run_direct():
    async with httpx.AsyncClient(headers=headers, timeout=30.0) as client:
        # 1. Upload run_direct_sync.cjs to /wa_bot
        with open("C:\\Users\\Raihan\\raksatravel.github.io\\wa-bot\\run_direct_sync.cjs", "rb") as f:
            content = f.read()

        res_url = await client.get(f"{BASE_URL}/servers/{SERVER_ID}/files/upload")
        upload_base_url = res_url.json()["attributes"]["url"]
        target_url = f"{upload_base_url}&directory=%2Fwa_bot"

        res = await client.post(target_url, files={"files": ("run_direct_sync.cjs", content)})
        print("Upload run_direct_sync.cjs:", res.status_code)

        # 2. Modify cloud_runner.py to execute run_direct_sync.cjs once on boot
        # Let's read cloud_runner.py from VPS
        r_runner = await client.get(f"{BASE_URL}/servers/{SERVER_ID}/files/contents?file=cloud_runner.py")
        runner_code = r_runner.text

        # Add one-time execution in cloud_runner.py
        sync_hook = """
# Run immediate promo sync
try:
    print("🚀 Running one-time explicit channel promo sync...")
    subprocess.run("node run_direct_sync.cjs", cwd=os.path.join(BASE_DIR, "wa_bot"), shell=True)
    print("✅ Explicit channel promo sync completed!")
except Exception as e:
    print(f"⚠️ Promo sync error: {e}")
"""
        if "run_direct_sync.cjs" not in runner_code:
            runner_code = runner_code.replace('print("\\n✨ ALL 5 CLOUD SERVICES RUNNING', sync_hook + '\nprint("\\n✨ ALL 5 CLOUD SERVICES RUNNING')
            # Save cloud_runner.py
            res_url2 = await client.get(f"{BASE_URL}/servers/{SERVER_ID}/files/upload")
            upload_base_url2 = res_url2.json()["attributes"]["url"]
            await client.post(upload_base_url2, files={"files": ("cloud_runner.py", runner_code.encode("utf-8"))})
            print("Injected sync hook into cloud_runner.py!")

        # 3. Restart container to trigger sync immediately
        print("🔄 Restarting container to execute sync...")
        await client.post(f"{BASE_URL}/servers/{SERVER_ID}/power", json={"signal": "kill"})
        await asyncio.sleep(2)
        await client.post(f"{BASE_URL}/servers/{SERVER_ID}/power", json={"signal": "start"})

asyncio.run(upload_and_run_direct())
