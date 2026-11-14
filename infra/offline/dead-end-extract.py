#!/usr/bin/env python3
"""Extract the drivable road topology of an OSM extract for the traffic dead-end mask.

This reads map data only. It writes little-endian typed arrays that
`dead-end-mask.mts` analyses:

- topology nodes: every OSM node shared by two drivable ways (or used twice by one), every way
  end, and one separate node per way end at a barrier that stops cars (so a barrier splits the
  road into two terminals);
- segments: one per stretch of a way between two topology nodes, with its length, its legal
  car directions and its vertex range in the way;
- vertex coordinates of the ways whose class can be published (motorway to secondary and their
  links), which the mask needs to locate a graph edge inside a way.

Tag policy (`way_policy`, `barrier_blocks`) is deliberately conservative: a way counts as a
connection only when a private car may use it at any time. Seasonal (`*:conditional` no/private),
private, agricultural, forestry, emergency and similar ways, tracks, reversible ways and ferries
without explicit motor-vehicle access are left out, so they can never be the second exit that
makes a dead-end region look like a through road.
"""
import argparse
import json
import re
import sys
from array import array
from pathlib import Path

import numpy as np
import osmium

POLICY_VERSION = 1

CLASS_CODES = {
    "motorway": 1, "motorway_link": 2, "trunk": 3, "trunk_link": 4,
    "primary": 5, "primary_link": 6, "secondary": 7, "secondary_link": 8,
    "tertiary": 9, "tertiary_link": 10, "unclassified": 11, "residential": 12,
    "living_street": 13, "service": 14, "road": 15,
}
FERRY = 16
MINOR_SERVICE = 17
MINOR_SERVICE_VALUES = {"driveway", "parking_aisle", "drive-through"}
# Classes the traffic pipeline can publish (Valhalla motorway to secondary, including links).
PUBLISHABLE = {1, 2, 3, 4, 5, 6, 7, 8}

FORWARD = 1
BACKWARD = 2
BOTH = 3

ALLOW = {"yes", "permissive", "designated", "destination", "customers", "delivery", "official", "public"}
DENY = {"no", "private", "agricultural", "forestry", "emergency", "military", "permit", "restricted",
        "residents", "unknown", "use_sidepath"}
ACCESS_KEYS = ("motorcar", "motor_vehicle", "vehicle", "access")
CONDITIONAL_KEYS = tuple(f"{key}:conditional" for key in ACCESS_KEYS)
CLOSED_CONDITION = re.compile(r"(^|;)\s*(no|private)\s*@")
PASSABLE_BARRIERS = {
    "gate", "lift_gate", "swing_gate", "sliding_gate", "hampshire_gate", "cattle_grid",
    "toll_booth", "border_control", "entrance", "height_restrictor",
}

# Reasons a way that could be published is left out of the topology; recorded in the mask.
DROP_REASONS = {"access": 1, "conditional": 2, "oneway": 3, "area": 4}

NODE_CLIPPED = 1
NODE_BARRIER = 2
WAY_MISSING_NODES = 1


def access_value(tags):
    """The most specific recognised car access value, or None. A value that is neither a known
    permission nor a known restriction (lane syntax such as `||no` mistagged without `:lanes`,
    typos) is ignored, as a router does, and the next less specific key decides."""
    for key in ACCESS_KEYS:
        value = (tags.get(key) or "").split(";")[0].strip()
        if value in ALLOW or value in DENY:
            return value
    return None


def motor_access(tags):
    """True unless the most specific recognised car access tag restricts cars."""
    return access_value(tags) not in DENY


def seasonal_closure(tags):
    return any(CLOSED_CONDITION.search(tags.get(key) or "") for key in CONDITIONAL_KEYS)


def directions(tags, highway):
    """Legal car directions relative to the node order, or None when they are not knowable."""
    value = tags.get("oneway")
    if value in ("yes", "true", "1"):
        return FORWARD
    if value in ("-1", "reverse"):
        return BACKWARD
    if value in ("no", "false", "0"):
        return BOTH
    if value is not None:
        return None  # reversible, alternating or unknown
    if tags.get("junction") in ("roundabout", "circular") or highway in ("motorway", "motorway_link"):
        return FORWARD
    return BOTH


def way_policy(tags):
    """(class code, directions) for a car connection, ("drop", reason) for a publishable class
    that is left out, or None for anything else that is not a car connection."""
    if tags.get("route") == "ferry":
        motor = tags.get("motorcar") or tags.get("motor_vehicle")
        if motor is None or motor.split(";")[0].strip() not in ALLOW:
            return None
        found = directions(tags, None)
        return (FERRY, found) if found is not None else None
    highway = tags.get("highway")
    code = CLASS_CODES.get(highway)
    if code is None:
        return None
    reason = None
    if tags.get("area") == "yes":
        reason = "area"
    elif highway == "service" and tags.get("service") == "emergency_access":
        reason = "access"
    elif not motor_access(tags):
        reason = "access"
    elif seasonal_closure(tags):
        reason = "conditional"
    found = directions(tags, highway)
    if reason is None and found is None:
        reason = "oneway"
    if reason is not None:
        return ("drop", reason) if code in PUBLISHABLE else None
    if highway == "service" and tags.get("service") in MINOR_SERVICE_VALUES:
        code = MINOR_SERVICE
    return code, found


def barrier_blocks(tags):
    barrier = tags.get("barrier")
    if barrier is None or barrier == "no":
        return False
    if seasonal_closure(tags):
        return True
    value = access_value(tags)
    if value is not None:
        return value in DENY
    return barrier not in PASSABLE_BARRIERS


class BarrierReader(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.blocking = array("q")

    def node(self, node):
        if barrier_blocks(node.tags):
            self.blocking.append(node.id)


class WayReader(osmium.SimpleHandler):
    """Collects every car way as one or more runs of nodes with valid locations."""

    def __init__(self):
        super().__init__()
        self.refs = array("q")
        self.x = array("i")
        self.y = array("i")
        self.run_start = array("q", [0])
        self.run_way = array("q")
        self.run_base = array("I")  # index of the run's first vertex within the OSM way
        self.run_class = array("B")
        self.run_dir = array("B")
        self.run_clip = array("B")  # bit 0: clipped before the first vertex, bit 1: after the last
        self.run_flags = array("B")
        self.dropped = []

    def way(self, way):
        policy = way_policy(way.tags)
        if policy is None:
            return
        if policy[0] == "drop":
            self.dropped.append((way.id, DROP_REASONS[policy[1]]))
            return
        code, found = policy
        refs, xs, ys, valid = [], [], [], []
        for node in way.nodes:
            location = node.location
            refs.append(node.ref)
            if location.valid():
                xs.append(location.x)
                ys.append(location.y)
                valid.append(True)
            else:
                xs.append(0)
                ys.append(0)
                valid.append(False)
        missing = not all(valid)
        index = 0
        count = len(refs)
        while index < count:
            if not valid[index]:
                index += 1
                continue
            end = index
            while end + 1 < count and valid[end + 1]:
                end += 1
            if end > index:
                self.refs.extend(refs[index:end + 1])
                self.x.extend(xs[index:end + 1])
                self.y.extend(ys[index:end + 1])
                self.run_start.append(len(self.refs))
                self.run_way.append(way.id)
                self.run_base.append(index)
                self.run_class.append(code)
                self.run_dir.append(found)
                self.run_clip.append((1 if index > 0 else 0) | (2 if end < count - 1 else 0))
                self.run_flags.append(WAY_MISSING_NODES if missing else 0)
            index = end + 1


def haversine(x1, y1, x2, y2):
    lon1, lat1, lon2, lat2 = (np.radians(value / 1e7) for value in (x1, y1, x2, y2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6_371_008.8 * np.arcsin(np.sqrt(np.minimum(1.0, a)))


def build_topology(reader, blocking):
    refs = np.frombuffer(reader.refs, dtype=np.int64)
    x = np.frombuffer(reader.x, dtype=np.int32)
    y = np.frombuffer(reader.y, dtype=np.int32)
    starts = np.frombuffer(reader.run_start, dtype=np.int64)
    runs = len(starts) - 1
    vertices = len(refs)
    run_of_vertex = np.repeat(np.arange(runs, dtype=np.int64), np.diff(starts))

    unique, counts = np.unique(refs, return_counts=True)
    shared = unique[counts >= 2]
    blocking = np.unique(np.asarray(blocking, dtype=np.int64))
    is_topo = np.isin(refs, shared)
    is_topo[starts[:-1]] = True
    is_topo[starts[1:] - 1] = True
    is_barrier = np.isin(refs, blocking) if len(blocking) else np.zeros(vertices, dtype=bool)
    is_topo |= is_barrier

    step = np.zeros(vertices, dtype=np.float64)
    if vertices > 1:
        same_run = run_of_vertex[1:] == run_of_vertex[:-1]
        distance = haversine(x[:-1].astype(np.float64), y[:-1].astype(np.float64),
                             x[1:].astype(np.float64), y[1:].astype(np.float64))
        step[1:] = np.where(same_run, distance, 0.0)
    cumulative = np.cumsum(step)

    topo_positions = np.flatnonzero(is_topo)
    pair_same_run = run_of_vertex[topo_positions[1:]] == run_of_vertex[topo_positions[:-1]]
    seg_from_v = topo_positions[:-1][pair_same_run]
    seg_to_v = topo_positions[1:][pair_same_run]
    seg_run = run_of_vertex[seg_from_v]

    node_ids = np.unique(refs[topo_positions[~is_barrier[topo_positions]]])
    node_count = len(node_ids)

    def node_index(vertex_positions):
        indexes = np.searchsorted(node_ids, refs[vertex_positions]).astype(np.int64)
        barrier = is_barrier[vertex_positions]
        return indexes, barrier

    seg_from, from_barrier = node_index(seg_from_v)
    seg_to, to_barrier = node_index(seg_to_v)
    synthetic_x, synthetic_y, synthetic_flags = [], [], []

    def synthetic(vertex, flag):
        nonlocal node_count
        synthetic_x.append(int(x[vertex]))
        synthetic_y.append(int(y[vertex]))
        synthetic_flags.append(flag)
        node_count += 1
        return node_count - 1

    for position in np.flatnonzero(from_barrier):
        seg_from[position] = synthetic(seg_from_v[position], NODE_BARRIER)
    for position in np.flatnonzero(to_barrier):
        seg_to[position] = synthetic(seg_to_v[position], NODE_BARRIER)

    # Coordinates of real topology nodes: any occurrence of the id.
    order = np.argsort(refs[topo_positions], kind="stable")
    sorted_ids = refs[topo_positions][order]
    first = topo_positions[order][np.searchsorted(sorted_ids, node_ids)]
    node_x = list(x[first].astype(np.int64))
    node_y = list(y[first].astype(np.int64))
    node_flags = [0] * len(node_ids)

    run_class = np.frombuffer(reader.run_class, dtype=np.uint8)
    run_dir = np.frombuffer(reader.run_dir, dtype=np.uint8)
    run_clip = np.frombuffer(reader.run_clip, dtype=np.uint8)
    run_base = np.frombuffer(reader.run_base, dtype=np.uint32)

    seg_from = list(seg_from)
    seg_to = list(seg_to)
    seg_run_list = list(seg_run)
    seg_vstart = list(seg_from_v - starts[seg_run])
    seg_vend = list(seg_to_v - starts[seg_run])
    seg_len = list(cumulative[seg_to_v] - cumulative[seg_from_v])
    seg_dir = list(run_dir[seg_run])

    # A run that stops at a node missing from the extract continues somewhere unknown: give it a
    # zero-length stub to a clipped node, so the analysis treats that end as unknown continuation.
    for run in np.flatnonzero(run_clip):
        for bit, vertex in ((1, int(starts[run])), (2, int(starts[run + 1] - 1))):
            if not run_clip[run] & bit:
                continue
            if is_barrier[vertex]:
                continue  # already a separate terminal of its own
            endpoint = int(np.searchsorted(node_ids, refs[vertex]))
            stub = synthetic(vertex, NODE_CLIPPED)
            seg_from.append(endpoint)
            seg_to.append(stub)
            seg_run_list.append(run)
            local = vertex - int(starts[run])
            seg_vstart.append(local)
            seg_vend.append(local)
            seg_len.append(0.0)
            seg_dir.append(BOTH)

    node_x.extend(synthetic_x)
    node_y.extend(synthetic_y)
    node_flags.extend(synthetic_flags)

    publishable = np.isin(run_class, list(PUBLISHABLE))
    coord_offset = np.full(runs, 0xFFFFFFFF, dtype=np.uint32)
    coords = array("i")
    for run in np.flatnonzero(publishable):
        coord_offset[run] = len(coords) // 2
        begin, end = int(starts[run]), int(starts[run + 1])
        pairs = np.empty((end - begin) * 2, dtype=np.int32)
        pairs[0::2] = x[begin:end]
        pairs[1::2] = y[begin:end]
        coords.frombytes(pairs.tobytes())

    return {
        "node_lonlat": np.column_stack([np.asarray(node_x, dtype=np.int32),
                                        np.asarray(node_y, dtype=np.int32)]).astype("<i4"),
        "node_flags": np.asarray(node_flags, dtype=np.uint8),
        "seg_from": np.asarray(seg_from, dtype="<u4"),
        "seg_to": np.asarray(seg_to, dtype="<u4"),
        "seg_run": np.asarray(seg_run_list, dtype="<u4"),
        "seg_vstart": np.asarray(seg_vstart, dtype="<u4"),
        "seg_vend": np.asarray(seg_vend, dtype="<u4"),
        "seg_len": np.asarray(seg_len, dtype="<f8"),
        "seg_dir": np.asarray(seg_dir, dtype=np.uint8),
        "run_way": np.frombuffer(reader.run_way, dtype=np.int64).astype("<i8"),
        "run_base": run_base.astype("<u4"),
        "run_class": run_class.copy(),
        "run_vertices": np.diff(starts).astype("<u4"),
        "run_flags": np.frombuffer(reader.run_flags, dtype=np.uint8).copy(),
        "run_coord_offset": coord_offset.astype("<u4"),
        "coords": np.frombuffer(coords, dtype=np.int32).astype("<i4"),
        "dropped_way": np.asarray([way for way, _ in reader.dropped], dtype="<i8"),
        "dropped_reason": np.asarray([reason for _, reason in reader.dropped], dtype=np.uint8),
    }


def extract(roads_pbf, barriers_pbf, output):
    barriers = BarrierReader()
    if barriers_pbf is not None:
        barriers.apply_file(str(barriers_pbf))
    reader = WayReader()
    reader.apply_file(str(roads_pbf), locations=True, idx="flex_mem")
    arrays = build_topology(reader, barriers.blocking)
    output.mkdir(parents=True, exist_ok=True)
    header = {"policyVersion": POLICY_VERSION, "arrays": {}}
    for name, values in arrays.items():
        (output / f"{name}.bin").write_bytes(np.ascontiguousarray(values).tobytes())
        header["arrays"][name] = {"dtype": str(values.dtype), "length": int(values.size)}
    header["nodes"] = int(len(arrays["node_flags"]))
    header["segments"] = int(len(arrays["seg_from"]))
    header["runs"] = int(len(arrays["run_way"]))
    (output / "header.json").write_text(json.dumps(header, indent=2, sort_keys=True) + "\n")
    return header


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--roads", required=True, type=Path, help="highway/ferry ways with their nodes")
    parser.add_argument("--barriers", type=Path, help="barrier nodes of those ways")
    parser.add_argument("--output", required=True, type=Path)
    options = parser.parse_args(argv)
    header = extract(options.roads, options.barriers, options.output)
    print(json.dumps({key: header[key] for key in ("nodes", "segments", "runs", "policyVersion")}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
