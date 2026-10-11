"""Writes every icon SVG: the four candidates in docs/branding/ and the chosen one (D, spark
wool; docs/branding-2026-10-10.md D1) in media/. Each is a one-colour 24 px mark (the activity
bar; VS Code draws it as a mask in the theme's colour) and a colour tile. Edit this script and
run it (`npm run icons`), never the SVGs. Standard library only."""
import math, os

def f(x):
    return f"{x:.2f}".rstrip("0").rstrip(".")

def rays(n, r0, r1, w, phase=0.0, alt=None, cx=12, cy=12):
    out = []
    for k in range(n):
        a = math.radians(phase + k * 360 / n)
        ro = r1 if alt is None or k % 2 == 0 else alt
        x0, y0 = cx + r0 * math.cos(a), cy + r0 * math.sin(a)
        x1, y1 = cx + ro * math.cos(a), cy + ro * math.sin(a)
        out.append(f'<line x1="{f(x0)}" y1="{f(y0)}" x2="{f(x1)}" y2="{f(y1)}" stroke-width="{w}" stroke-linecap="round"/>')
    return "".join(out)

def tapered(n, r0, r1, w0, w1, phase=0.0, alt=None, cx=12, cy=12):
    """Claude-spark-like rays: each a quad that narrows outward, round-ended by a circle."""
    out = []
    for k in range(n):
        a = math.radians(phase + k * 360 / n)
        ro = r1 if alt is None or k % 2 == 0 else alt
        c, s = math.cos(a), math.sin(a)
        px, py = -s, c
        p = [
            (cx + r0 * c + px * w0 / 2, cy + r0 * s + py * w0 / 2),
            (cx + ro * c + px * w1 / 2, cy + ro * s + py * w1 / 2),
            (cx + ro * c - px * w1 / 2, cy + ro * s - py * w1 / 2),
            (cx + r0 * c - px * w0 / 2, cy + r0 * s - py * w0 / 2),
        ]
        out.append('<path d="M' + " L".join(f"{f(x)} {f(y)}" for x, y in p) + 'Z"/>')
        out.append(f'<circle cx="{f(cx + ro * c)}" cy="{f(cy + ro * s)}" r="{f(w1 / 2)}"/>')
    return "".join(out)

def scallop(n, r, rr, cx=12, cy=12, phase=0):
    out = [f'<circle cx="{cx}" cy="{cy}" r="{r}"/>']
    for k in range(n):
        a = math.radians(phase + k * 360 / n)
        out.append(f'<circle cx="{f(cx + r * math.cos(a))}" cy="{f(cy + r * math.sin(a))}" r="{rr}"/>')
    return "".join(out)

# A face: knock-out moat, face, ears, eyes. (ox, oy) offset, s scale around (12, 13).
def face(s=1.0, cy=13.2, moat=0.9, ears=True):
    def E(cx, cy_, rx, ry, rot=0, fill="#fff"):
        t = f' transform="rotate({rot} {f(cx)} {f(cy_)})"' if rot else ""
        return f'<ellipse cx="{f(cx)}" cy="{f(cy_)}" rx="{f(rx)}" ry="{f(ry)}" fill="{fill}"{t}/>'
    fx, fy = 3.0 * s, 4.0 * s
    ex, ey, erx, ery = 3.9 * s, cy - 2.2 * s, 1.9 * s, 0.95 * s
    knock = E(12, cy, fx + moat, fy + moat, fill="#000")
    if ears:
        knock += E(12 - ex, ey, erx + moat, ery + moat, -22, "#000") + E(12 + ex, ey, erx + moat, ery + moat, 22, "#000")
    body = E(12, cy, fx, fy)
    if ears:
        body += E(12 - ex, ey, erx, ery, -22) + E(12 + ex, ey, erx, ery, 22)
    eyes = f'<circle cx="{f(12 - 1.25 * s)}" cy="{f(cy - 0.6 * s)}" r="{f(0.62 * s)}" fill="#000"/><circle cx="{f(12 + 1.25 * s)}" cy="{f(cy - 0.6 * s)}" r="{f(0.62 * s)}" fill="#000"/>'
    return knock, body, eyes

def mono(fleece_white, knock, body, eyes, extra=""):
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><mask id="m">'
        f'<g fill="#fff" stroke="#fff">{fleece_white}</g>{knock}{body}{eyes}{extra}'
        '</mask></defs><rect width="24" height="24" fill="currentColor" mask="url(#m)"/></svg>'
    )

def color(fleece, knock_unused, face_parts, palette, bg=True):
    wool, faceC, eye, tile = palette
    tilesvg = f'<rect x="0.5" y="0.5" width="23" height="23" rx="5.5" fill="{tile}"/>' if bg else ""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' + tilesvg +
        f'<g transform="translate(12 12) scale(0.86) translate(-12 -12)"><g fill="{wool}" stroke="{wool}">{fleece}</g>{face_parts.replace("#fff", faceC).replace("#000", eye)}</g></svg>'
    )

P = ("#F3E6D3", "#2B2238", "#F3E6D3", "#E07A52")   # wool, face, eye, tile

out = {}

def tapered_lens(lens, r0, w0, w1, phase=0.0, cx=12, cy=12):
    n = len(lens); o = []
    for k, ro in enumerate(lens):
        o.append(tapered(1, r0, ro, w0, w1, phase=phase + k * 360 / n, cx=cx, cy=cy))
    return "".join(o)

# A — spark fleece: 14 thin, uneven rays (the spark) are the wool.
LENS = [10.8, 9.4, 10.4, 8.9, 10.9, 9.6, 10.2, 9.0, 10.7, 9.3, 10.5, 9.1, 10.8, 9.5]
fa = tapered_lens(LENS, 4.0, 2.6, 1.9, phase=-90)
k, b, e = face(1.0)
out["A spark fleece"] = {"mono": mono(fa, k, b, e), "color": color(fa, k, b + e, P)}

# B — cloud fleece: the classic sheep.
fb = scallop(10, 7.4, 2.9, phase=18)
k, b, e = face(1.0)
out["B cloud fleece"] = {"mono": mono(fb, k, b, e), "color": color(fb, k, b + e, P)}

# C — spacesheep: the sheep below, the spark as a star above it.
def sheep_at(cx, cy, s):
    fl = scallop(9, 5.6 * s, 2.3 * s, cx=cx, cy=cy, phase=10)
    return fl
fc = scallop(9, 5.2, 2.2, cx=10.3, cy=13.8, phase=10)
def face_at(dx, dy, s):
    k, b, e = face(s, cy=13.0, moat=0.8)
    g = lambda x: f'<g transform="translate({dx} {dy})">{x}</g>'
    return g(k), g(b), g(e)
k, b, e = face_at(-1.7, 1.6, 0.82)
star = tapered_lens([3.6, 2.4, 3.2, 2.2, 3.6, 2.4, 3.2, 2.2], 0.0, 1.5, 0.9, phase=-90, cx=19.3, cy=4.7)
NIGHT = ("#F3E6D3", "#2B2238", "#F3E6D3", "#262247")
out["C spacesheep"] = {
    "mono": mono(fc, k, b, e, extra=f'<g fill="#fff">{star}</g>'),
    "color": color(fc, k, b + e + f'<g fill="#E8875C">{star}</g>', NIGHT),
}

# D — spark-edged wool: a woolly body whose edge breaks into short spark rays.
fd = '<circle cx="12" cy="12" r="7.2"/>' + tapered_lens(LENS, 6.0, 2.4, 1.8, phase=-90)
k, b, e = face(1.0)
out["D spark wool"] = {"mono": mono(fd, k, b, e), "color": color(fd, k, b + e, P)}

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHOSEN = "D spark wool"


def write(rel, text):
    path = os.path.join(ROOT, rel)
    with open(path, "w") as f:
        f.write(text + "\n")


for name, v in out.items():
    if not os.path.isdir(os.path.join(ROOT, "docs")):
        break  # the public copy has no docs/: only the chosen icon is written
    letter, rest = name.split(" ", 1)
    slug = letter.lower() + "-" + rest.replace(" ", "-")
    write(f"docs/branding/{slug}-mono.svg", v["mono"])
    write(f"docs/branding/{slug}-color.svg", v["color"])
write("media/sheepfold.svg", out[CHOSEN]["mono"])
write("media/icon.svg", out[CHOSEN]["color"])
