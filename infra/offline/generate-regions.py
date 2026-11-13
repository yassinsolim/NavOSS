#!/usr/bin/env python3
"""Generate buffered download footprints from pinned Geofabrik extract boundaries."""
import argparse
import hashlib
import json
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import MultiPolygon, Polygon, box, mapping
from shapely.ops import transform, unary_union


def read_poly(path):
    rings = []
    holes = []
    current = None
    for line in path.read_text().splitlines()[1:]:
        text = line.strip()
        if text == "END":
            if current is None:
                break
            current = None
        elif current is None:
            current = []
            (holes if text.startswith("!") else rings).append(current)
        else:
            current.append(tuple(map(float, text.split())))
    geometry = unary_union([Polygon(ring) for ring in rings])
    if holes:
        geometry = geometry.difference(unary_union([Polygon(ring) for ring in holes]))
    if geometry.is_empty or not geometry.is_valid:
        raise ValueError(f"Invalid source polygon: {path.name}")
    return geometry


def multipolygon(geometry):
    if isinstance(geometry, Polygon):
        return MultiPolygon([geometry])
    if isinstance(geometry, MultiPolygon):
        return geometry
    polygons = [part for part in geometry.geoms if isinstance(part, (Polygon, MultiPolygon))]
    return multipolygon(unary_union(polygons))


def write_poly(path, geometry):
    lines = [path.stem]
    for index, polygon in enumerate(multipolygon(geometry).geoms, 1):
        for hole, ring in enumerate([polygon.exterior, *polygon.interiors]):
            lines.append(f"{'!' if hole else ''}{index}_{hole}")
            lines.extend(f"  {longitude:.7f}  {latitude:.7f}" for longitude, latitude in ring.coords)
            lines.append("END")
    lines.append("END")
    path.write_text("\n".join(lines) + "\n")


def generate(source_dir, definitions):
    for name, checksum in definitions["sourceChecksums"].items():
        if hashlib.sha256((source_dir / name).read_bytes()).hexdigest() != checksum:
            raise ValueError(f"Boundary checksum mismatch: {name}")
    provinces = {name: read_poly(source_dir / f"{name}.poly") for name in ("alberta", "british-columbia")}
    both = unary_union(list(provinces.values()))
    # Statistics Canada's national Lambert projection gives a metre-based, not degree-based buffer.
    to_metres = Transformer.from_crs(4326, 3347, always_xy=True).transform
    to_degrees = Transformer.from_crs(3347, 4326, always_xy=True).transform
    features = []
    cores = []
    for region in definitions["regions"]:
        mask = both if region["province"] == "both" else provinces[region["province"]]
        selection = Polygon(region["polygon"]) if "polygon" in region else box(*region["bounds"])
        core = mask.intersection(selection)
        if core.is_empty or not core.is_valid:
            raise ValueError(f"Invalid core: {region['id']}")
        if not region.get("bulk"):
            cores.append(core)
        buffered = transform(to_metres, core).buffer(definitions["overlapMeters"], resolution=8)
        coverage = multipolygon(transform(to_degrees, buffered).intersection(both))
        # Avoid bloat from sub-metre artifacts at clipping intersections; preserve topology.
        coverage = multipolygon(coverage.simplify(0.00001, preserve_topology=True))
        if coverage.is_empty or not coverage.is_valid:
            raise ValueError(f"Invalid buffered region: {region['id']}")
        features.append({
            "type": "Feature",
            "properties": {
                "id": region["id"], "name": region["name"],
                "overlapMeters": definitions["overlapMeters"],
                "bounds": list(coverage.bounds), "bulk": region.get("bulk", False),
                "source": definitions["boundarySource"], "license": definitions["boundaryLicense"],
                "sourceDate": definitions["sourceDate"],
            },
            "geometry": mapping(coverage),
        })
    uncovered = both.difference(unary_union(cores))
    if uncovered.area > 1e-8:
        raise ValueError(f"Partition leaves {uncovered.area} square degrees uncovered")
    return {"type": "FeatureCollection", "features": features}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--definitions", type=Path, required=True)
    parser.add_argument("--sources", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    collection = generate(args.sources, json.loads(args.definitions.read_text()))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(collection, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
