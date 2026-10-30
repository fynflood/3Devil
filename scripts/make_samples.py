#!/usr/bin/env python3
"""Generates a small demo build of binary STL files under samples/ for development."""
import math
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "samples" / "Demo Castle"


def box(x0, y0, z0, x1, y1, z1):
    v = [(x, y, z) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
    quads = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return [t for a, b, c, d in quads for t in ((v[a], v[b], v[c]), (v[a], v[c], v[d]))]


def cylinder(cx, cy, r, h, z0=0.0, seg=48):
    tris = []
    for i in range(seg):
        a0, a1 = 2 * math.pi * i / seg, 2 * math.pi * (i + 1) / seg
        p0 = (cx + r * math.cos(a0), cy + r * math.sin(a0))
        p1 = (cx + r * math.cos(a1), cy + r * math.sin(a1))
        b0, b1, t0, t1 = (*p0, z0), (*p1, z0), (*p0, z0 + h), (*p1, z0 + h)
        tris += [(b0, b1, t1), (b0, t1, t0), ((cx, cy, z0), b1, b0), ((cx, cy, z0 + h), t0, t1)]
    return tris


def crenellations(x0, x1, y0, y1, z, n, h=6):
    w = (x1 - x0) / (2 * n - 1)
    return [t for i in range(n) for t in box(x0 + 2 * i * w, y0, z, x0 + (2 * i + 1) * w, y1, z + h)]


def write_stl(path, tris):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"3Devil sample".ljust(80, b" "))
        f.write(struct.pack("<I", len(tris)))
        for a, b, c in tris:
            u = [b[i] - a[i] for i in range(3)]
            w = [c[i] - a[i] for i in range(3)]
            n = (u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0])
            f.write(struct.pack("<12fH", *n, *a, *b, *c, 0))


samples = {
    "Walls/wall_straight_x4.stl": box(0, 0, 0, 50, 8, 40) + crenellations(0, 50, 0, 8, 40, 4),
    "Walls/wall_corner_x2.stl": box(0, 0, 0, 30, 8, 40) + box(0, 0, 0, 8, 30, 40) + crenellations(0, 30, 0, 8, 40, 3),
    "Walls/wall_gate.stl": box(0, 0, 0, 15, 10, 45) + box(35, 0, 0, 50, 10, 45) + box(15, 0, 30, 35, 10, 45),
    "Floors/floor_tile_2x2_x6.stl": box(0, 0, 0, 50, 50, 4) + [t for i in (1,) for t in box(24.5, 0, 4, 25.5, 50, 4.6) + box(0, 24.5, 4, 50, 25.5, 4.6)],
    "Floors/stairs.stl": [t for i in range(5) for t in box(0, i * 8, 0, 25, 40, (i + 1) * 6)],
    "Towers/tower_round.stl": cylinder(0, 0, 20, 70) + cylinder(0, 0, 23, 6, 70),
    "Towers/tower_roof.stl": [t for i in range(10) for t in cylinder(0, 0, 24 - i * 2.4, 3, i * 3)],
    "Props/barrel_x8.stl": cylinder(0, 0, 6, 14) + cylinder(0, 0, 6.6, 1.5, 3) + cylinder(0, 0, 6.6, 1.5, 9.5),
}

for rel, tris in samples.items():
    write_stl(ROOT / rel, tris)
    print(f"wrote {rel} ({len(tris)} triangles)")
