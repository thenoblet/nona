"""The traced Tepa map in the look of each Canva invitation, as SVG pages ready to render to PNG."""

import random

from tepa_map import BUILDINGS, CHURCH, GROVES, MAIN_ROAD, RECEPTION, ROADS, TILT, _path, main_road_label_spot, route_path

STYLES = {
    # Cream card with white flowers: soft cream map, white roads, sepia edges.
    "first": {
        "ground": "#F6EFE6", "building": "#EADFD2", "tree": "#E2D6C6", "casing": "#D9C6B2", "road": "#FFFBF5",
        "main_casing": "#E09A66", "main": "#F6D6BC", "church": "#E87F39", "reception": "#6A524C",
        "ink": "#3D2927", "soft": "#6A524C", "accent": "#E87F39", "roads": "cased", "pins": "pin",
        "font": "Cormorant Garamond", "italic": True, "feather": True,
    },
    # Dark floral card: the map sits on its cream panel, a touch warmer.
    "premium": {
        "ground": "#F3EADF", "building": "#E6D8C8", "tree": "#DDCFBE", "casing": "#D2BCA6", "road": "#FFFAF3",
        "main_casing": "#D98C57", "main": "#F4D0B3", "church": "#E87F39", "reception": "#6A524C",
        "ink": "#3D2927", "soft": "#6A524C", "accent": "#B4561B", "roads": "cased", "pins": "pin",
        "font": "Cormorant Garamond", "italic": True, "feather": True,
    },
    # Minimal two-sided card: hairline streets, dots, small capitals.
    "quiet": {
        "landmarks_top": True,
        "ground": "#FBF8F4", "building": "#F1EAE3", "tree": "#EEE6DE", "casing": "#CDBFB4", "road": "#CDBFB4",
        "main_casing": "#E87F39", "main": "#E87F39", "church": "#E87F39", "reception": "#3D2927",
        "ink": "#42271A", "soft": "#7A6258", "accent": "#E87F39", "roads": "line", "pins": "dot",
        "font": "Jost", "italic": False, "caps": True, "feather": True,
    },
    # Art Deco card: dark cocoa, burnt-orange streets, cream diamonds.
    "deco": {
        "landmarks_top": True,
        "ground": "#2E1E1B", "building": "#3B2925", "tree": "#36251F", "casing": "#2E1E1B", "road": "#B8693A",
        "main_casing": "#2E1E1B", "main": "#E87F39", "church": "#E87F39", "reception": "#E6E0C5",
        "ink": "#E6E0C5", "soft": "#BFA98F", "accent": "#E87F39", "roads": "line", "pins": "diamond",
        "font": "Jost", "italic": False, "caps": True, "feather": False,
    },
    # Ashanti card: warm cream panel, burnt-orange streets, room at the top for its Tepa heading.
    "ashanti": {
        "landmarks_top": True,
        "ground": "#FBF3E7", "building": "#F0E2D0", "tree": "#EADBC6", "casing": "#E8A774", "road": "#FFF8EF",
        "main_casing": "#C96A2C", "main": "#F4C29C", "church": "#E87F39", "reception": "#6A524C",
        "ink": "#391F15", "soft": "#6A524C", "accent": "#E87F39", "roads": "cased", "pins": "pin",
        "font": "Jost", "italic": False, "bold": True, "feather": False, "top_space": 0.2,
    },
    # Watercolour card: a painted wash in blush and mocha with soft, bleeding edges.
    "water": {
        "landmarks_top": True,
        "ground": "#F4E3D7", "building": "#E9CDBB", "tree": "#DDBBA4", "casing": "#E4CBB9", "road": "#FFF8F2",
        "main_casing": "#D98C5A", "main": "#F3CDB0", "church": "#E87F39", "reception": "#6A524C",
        "ink": "#593D26", "soft": "#6A524C", "accent": "#E87F39", "roads": "cased", "pins": "pin",
        "font": "Cormorant Garamond", "italic": True, "feather": False, "watercolour": True,
    },
}


def _roof(box, fill, extra=""):
    left, top, right, bottom = box
    centre_x, centre_y = (left + right) / 2, (top + bottom) / 2
    return (
        f'<rect x="{left}" y="{top}" width="{right - left}" height="{bottom - top}" rx="3" fill="{fill}" '
        f'transform="rotate({TILT} {centre_x:.1f} {centre_y:.1f})"{extra}/>'
    )


def _marker(position, number, style, size):
    x, y = position
    if style["pins"] == "dot":
        return (
            f'<circle cx="{x}" cy="{y}" r="{size * 0.42:.1f}" fill="{style["accent"]}" stroke="{style["ground"]}" '
            f'stroke-width="{size * 0.16:.1f}"/>'
        )
    if style["pins"] == "diamond":
        half = size * 0.62
        return (
            f'<g transform="translate({x} {y})"><path d="M0 {-half:.1f}L{half:.1f} 0L0 {half:.1f}L{-half:.1f} 0Z" '
            f'fill="{style["ground"]}" stroke="{style["ink"]}" stroke-width="{size * 0.12:.1f}"/>'
            f'<path d="M0 {-half * 0.5:.1f}L{half * 0.5:.1f} 0L0 {half * 0.5:.1f}L{-half * 0.5:.1f} 0Z" fill="{style["accent"]}"/></g>'
        )
    return (
        f'<g transform="translate({x} {y})">'
        f'<path d="M0 0C0 0 {-size:.1f} {-size * 0.86:.1f} {-size:.1f} {-size * 1.64:.1f}'
        f'a{size:.1f} {size:.1f} 0 0 1 {2 * size:.1f} 0C{size:.1f} {-size * 0.86:.1f} 0 0 0 0z" '
        f'fill="{style["ink"]}" stroke="#FFFFFF" stroke-width="{size * 0.14:.1f}"/>'
        f'<circle cx="0" cy="{-size * 1.64:.1f}" r="{size * 0.6:.1f}" fill="{style["accent"]}"/>'
        f'<text x="0" y="{-size * 1.37:.1f}" text-anchor="middle" font-family="Jost, sans-serif" '
        f'font-size="{size * 0.75:.1f}" font-weight="600" fill="{style["ink"]}">{number}</text></g>'
    )


def styled_map(name, view, width, height, unit):
    """An HTML page holding the map of `view` (world box) drawn `width` x `height` CSS px.

    `unit` is the size, in world pixels, that reads as one small detail (road width, pin size).
    """
    style = STYLES[name]
    left, top, view_width, view_height = view
    top_space = style.get("top_space", 0)
    if top_space:
        extra = view_height * top_space / (1 - top_space)
        top -= extra
        view_height += extra

    parts = [f'<rect x="{left}" y="{top}" width="{view_width}" height="{view_height}" fill="{style["ground"]}"/>']

    generator = random.Random(26)
    trees = []
    for grove in GROVES:
        spacing = grove["spacing"] * 1.25
        row_y = grove["top"]
        while row_y < grove["bottom"]:
            column_x = grove["left"]
            while column_x < grove["right"]:
                if generator.random() < 0.7:
                    crown_x = column_x + generator.uniform(-spacing / 3, spacing / 3)
                    crown_y = row_y + generator.uniform(-spacing / 3, spacing / 3)
                    trees.append(
                        f'<circle cx="{crown_x:.0f}" cy="{crown_y:.0f}" r="{spacing * generator.uniform(0.32, 0.5):.1f}"/>'
                    )
                column_x += spacing
            row_y += spacing * 0.9
    parts.append(f'<g fill="{style["tree"]}">{"".join(trees)}</g>')
    parts.append("".join(_roof(box, style["building"]) for box in BUILDINGS))

    road = unit
    lines = []
    if style["roads"] == "cased":
        for points in ROADS.values():
            lines.append(f'<path d="{_path(points)}" stroke="{style["casing"]}" stroke-width="{road * 1.5:.1f}"/>')
        lines.append(f'<path d="{_path(MAIN_ROAD)}" stroke="{style["main_casing"]}" stroke-width="{road * 3.2:.1f}"/>')
        for points in ROADS.values():
            lines.append(f'<path d="{_path(points)}" stroke="{style["road"]}" stroke-width="{road:.1f}"/>')
        lines.append(f'<path d="{_path(MAIN_ROAD)}" stroke="{style["main"]}" stroke-width="{road * 2.6:.1f}"/>')
    else:
        for points in ROADS.values():
            lines.append(f'<path d="{_path(points)}" stroke="{style["road"]}" stroke-width="{road * 0.42:.1f}"/>')
        lines.append(f'<path d="{_path(MAIN_ROAD)}" stroke="{style["main"]}" stroke-width="{road * 1.5:.1f}"/>')
    route_colour = style["accent"] if style["roads"] == "cased" else style["ink"]
    lines.append(
        f'<path d="{route_path()}" stroke="{route_colour}" stroke-width="{road * 0.34:.1f}" '
        f'stroke-dasharray="{road * 0.75:.1f} {road * 0.6:.1f}"/>'
    )
    parts.append(f'<g fill="none" stroke-linecap="round" stroke-linejoin="round">{"".join(lines)}</g>')
    label_x, label_y, angle = main_road_label_spot((left, top, view_width, view_height))
    on_road = style["roads"] == "cased"
    parts.append(
        f'<text x="{label_x:.1f}" y="{label_y:.1f}" dy="{"0.35em" if on_road else "-0.9em"}" text-anchor="middle" '
        f'transform="rotate({angle:.1f} {label_x:.1f} {label_y:.1f})" font-family="Jost, sans-serif" font-weight="500" '
        f'font-size="{road * 1.2:.1f}" letter-spacing="{road * 0.3:.1f}" fill="{style["ink"]}" '
        f'{"" if on_road else "paint-order=" + chr(34) + "stroke" + chr(34) + " stroke=" + chr(34) + style["ground"] + chr(34) + f" stroke-width={chr(34)}{road * 0.4:.1f}{chr(34)}"}>MAIN ROAD</text>'
    )

    for place, fill in ((CHURCH, style["church"]), (RECEPTION, style["reception"])):
        parts.append(_roof(place["box"], fill, f' stroke="{style["ground"]}" stroke-width="{unit * 0.25:.1f}"'))
    pin = unit * 1.45
    parts.append(_marker(CHURCH["pin"], 1, style, pin))
    parts.append(_marker(RECEPTION["pin"], 2, style, pin))

    caps = style.get("caps")
    label_size = unit * (1.55 if caps else 2.3)
    weight = "600" if style.get("bold") else ("500" if caps else "500")
    italic = "italic" if style.get("italic") else "normal"
    spacing = f' letter-spacing="{label_size * 0.18:.1f}"' if caps else ""
    offset = pin * (1.25 if style["pins"] != "pin" else 1.3)
    rise = pin * (0.35 if style["pins"] != "pin" else 1.3)
    church_label, reception_label = ("CHURCH", "RECEPTION") if caps else ("Church", "Reception")
    parts.append(
        f'<g font-family="{style["font"]}, serif" font-style="{italic}" font-weight="{weight}" font-size="{label_size:.1f}"{spacing} '
        f'fill="{style["ink"]}" paint-order="stroke" stroke="{style["ground"]}" stroke-width="{unit * 0.5:.1f}" stroke-linejoin="round">'
        f'<text x="{CHURCH["pin"][0] + offset:.1f}" y="{CHURCH["pin"][1] - rise:.1f}">{church_label}</text>'
        f'<text x="{RECEPTION["pin"][0] + offset:.1f}" y="{RECEPTION["pin"][1] - rise:.1f}">{reception_label}</text></g>'
    )

    # The landmarks, as the couple asked: words over the map, not places on it.
    small = unit * 1.05
    big = unit * (1.2 if caps else 1.9)
    box_width = big * (15.6 if caps else 9.6)
    box_height = small * 1.6 + big * 1.5 + unit * 0.8
    margin = unit + (min(view_width, view_height) * 0.09 if style.get("watercolour") else 0)
    if style.get("landmarks_top"):
        # Up in the north-east corner, clear of the main road and the way in.
        box_x = left + view_width - box_width - margin
        box_y = top + view_height * top_space + margin
    else:
        box_x = left + margin
        box_y = top + view_height - box_height - margin
    landmark_font = "Jost" if caps else "Cormorant Garamond"
    landmark_style = "normal" if caps else "italic"
    parts.append(
        f'<g transform="translate({box_x:.1f} {box_y:.1f})">'
        f'<rect width="{box_width:.1f}" height="{box_height:.1f}" rx="{unit * 0.3:.1f}" fill="{style["ground"]}" '
        f'fill-opacity="0.92" stroke="{style["soft"]}" stroke-opacity="0.35" stroke-width="{unit * 0.12:.1f}"/>'
        f'<text x="{box_width / 2:.1f}" y="{unit * 0.5 + small * 1.2:.1f}" text-anchor="middle" font-family="Jost, sans-serif" '
        f'font-size="{small:.1f}" letter-spacing="{small * 0.25:.1f}" fill="{style["soft"]}">LANDMARKS</text>'
        f'<text x="{box_width / 2:.1f}" y="{unit * 0.5 + small * 1.6 + big * 1.15:.1f}" text-anchor="middle" '
        f'font-family="{landmark_font}, serif" font-style="{landmark_style}" font-size="{big:.1f}" '
        f'{"letter-spacing=" + chr(34) + f"{big * 0.12:.1f}" + chr(34) if caps else ""} fill="{style["ink"]}">'
        f'{"REXCO · AMEL JUNCTION" if caps else "Rexco · Amel Junction"}</text></g>'
    )

    defs = ""
    group_attributes = ""
    if style.get("watercolour"):
        inset_x, inset_y = view_width * 0.05, view_height * 0.05
        defs = (
            '<filter id="paint" x="-20%" y="-20%" width="140%" height="140%">'
            '<feTurbulence type="fractalNoise" baseFrequency="0.009" numOctaves="4" seed="11" result="noise"/>'
            f'<feDisplacementMap in="SourceGraphic" in2="noise" scale="{min(view_width, view_height) * 0.12:.0f}" '
            'xChannelSelector="R" yChannelSelector="G" result="shape"/>'
            f'<feGaussianBlur in="shape" stdDeviation="{unit * 0.5:.1f}"/></filter>'
            f'<mask id="wash" maskUnits="userSpaceOnUse" x="{left:.1f}" y="{top:.1f}" width="{view_width:.1f}" height="{view_height:.1f}">'
            f'<rect x="{left + inset_x:.1f}" y="{top + inset_y:.1f}" width="{view_width - 2 * inset_x:.1f}" '
            f'height="{view_height - 2 * inset_y:.1f}" rx="{unit * 6:.1f}" fill="#FFFFFF" filter="url(#paint)"/></mask>'
            '<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.5" numOctaves="2" seed="3"/>'
            '<feColorMatrix values="0 0 0 0 0.42  0 0 0 0 0.3  0 0 0 0 0.26  0 0 0 0.1 0"/></filter>'
        )
        group_attributes = ' mask="url(#wash)"'
        parts.append(
            f'<rect x="{left:.1f}" y="{top:.1f}" width="{view_width:.1f}" height="{view_height:.1f}" filter="url(#grain)"/>'
        )
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{left:.1f} {top:.1f} {view_width:.1f} {view_height:.1f}" '
        f'width="{width}" height="{height}" preserveAspectRatio="xMidYMid slice"><defs>{defs}</defs>'
        f'<g{group_attributes}>{"".join(parts)}</g></svg>'
    )
    if style.get("feather"):
        mask = "radial-gradient(ellipse 80% 80% at 50% 50%, #000 70%, transparent 100%)"
        wrapper = f"-webkit-mask-image: {mask}; mask-image: {mask};"
    else:
        wrapper = ""
    return f'<div class="map" style="width: {width}px; height: {height}px; {wrapper}">{svg}</div>'
