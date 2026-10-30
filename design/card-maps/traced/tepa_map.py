"""The church and reception in Tepa, traced from the satellite view the couple shared.

World coordinates are pixels of that satellite image (1139 x 947, north up). Each card asks for
its own window onto the world (a viewBox) and its own look (a style), and gets an SVG back.
"""

import random

# Dirt roads, traced along their centre lines.
ROADS = {
    "west": [(255, -40), (300, 130), (360, 250), (410, 370), (440, 470), (452, 522)],
    "cross": [(-60, 718), (110, 652), (200, 616), (300, 580), (380, 550), (452, 522), (550, 498), (650, 460), (745, 422)],
    "east": [(565, -40), (610, 90), (650, 190), (690, 290), (730, 380), (748, 420), (790, 500), (830, 570), (862, 612)],
    "far_east": [(835, -40), (900, 130), (950, 230), (1000, 330), (1060, 430), (1100, 505)],
    "north": [(-60, 133), (100, 85), (200, 57), (262, 35)],
}
# The paved main road, running south-west to north-east below the houses.
MAIN_ROAD = [(-80, 975), (300, 850), (560, 760), (760, 680), (880, 612), (1000, 562), (1220, 472)]

# Roofs, as (left, top, right, bottom) boxes, traced roughly.
BUILDINGS = [
    (380, 150, 450, 232), (340, 88, 410, 150), (420, 58, 500, 118), (450, 30, 520, 60),
    (530, 278, 600, 330), (590, 268, 650, 332), (560, 368, 640, 450), (620, 350, 690, 420),
    (465, 338, 525, 398), (720, 205, 785, 240), (800, 230, 860, 298), (840, 88, 892, 160),
    (900, 288, 960, 340), (932, 398, 1002, 448), (980, 160, 1040, 222), (640, 60, 720, 110),
    (200, 88, 250, 150), (160, 155, 200, 190), (250, 280, 290, 340), (245, 355, 330, 395),
    (200, 390, 245, 445), (285, 445, 320, 500), (100, 440, 150, 500), (100, 495, 170, 545),
    (20, 250, 80, 300), (460, 550, 560, 620), (490, 630, 560, 672), (560, 640, 600, 700),
    (30, 520, 90, 575), (130, 330, 175, 380), (700, 20, 790, 75), (880, 50, 940, 110),
]
# Trees: the wooded block between the east road and the main road, and smaller groves.
GROVES = [
    {"left": 560, "top": 470, "right": 820, "bottom": 690, "spacing": 22},
    {"left": 120, "top": 250, "right": 240, "bottom": 330, "spacing": 24},
    {"left": 900, "top": 470, "right": 1080, "bottom": 560, "spacing": 24},
    {"left": 240, "top": 600, "right": 420, "bottom": 720, "spacing": 26},
]

CHURCH = {"box": (492, 160, 542, 222), "pin": (517, 180)}
RECEPTION = {"box": (452, 404, 528, 452), "pin": (489, 418)}

LIGHT = {
    "ground": "#FAF6F4", "block": "#F3EBE6", "building": "#EDE2DC", "tree": "#E9DED7",
    "casing": "#E3D4CB", "road": "#FFFFFF", "main_casing": "#D9C7BC", "main": "#FFFFFF",
    "church": "#E87F39", "reception": "#6A524C", "pin": "#3D2927", "pin_dot": "#E87F39",
    "pin_number": "#3D2927", "label": "#3D2927", "small": "#6A524C", "card": "#FFFFFF",
    "card_edge": "#EADFDA",
}


def _path(points):
    """A smooth curve through the traced points (Catmull-Rom as cubic Béziers)."""
    commands = [f"M{points[0][0]:.1f} {points[0][1]:.1f}"]
    for index in range(len(points) - 1):
        before = points[max(index - 1, 0)]
        start, end = points[index], points[index + 1]
        after = points[min(index + 2, len(points) - 1)]
        first = (start[0] + (end[0] - before[0]) / 6, start[1] + (end[1] - before[1]) / 6)
        second = (end[0] - (after[0] - start[0]) / 6, end[1] - (after[1] - start[1]) / 6)
        commands.append(
            f"C{first[0]:.1f} {first[1]:.1f} {second[0]:.1f} {second[1]:.1f} {end[0]:.1f} {end[1]:.1f}"
        )
    return "".join(commands)


# The streets run about 21 degrees off north, and the houses face them.
TILT = -21


def _roof(box, radius, extra=""):
    left, top, right, bottom = box
    centre_x, centre_y = (left + right) / 2, (top + bottom) / 2
    return (
        f'<rect x="{left}" y="{top}" width="{right - left}" height="{bottom - top}" rx="{radius}" '
        f'transform="rotate({TILT} {centre_x:.1f} {centre_y:.1f})"{extra}/>'
    )


def _pin(position, number, style, scale):
    x, y = position
    size = 14 * scale
    return (
        f'<g transform="translate({x:.1f} {y:.1f})">'
        f'<path d="M0 0C0 0 {-size:.1f} {-size * 0.86:.1f} {-size:.1f} {-size * 1.64:.1f}'
        f'a{size:.1f} {size:.1f} 0 0 1 {2 * size:.1f} 0C{size:.1f} {-size * 0.86:.1f} 0 0 0 0z" '
        f'fill="{style["pin"]}" stroke="#FFFFFF" stroke-width="{2 * scale:.1f}"/>'
        f'<circle cx="0" cy="{-size * 1.64:.1f}" r="{size * 0.6:.1f}" fill="{style["pin_dot"]}"/>'
        f'<text x="0" y="{-size * 1.64 + size * 0.27:.1f}" text-anchor="middle" font-family="Jost, sans-serif" '
        f'font-size="{size * 0.75:.1f}" font-weight="600" fill="{style["pin_number"]}">{number}</text></g>'
    )


def map_svg(view, style=LIGHT, scale=1.0, label_size=17, landmarks=True, compass=True, aria=True, caption=True):
    """The map for one window, `view` = (left, top, width, height) in world pixels."""
    left, top, width, height = view
    road = 10 * scale
    parts = [f'<rect x="{left}" y="{top}" width="{width}" height="{height}" fill="{style["ground"]}"/>']

    # Trees as loose clusters of soft crowns, placed the same way every time.
    generator = random.Random(26)
    trees = []
    for grove in GROVES:
        spacing = grove["spacing"] * 1.25
        y = grove["top"]
        while y < grove["bottom"]:
            x = grove["left"]
            while x < grove["right"]:
                if generator.random() < 0.7:
                    crown_x = x + generator.uniform(-spacing / 3, spacing / 3)
                    crown_y = y + generator.uniform(-spacing / 3, spacing / 3)
                    radius = spacing * generator.uniform(0.32, 0.5)
                    trees.append(f'<circle cx="{crown_x:.0f}" cy="{crown_y:.0f}" r="{radius:.1f}"/>')
                x += spacing
            y += spacing * 0.9
    parts.append(f'<g fill="{style["tree"]}" fill-opacity="0.8">{"".join(trees)}</g>')
    parts.append(f'<g fill="{style["building"]}">' + "".join(_roof(box, 3) for box in BUILDINGS) + "</g>")

    lines = []
    for points in ROADS.values():
        lines.append(f'<path d="{_path(points)}" stroke="{style["casing"]}" stroke-width="{road + 5 * scale:.1f}"/>')
    lines.append(f'<path d="{_path(MAIN_ROAD)}" stroke="{style["main_casing"]}" stroke-width="{road * 2.1 + 5 * scale:.1f}"/>')
    for points in ROADS.values():
        lines.append(f'<path d="{_path(points)}" stroke="{style["road"]}" stroke-width="{road:.1f}"/>')
    lines.append(f'<path d="{_path(MAIN_ROAD)}" stroke="{style["main"]}" stroke-width="{road * 2.1:.1f}"/>')
    parts.append(f'<g fill="none" stroke-linecap="round" stroke-linejoin="round">{"".join(lines)}</g>')

    for place, fill in ((CHURCH, style["church"]), (RECEPTION, style["reception"])):
        parts.append(_roof(place["box"], 3, f' fill="{fill}" stroke="#FFFFFF" stroke-width="{2 * scale:.1f}"'))
    parts.append(_pin(CHURCH["pin"], 1, style, scale))
    parts.append(_pin(RECEPTION["pin"], 2, style, scale))

    label = label_size * scale
    church_x, church_y = CHURCH["pin"]
    reception_x, reception_y = RECEPTION["pin"]
    parts.append(
        f'<g font-family="Cormorant Garamond, serif" font-style="italic" font-size="{label:.1f}" fill="{style["label"]}" '
        f'paint-order="stroke" stroke="{style["ground"]}" stroke-width="{4 * scale:.1f}" stroke-linejoin="round">'
        f'<text x="{church_x + 18 * scale:.1f}" y="{church_y - 18 * scale:.1f}">Church</text>'
        f'<text x="{reception_x + 18 * scale:.1f}" y="{reception_y - 18 * scale:.1f}">Reception</text></g>'
    )
    parts.append(
        f'<text x="{reception_x + 70 * scale:.1f}" y="{(church_y + reception_y) / 2 - 6 * scale:.1f}" '
        f'font-family="Jost, sans-serif" font-size="{9 * scale:.1f}" letter-spacing="{1.4 * scale:.1f}" '
        f'fill="{style["small"]}" paint-order="stroke" stroke="{style["ground"]}" stroke-width="{3 * scale:.1f}">'
        f"1 MIN WALK</text>"
    )

    if compass:
        compass_x, compass_y = left + width - 26 * scale, top + 30 * scale
        parts.append(
            f'<g transform="translate({compass_x:.1f} {compass_y:.1f}) scale({scale:.2f})">'
            f'<circle r="13" fill="{style["card"]}" stroke="{style["card_edge"]}"/>'
            f'<path d="M0-8L3.5 1H-3.5z" fill="{style["pin_dot"]}"/><path d="M0 8L3.5-1H-3.5z" fill="{style["casing"]}"/>'
            f'<text x="0" y="-17" text-anchor="middle" font-family="Jost, sans-serif" font-size="8" letter-spacing="1" '
            f'fill="{style["small"]}">N</text></g>'
        )
    if landmarks:
        box_width, box_height = 150 * scale, 40 * scale
        box_x, box_y = left + width - box_width - 10 * scale, top + height - box_height - 10 * scale
        parts.append(
            f'<g transform="translate({box_x:.1f} {box_y:.1f})">'
            f'<rect width="{box_width:.1f}" height="{box_height:.1f}" rx="{3 * scale:.1f}" fill="{style["card"]}" '
            f'fill-opacity="0.94" stroke="{style["card_edge"]}"/>'
            f'<text x="{box_width - 10 * scale:.1f}" y="{15 * scale:.1f}" text-anchor="end" font-family="Jost, sans-serif" '
            f'font-size="{7.5 * scale:.1f}" letter-spacing="{1.8 * scale:.1f}" fill="{style["small"]}">LANDMARKS</text>'
            f'<text x="{box_width - 10 * scale:.1f}" y="{31 * scale:.1f}" text-anchor="end" '
            f'font-family="Cormorant Garamond, serif" font-style="italic" font-size="{14 * scale:.1f}" '
            f'fill="{style["label"]}">Rexco · Amel Junction</text></g>'
        )
    if caption:
        parts.append(
            f'<text x="{left + 12 * scale:.1f}" y="{top + height - 12 * scale:.1f}" font-family="Jost, sans-serif" '
            f'font-size="{8.5 * scale:.1f}" letter-spacing="{1.8 * scale:.1f}" fill="{style["small"]}">TEPA · NOT TO SCALE</text>'
        )

    label_attrs = (
        'role="img" aria-label="Map of Tepa traced from above: 1 the church and 2 the reception, about a minute '
        'apart, north of the main road. Landmarks: Rexco and Amel Junction."'
        if aria
        else 'aria-hidden="true"'
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{left} {top} {width} {height}" {label_attrs} '
        f'style="display: block; width: 100%; height: auto;">' + "".join(parts) + "</svg>"
    )
