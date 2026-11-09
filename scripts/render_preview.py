#!/usr/bin/env python3
"""Rasterize data/basemap.json to a PNG for visual inspection."""
import json, math, os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(ROOT, "data", "basemap.json"), encoding="utf-8") as f:
    b = json.load(f)

minLon, minLat, maxLon, maxLat = b["bbox"]
W = 2400
H = int(round(W * (maxLat - minLat) / (maxLon - minLon)))
S = 2  # supersample
CW, CH = W * S, H * S

def P(lon, lat):
    return ((lon - minLon) / (maxLon - minLon) * CW, (maxLat - lat) / (maxLat - minLat) * CH)

img = Image.new("RGB", (CW, CH), (247, 245, 239))
d = ImageDraw.Draw(img)

area_fill = {"water": (169, 214, 229), "park": (200, 230, 201), "grass": (220, 237, 200), "forest": (183, 215, 168)}
for a in b["areas"]:
    d.polygon([P(*p) for p in a["poly"]], fill=area_fill.get(a["kind"], (238, 238, 238)))
for s in b["sports"]:
    d.polygon([P(*p) for p in s["poly"]], fill=(244, 199, 138), outline=(217, 155, 78), width=1 * S)

road_style = {
    "tertiary": ((232, 176, 75), 5), "residential": ((217, 210, 197), 4), "unclassified": ((217, 210, 197), 4),
    "living_street": ((217, 210, 197), 3), "service": ((230, 226, 216), 2.5), "pedestrian": ((239, 233, 220), 6),
    "cycleway": ((201, 216, 176), 3), "footway": ((216, 207, 192), 1.6), "path": ((216, 207, 192), 1.4),
    "steps": ((200, 191, 174), 1.4), "track": ((203, 191, 154), 1.8),
}
for r in b["roads"]:
    c, w = road_style.get(r["class"], ((221, 221, 221), 2))
    d.line([P(*p) for p in r["line"]], fill=c, width=max(1, int(w * S)), joint="curve")

for bl in b["buildings"]:
    d.polygon([P(*p) for p in bl["poly"]], fill=(185, 178, 166), outline=(143, 136, 125), width=max(1, int(0.8 * S)))

d.line([P(*p) for p in b["boundary"][0]], fill=(211, 51, 51), width=2 * S)

font_path = "/System/Library/Fonts/PingFang.ttc"
if not os.path.exists(font_path):
    font_path = "/System/Library/Fonts/STHeiti Light.ttc"
font = ImageFont.truetype(font_path, 11 * S)
for bl in b["buildings"]:
    if not bl["name"]:
        continue
    pts = bl["poly"]
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    x, y = P(cx, cy)
    d.text((x, y), bl["name"], font=font, fill=(30, 30, 30), anchor="mm", stroke_width=1 * S, stroke_fill=(247, 245, 239))

out = os.path.join(ROOT, "scripts", "preview.png")
img.resize((W, H), Image.LANCZOS).save(out)
print(out, W, H)