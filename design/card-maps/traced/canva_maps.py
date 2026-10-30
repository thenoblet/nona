"""Renders the six Canva maps, each the exact shape of the map frame it will fill."""
import json, subprocess, sys
from tepa_styles import styled_map, STYLES

FONTS = "/home/claude/nona/src/fonts/"
FRAMES = {
    # name: (frame width, frame height in Canva px, world view centre x, centre y, world view height)
    "first": (244.27, 147.26, 560, 400, 580),
    "premium": (137.54, 154.02, 700, 432, 664),
    "quiet": (183.77, 265.97, 702, 458, 736),
    "deco": (160.47, 168.30, 705, 432, 664),
    "ashanti": (122.51, 217.14, 708, 452, 724),
    "water": (183.39, 217.14, 700, 440, 712),
}
pages = {}
for name, (frame_width, frame_height, centre_x, centre_y, view_height) in FRAMES.items():
    content_height = frame_height * (1 - STYLES[name].get("top_space", 0))
    view_width = view_height * frame_width / content_height
    scale = frame_width / view_width  # frame px per world px
    caps = STYLES[name].get("caps")
    unit = (6.2 / (1.55 * scale)) if caps else (8.5 / (2.3 * scale))
    view = (centre_x - view_width / 2, centre_y - view_height / 2, view_width, view_height)
    body = styled_map(name, view, round(frame_width * 4), round(frame_height * 4), unit * 1.0)
    pages[name] = (
        "<!doctype html><html><head><meta charset='utf-8'><style>"
        f"@font-face{{font-family:'Cormorant Garamond';font-style:italic;font-weight:500;src:url(file://{FONTS}cormorant-garamond-latin-500-italic.woff2)}}"
        f"@font-face{{font-family:Jost;font-weight:500;src:url(file://{FONTS}jost-latin-500-normal.woff2)}}"
        f"@font-face{{font-family:Jost;font-weight:600;src:url(file://{FONTS}jost-latin-600-normal.woff2)}}"
        "html,body{margin:0;background:transparent}</style></head><body>" + body + "</body></html>"
    )
    open(f"canva-{name}.html", "w").write(pages[name])
print(json.dumps(list(pages)))
