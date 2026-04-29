#!/usr/bin/env python3
"""Generate six Seedance 2.0 mockup clips for the Brady pitch page via kie.ai.

Usage:
    export KIE_API_KEY='your-kie-api-key'
    pip install requests
    python3 generate_mockups.py          # generate all six
    python3 generate_mockups.py 01 03    # generate just the 01 and 03 clips
"""

import json
import os
import sys
import time
import urllib.request
from pathlib import Path

try:
    import requests
except ImportError:
    sys.stderr.write("[setup] requests not installed. Run: pip install requests\n")
    sys.exit(1)

API_KEY = os.environ.get("KIE_API_KEY")
if not API_KEY:
    sys.stderr.write("[setup] KIE_API_KEY env var not set. Run: export KIE_API_KEY='your-key'\n")
    sys.exit(1)

BASE_URL = "https://api.kie.ai"
MODEL = "bytedance/seedance-2"
RESOLUTION = os.environ.get("SEEDANCE_RESOLUTION", "720p")  # "480p" | "720p" | "1080p"
HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json",
}

VIDEOS_DIR = Path(__file__).parent / "videos"
VIDEOS_DIR.mkdir(exist_ok=True)


CLIPS = [
    {
        "id": "hero",
        "name": "hero",
        "title": "Hero loop (Brady cinematic establishing)",
        "duration": 10,
        "aspect_ratio": "16:9",
        "reference_image_urls": ["https://litter.catbox.moe/833pbi.jpg"],
        "prompt": (
            "Cinematic 10-second establishing shot for the hero of a Brady, Texas tourism proposal page. "
            "Slow low aerial drone push over US-87 at first light, two pickups rolling toward a small "
            "Hill Country town. The McCulloch County courthouse from the reference image rises from the "
            "townscape: 1899 Romanesque Revival, rusticated native sandstone, flanking turrets, central "
            "pressed-metal clock tower, Texas flag above. First warm sunlight begins hitting the "
            "courthouse turrets while the rest of the town is still in cool cobalt blue pre-dawn shadow. "
            "Mesquite and live oak silhouettes in the foreground, a thin mist hanging over a creek, "
            "the cobalt sky transitioning to warm sandstone gold at the horizon. Slow continuous camera "
            "motion. No cuts. No on-screen text. Cinematic warm-and-cobalt color grade, deep shadows, "
            "rich highlights, 35mm film feel, film grain on. Texas heritage palette."
        ),
    },
    {
        "id": "01",
        "name": "01-anthem",
        "title": "Heart of Texas, literally (anthem)",
        "duration": 5,
        "aspect_ratio": "16:9",
        "reference_image_urls": ["https://litter.catbox.moe/833pbi.jpg"],
        "prompt": (
            "Cinematic 5-second hero shot in Brady, Texas. A slow low-angle dolly push toward the "
            "McCulloch County courthouse shown in the reference image: 1899 Romanesque Revival, "
            "rusticated native sandstone walls, flanking turrets, central pressed-metal clock tower, "
            "Texas flag above. Render at golden hour, sandstone walls glowing warm in last sunlight. "
            "Single pickup truck rolling past in soft focus across the foreground, taillights glowing "
            "red. Warm sandstone highlights, deep cobalt shadows, Texas heritage palette. Shallow "
            "depth of field, 35mm film feel, film grain on. No on-screen text."
        ),
    },
    {
        "id": "02",
        "name": "02-cookoff",
        "title": "World Championship Goat Cook-Off recap",
        "duration": 5,
        "aspect_ratio": "16:9",
        "prompt": (
            "Cinematic 5-second hero shot at the World Championship BBQ Goat Cook-Off in Brady, Texas, at "
            "Richards Park, Labor Day weekend. Tight medium shot of a pitmaster in a sweat-stained cowboy "
            "hat lifting the lid off a black BBQ pit, white smoke billowing up into late-afternoon golden "
            "light, embers glowing inside, racks of cabrito visible, deep red glaze on the meat. Pecan "
            "canopy in the background blurred, other smoker rigs softly out of focus. Warm contrasty color "
            "grade, 35mm film feel, shallow focus, film grain on, no on-screen text."
        ),
    },
    {
        "id": "03",
        "name": "03-pitcox",
        "title": "Tracy Pitcox & the Country Music Museum",
        "duration": 5,
        "aspect_ratio": "16:9",
        "prompt": (
            "Cinematic 5-second hero shot inside the Heart of Texas Country Music Museum in Brady, Texas. "
            "Medium shot of a silver-haired man in his sixties wearing a pressed pearl-snap western shirt "
            "and a bolo tie, sitting on a stool, soft warm window light from camera left, vintage stage "
            "costumes on mannequins behind him in soft focus, a Nudie-style rhinestone jacket sparkling, "
            "a gold-plated guitar on a stand. He looks toward the camera with a small confident smile. "
            "Warm tungsten color grade, 35mm film feel, shallow depth of field, film grain on, no on-"
            "screen text, no dialog."
        ),
    },
    {
        "id": "04",
        "name": "04-brady-made",
        "title": "Brady Made (member spotlight opener)",
        "duration": 5,
        "aspect_ratio": "16:9",
        "prompt": (
            "Cinematic 5-second tactile hero shot in Brady, Texas. Tight macro of a pitmaster's gloved "
            "hands pulling a long brisket out of a black smoker, dark mahogany bark crust glistening, "
            "smoke steaming off the meat in slow motion, embers visible in the firebox below. Warm low-"
            "contrast color grade, 35mm film feel, shallow focus, film grain on, no on-screen text. "
            "Leave the final half second on a clean sandstone wall in the background so a Brady wordmark "
            "can be added in post."
        ),
    },
    {
        "id": "05",
        "name": "05-lake-land",
        "title": "Lake & Land (outfitter / lodging reel)",
        "duration": 5,
        "aspect_ratio": "16:9",
        "prompt": (
            "Cinematic 5-second hero shot of Brady Lake, Texas at first light. Low aerial drone shot "
            "skimming the surface of the lake, mist rising off the still water, a single small flat-"
            "bottom fishing boat with two figures casting toward a shoreline of mesquite and live oak, "
            "deep cobalt morning sky overhead transitioning to warm orange at the horizon. Shallow depth "
            "of field on the water, film grain on, cinematic warm-and-cobalt color grade, no on-screen "
            "text."
        ),
    },
    {
        "id": "06",
        "name": "06-square",
        "title": "The Square at Night (vertical honky-tonk cut)",
        "duration": 5,
        "aspect_ratio": "9:16",
        "reference_image_urls": ["https://litter.catbox.moe/833pbi.jpg"],
        "prompt": (
            "Cinematic 5-second vertical 9:16 hero shot of the Brady, Texas town square at night, late "
            "August Honky Tonk weekend. Low-angle medium shot looking up at the McCulloch County "
            "courthouse shown in the reference image: 1899 Romanesque Revival sandstone, flanking "
            "turrets, central pressed-metal clock tower. Render the courthouse uplit warm against a "
            "deep cobalt night sky, clock tower glowing, Texas flag floodlit, neon honky-tonk signage "
            "warming the foreground sidewalk, two cowboys in hats walking past in soft motion blur. "
            "Vertical native framing. Warm tungsten and cobalt color grade, film grain on, shallow "
            "depth of field, no on-screen text."
        ),
    },
]


def log(msg: str) -> None:
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def create_task(clip: dict) -> str:
    inp = {
        "prompt": clip["prompt"],
        "duration": clip["duration"],
        "aspect_ratio": clip["aspect_ratio"],
        "resolution": RESOLUTION,
        "generate_audio": False,
        "web_search": False,
        "nsfw_checker": False,
    }
    if clip.get("reference_image_urls"):
        inp["reference_image_urls"] = clip["reference_image_urls"]
    payload = {"model": MODEL, "input": inp}
    r = requests.post(f"{BASE_URL}/api/v1/jobs/createTask", headers=HEADERS, json=payload, timeout=30)
    body = r.json()
    if r.status_code != 200 or body.get("code") != 200:
        raise RuntimeError(f"createTask failed [{r.status_code}]: {body}")
    return body["data"]["taskId"]


def poll_task(task_id: str, timeout_s: int = 600) -> str:
    start = time.time()
    wait = 4.0
    last_state = None
    while time.time() - start < timeout_s:
        r = requests.get(
            f"{BASE_URL}/api/v1/jobs/recordInfo",
            headers=HEADERS,
            params={"taskId": task_id},
            timeout=30,
        )
        body = r.json()
        if r.status_code != 200 or body.get("code") != 200:
            raise RuntimeError(f"recordInfo failed [{r.status_code}]: {body}")
        data = body["data"]
        state = data.get("state")

        if state != last_state:
            log(f"    state: {state}")
            last_state = state

        if state == "success":
            result_json = data.get("resultJson")
            if not result_json:
                raise RuntimeError(f"success but no resultJson: {data}")
            result = json.loads(result_json)
            urls = result.get("resultUrls") or []
            if not urls:
                raise RuntimeError(f"success but no resultUrls: {result}")
            return urls[0]

        if state == "fail":
            raise RuntimeError(f"task failed: {data.get('failMsg') or data.get('failCode')}")

        time.sleep(wait)
        wait = min(wait * 1.3, 20.0)

    raise TimeoutError(f"task {task_id} did not finish within {timeout_s}s")


def download(url: str, dest: Path) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "BigSplash-Pitch-Builder/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        while True:
            chunk = r.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)


def run_one(clip: dict) -> None:
    log(f"[{clip['id']}] Submitting: {clip['title']} ({clip['duration']}s, {clip['aspect_ratio']}, {RESOLUTION})")
    t0 = time.time()
    task_id = create_task(clip)
    log(f"[{clip['id']}] taskId={task_id}")
    video_url = poll_task(task_id)
    elapsed = time.time() - t0
    log(f"[{clip['id']}] ready in {elapsed:.1f}s, downloading...")
    dest = VIDEOS_DIR / f"{clip['name']}.mp4"
    download(video_url, dest)
    size_mb = dest.stat().st_size / (1024 * 1024)
    log(f"[{clip['id']}] OK -> {dest.name} ({size_mb:.1f} MB)")


def main() -> int:
    only = set(sys.argv[1:])
    targets = [c for c in CLIPS if not only or c["id"] in only]
    if not targets:
        log(f"No clips matched ids={only}. Valid ids: {[c['id'] for c in CLIPS]}")
        return 1

    log(f"Generating {len(targets)} clip(s) at {RESOLUTION} via Seedance 2.0 on kie.ai")
    log(f"Output dir: {VIDEOS_DIR}")

    failures = []
    for clip in targets:
        try:
            run_one(clip)
        except Exception as e:
            log(f"[{clip['id']}] FAIL: {e}")
            failures.append(clip["id"])

    if failures:
        log(f"Done with {len(failures)} failure(s): {failures}")
        return 1
    log(f"Done. All {len(targets)} clip(s) saved to {VIDEOS_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
