#!/usr/bin/env python3
"""Generate the PWA icon set as PNGs with no third-party dependencies.

Draws a rounded-square badge with a play triangle and a record dot, which is
enough identity for a Home Screen tile. Re-run with:  python3 tools/make-icons.py
"""
import math
import os
import struct
import zlib

BG_TOP = (14, 16, 24)
BG_BOTTOM = (28, 22, 54)
ACCENT = (124, 92, 255)
REC = (255, 78, 106)
WHITE = (245, 246, 255)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "icons")


def blend(dst, src, alpha):
    return tuple(round(d + (s - d) * alpha) for d, s in zip(dst, src))


def coverage(px, py, inside, samples=3):
    """Box-filter anti-aliasing: fraction of the pixel covered by `inside`."""
    hits = 0
    step = 1.0 / samples
    for sy in range(samples):
        for sx in range(samples):
            if inside(px + (sx + 0.5) * step, py + (sy + 0.5) * step):
                hits += 1
    return hits / (samples * samples)


def rounded_square(size, pad, radius):
    lo, hi = pad, size - pad

    def inside(x, y):
        cx = min(max(x, lo + radius), hi - radius)
        cy = min(max(y, lo + radius), hi - radius)
        if lo <= x <= hi and lo <= y <= hi:
            return math.hypot(x - cx, y - cy) <= radius
        return False

    return inside


def triangle(p1, p2, p3):
    def sign(a, b, c):
        return (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1])

    def inside(x, y):
        p = (x, y)
        d1, d2, d3 = sign(p, p1, p2), sign(p, p2, p3), sign(p, p3, p1)
        neg = d1 < 0 or d2 < 0 or d3 < 0
        pos = d1 > 0 or d2 > 0 or d3 > 0
        return not (neg and pos)

    return inside


def circle(cx, cy, r):
    return lambda x, y: math.hypot(x - cx, y - cy) <= r


def render(size, maskable=False):
    pad = 0 if maskable else size * 0.06
    radius = size * (0.5 if maskable else 0.22)
    badge = rounded_square(size, pad, radius)

    c = size / 2
    # Play triangle, nudged right so it reads as centred.
    tri = triangle(
        (c - size * 0.10, c - size * 0.17),
        (c - size * 0.10, c + size * 0.17),
        (c + size * 0.20, c),
    )
    dot = circle(c + size * 0.235, c - size * 0.235, size * 0.085)

    rows = []
    for y in range(size):
        row = bytearray()
        t = y / max(size - 1, 1)
        base = tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM))
        for x in range(size):
            a_badge = coverage(x, y, badge)
            if a_badge <= 0:
                row += bytes((0, 0, 0, 0))
                continue
            px = base
            # Soft accent glow from the lower-left corner.
            glow = max(0.0, 1.0 - math.hypot(x - size * 0.2, y - size * 0.85) / (size * 0.75))
            px = blend(px, ACCENT, glow * 0.45)
            px = blend(px, WHITE, coverage(x, y, tri))
            px = blend(px, REC, coverage(x, y, dot))
            row += bytes((px[0], px[1], px[2], round(255 * a_badge)))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)


def main():
    os.makedirs(OUT, exist_ok=True)
    targets = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
        ("apple-touch-icon.png", 180, False),
        ("favicon-64.png", 64, False),
    ]
    for name, size, maskable in targets:
        write_png(os.path.join(OUT, name), size, render(size, maskable))
        print("wrote", os.path.join("icons", name))


if __name__ == "__main__":
    main()
