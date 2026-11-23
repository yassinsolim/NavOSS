#!/usr/bin/env python3
"""Writes the deterministic replay trace for the recorded Calgary Deerfoot-Glenmore route.

One fix a second along the route's own geometry, with fixed-seed jitter, a stop, a stretch
above the posted limit and a 40-second detour off the route and back, so a replay exercises
matching, guidance, speech planning, speeding and off-route state. Re-running it produces the
same file byte for byte.
"""
import json
import math
import pathlib

here = pathlib.Path(__file__).resolve().parent
repo = here.parents[5]
fixture = repo / "apps/mobile/test/fixtures/routes-v2/calgary-deerfoot-glenmore.v2.json"
out = here.parent / "Tests/Fixtures/calgary-deerfoot-glenmore.trace.json"

route = json.loads(fixture.read_text())["response"]["routes"][0]
points = [(lat, lon) for lon, lat in route["geometry"]]
R = 6_371_000.0


def dist(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (*a, *b))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def bearing(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (*a, *b))
    y = math.sin(lo2 - lo1) * math.cos(la2)
    x = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(lo2 - lo1)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def offset(p, east, north):
    return (
        p[0] + math.degrees(north / R),
        p[1] + math.degrees(east / (R * math.cos(math.radians(p[0])))),
    )


cumulative = [0.0]
for a, b in zip(points, points[1:]):
    cumulative.append(cumulative[-1] + dist(a, b))
total = cumulative[-1]


def at(along):
    along = min(max(along, 0.0), total)
    for i in range(1, len(cumulative)):
        if cumulative[i] >= along:
            a, b = points[i - 1], points[i]
            span = cumulative[i] - cumulative[i - 1] or 1.0
            f = (along - cumulative[i - 1]) / span
            return (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f), bearing(a, b)
    return points[-1], bearing(points[-2], points[-1])


seed = 20261122


def jitter():
    global seed
    seed = (seed * 1103515245 + 12345) % (2**31)
    return (seed / 2**31 - 0.5) * 6.0  # +/- 3 m


fixes = []
t_ms = 1_800_000_000_000
along = 0.0
second = 0
detour_start = 0.42 * total
detour_seconds = 0
stopped = 0
while along < total + 30:
    if 300 <= along < 330 and stopped < 10:
        speed = 0.0
        stopped += 1
    elif 0.6 * total <= along < 0.75 * total:
        speed = 31.0  # about 112 km/h, above the posted limit
    else:
        speed = 19.0 if along < 0.2 * total else 25.0
    along += speed
    p, course = at(along)
    if along >= detour_start and detour_seconds < 40:
        # Drift perpendicular to the route, up to 180 m, then come back.
        detour_seconds += 1
        side = 180.0 * math.sin(math.pi * detour_seconds / 40)
        p = offset(p, side * math.cos(math.radians(course)), -side * math.sin(math.radians(course)))
    p = offset(p, jitter(), jitter())
    fixes.append(
        {
            "courseDegrees": round(course, 1),
            "horizontalAccuracyMeters": 5.0,
            "latitude": round(p[0], 7),
            "longitude": round(p[1], 7),
            "speedMetersPerSecond": speed,
            "timestampMs": t_ms + second * 1000,
        }
    )
    second += 1

out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps({"fixes": fixes, "route": "calgary-deerfoot-glenmore.v2.json"}, indent=0) + "\n")
print(f"{len(fixes)} fixes, route {total:.0f} m -> {out}")
