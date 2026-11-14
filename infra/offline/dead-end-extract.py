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
connection only when the public may drive a private car through it at any time. It follows
Valhalla 3.8.2's `lua/graph.lua` (the engine that serves the graph) and is stricter where they
differ: destination-only values (`destination`, `customers`, `delivery`, `private`, `permit`,
`residents`, which Valhalla routes as destination-only) are no exit; every `;` member of a value
is read; seasonal closures (`*:conditional`), directional car restrictions, `impassable=yes` and
`smoothness=impassable` without an explicit car permission, tracks, reversible ways and ferries
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

# Version 3: car access on any node (with or without a barrier tag) stops cars, as Valhalla's node
# access mask does. Version 2: destination-only values, all `;` members, discouraged/psv,
# directional access, impassable ways and nodes, conditional closures on ferries. Masks of
# earlier versions are refused.
POLICY_VERSION = 3

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

# Car access values Valhalla 3.8.2 recognises (`access`, `motor_vehicle`/`vehicle` tables of
# lua/graph.lua) that let the public drive through.
PUBLIC = {"yes", "permissive", "designated", "official", "public", "allowed"}
# Valhalla's destination-only values (its `private` table): a car may enter, but it is no exit.
DESTINATION_ONLY = {"private", "destination", "customers", "delivery", "permit", "residents"}
# Every other value Valhalla recognises for cars, the destination-only values, and two values
# this policy has always treated as closures (`military`, `unknown`).
NOT_THROUGH = DESTINATION_ONLY | {
    "no", "discouraged", "agricultural", "forestry", "emergency", "psv", "use_sidepath", "dismount",
    "restricted", "military", "unknown",
}
RECOGNISED = PUBLIC | NOT_THROUGH
ACCESS_KEYS = ("motorcar", "motor_vehicle", "vehicle", "access")
# Keys that can override `impassable` for cars (Valhalla's auto_tag).
OVERRIDE_KEYS = ("motorcar", "motor_vehicle", "vehicle")
CONDITIONAL_KEYS = tuple(f"{key}:conditional" for key in ACCESS_KEYS)
CONDITION = re.compile(r"(?:^|;)\s*([A-Za-z_]+)\s*@")
# `osmium tags-filter` expressions for the nodes `barrier_blocks` must see: barriers, impassable
# nodes and every node with a car access key, barrier or not.
NODE_FILTER = ("n/barrier", "n/impassable=yes", "n/smoothness=impassable",
               *(f"n/{key}" for key in ACCESS_KEYS + CONDITIONAL_KEYS))
PASSABLE_BARRIERS = {
    "gate", "lift_gate", "swing_gate", "sliding_gate", "hampshire_gate", "cattle_grid",
    "toll_booth", "border_control", "entrance", "height_restrictor",
}

# Reasons a way that could be published is left out of the topology; recorded in the mask.
DROP_REASONS = {"access": 1, "conditional": 2, "oneway": 3, "area": 4, "impassable": 5, "direction": 6}

NODE_CLIPPED = 1
NODE_BARRIER = 2
WAY_MISSING_NODES = 1


def members(value):
    """The `;`-separated members of a tag value, stripped ([] when the tag is absent)."""
    if value is None:
        return []
    return [member.strip() for member in value.split(";") if member.strip()]


def key_verdict(value):
    """'public', 'closed' or None for one access tag value. Every member is read: a value with
    any recognised member is recognised, and any recognised member that is not public closes it
    (Valhalla lets any permitting member win; this policy is stricter). A value with no
    recognised member (lane syntax such as `||no` mistagged without `:lanes`, typos) is None, so
    the next less specific key decides, as in Valhalla."""
    recognised = [member for member in members(value) if member in RECOGNISED]
    if not recognised:
        return None
    return "public" if all(member in PUBLIC for member in recognised) else "closed"


def car_verdict(tags, keys=ACCESS_KEYS):
    """The verdict of the most specific key with a recognised value, or None."""
    for key in keys:
        verdict = key_verdict(tags.get(key))
        if verdict is not None:
            return verdict
    return None


def destination_only(tags):
    """Valhalla marks a way destination-only when any of the four car keys has a destination-only
    member, whatever the more specific keys say; such a way is never a through exit."""
    return any(member in DESTINATION_ONLY for key in ACCESS_KEYS for member in members(tags.get(key)))


def motor_access(tags):
    """True when the public may drive a car through: the most specific recognised car key (or,
    without one, the highway default) permits it and no key makes it destination-only."""
    return car_verdict(tags) != "closed" and not destination_only(tags)


def closing_condition(value):
    return any(found in NOT_THROUGH for found in CONDITION.findall(value or ""))


def seasonal_closure(tags):
    """Any conditional car restriction, whatever its condition: a road closed part of the year
    (or to some cars) is never an exit."""
    return any(closing_condition(tags.get(key)) for key in CONDITIONAL_KEYS)


def impassable(tags):
    """`impassable=yes` or `smoothness=impassable` close a way to cars unless an explicit car key
    permits them (Valhalla's auto_tag override)."""
    if tags.get("impassable") != "yes" and tags.get("smoothness") != "impassable":
        return False
    return car_verdict(tags, OVERRIDE_KEYS) != "public"


def oneway_directions(tags, highway):
    """Legal car directions from `oneway` relative to the node order, or None when unknowable."""
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


def directional_open(tags, side):
    """False when a directional car restriction closes travel along `side` ('forward' or
    'backward' of the node order). Any directional car key whose members are not all public (a
    closure, a destination-only or an unrecognised value, which Valhalla reads as no access) or
    that has a conditional restriction closes the direction. A directional permission never
    opens a direction that `oneway` closes."""
    for key in ACCESS_KEYS:
        value = tags.get(f"{key}:{side}")
        if value is not None and any(member not in PUBLIC for member in members(value) or [""]):
            return False
        if closing_condition(tags.get(f"{key}:{side}:conditional")):
            return False
    return True


def directions(tags, highway):
    """Legal public car directions relative to the node order: `oneway` (or its implied value)
    minus every direction a directional restriction closes. None when `oneway` is unknowable, 0
    when no direction is open."""
    found = oneway_directions(tags, highway)
    if found is None:
        return None
    if not directional_open(tags, "forward"):
        found &= ~FORWARD
    if not directional_open(tags, "backward"):
        found &= ~BACKWARD
    return found


def way_policy(tags):
    """(class code, directions) for a car connection, ("drop", reason) for a publishable class
    that is left out, or None for anything else that is not a car connection."""
    if tags.get("route") == "ferry":
        # A ferry needs explicit car permission; the common restrictions (destination-only,
        # conditional closures, impassable, directions) apply to it as to a road.
        if car_verdict(tags, ("motorcar", "motor_vehicle")) != "public":
            return None
        code, highway = FERRY, None
    else:
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
    elif impassable(tags):
        reason = "impassable"
    found = directions(tags, highway)
    if reason is None and found is None:
        reason = "oneway"
    elif reason is None and found == 0:
        reason = "direction"
    if reason is not None:
        return ("drop", reason) if code in PUBLISHABLE else None
    if highway == "service" and tags.get("service") in MINOR_SERVICE_VALUES:
        code = MINOR_SERVICE
    return code, found


def barrier_blocks(tags):
    """True for a node cars cannot pass. Car access on the node decides first, whatever its
    `barrier` tag (none, `no` or a type): Valhalla applies a node's access mask to every edge
    through it. So an impassable node without an explicit car permission, a conditional or
    destination-only restriction, or a recognised non-public car value (most specific key first)
    blocks. Without car access tags, only a barrier type that stops cars blocks."""
    if tags.get("impassable") == "yes" or tags.get("smoothness") == "impassable":
        if car_verdict(tags, OVERRIDE_KEYS) != "public":
            return True
    if seasonal_closure(tags) or destination_only(tags):
        return True
    verdict = car_verdict(tags)
    if verdict is not None:
        return verdict != "public"
    barrier = tags.get("barrier")
    if barrier is None or barrier == "no":
        return False
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


def swap_directions(direction):
    return ((direction & FORWARD) << 1) | ((direction & BACKWARD) >> 1)


def physical_stretches(refs, seg_from, seg_to, seg_from_v, seg_to_v, seg_dir):
    """Collapses segments that are the same physical stretch: the same topology end nodes and the
    same OSM nodes in between, in either order (a way drawn A → P → A, or two ways over one
    road). Returns, per segment, the index of its stretch's representative segment and the
    directions of the whole stretch relative to the segment's own node order (the union of every
    copy's directions), so the analysis counts one road once, with its length once. Distinct
    geometry (a parallel road, a grade-separated carriageway) has other nodes and stays separate.
    """
    count = len(seg_from)
    phys = np.arange(count, dtype=np.int64)
    merged = np.asarray(seg_dir, dtype=np.uint8).copy()
    if count < 2:
        return phys, merged
    low = np.minimum(seg_from, seg_to)
    high = np.maximum(seg_from, seg_to)
    span = seg_to_v - seg_from_v
    order = np.lexsort((span, high, low))
    same = (low[order][1:] == low[order][:-1]) & (high[order][1:] == high[order][:-1]) & \
        (span[order][1:] == span[order][:-1])
    starts_of_group = np.flatnonzero(np.concatenate(([True], ~same)))
    ends_of_group = np.concatenate((starts_of_group[1:], [count]))
    for first, last in zip(starts_of_group, ends_of_group):
        if last - first < 2:
            continue
        representatives = []  # (sequence, segment)
        for segment in order[first:last]:
            segment = int(segment)
            sequence = (int(seg_from[segment]),
                        *refs[seg_from_v[segment] + 1:seg_to_v[segment]].tolist(),
                        int(seg_to[segment]))
            reverse = sequence[::-1]
            for known, representative in representatives:
                if sequence == known or reverse == known:
                    phys[segment] = representative
                    own = int(seg_dir[segment])
                    merged[representative] |= own if sequence == known else swap_directions(own)
                    break
            else:
                representatives.append((sequence, segment))
    # Every copy carries the stretch's merged directions in its own node order.
    for segment in np.flatnonzero(phys != np.arange(count)):
        representative = int(phys[segment])
        sequence_same = (int(seg_from[segment]) == int(seg_from[representative])
                         and int(seg_to[segment]) == int(seg_to[representative])
                         and np.array_equal(refs[seg_from_v[segment]:seg_to_v[segment] + 1],
                                            refs[seg_from_v[representative]:seg_to_v[representative] + 1]))
        merged[segment] = merged[representative] if sequence_same else swap_directions(int(merged[representative]))
    return phys, merged


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

    seg_phys, merged_dir = physical_stretches(refs, seg_from, seg_to, seg_from_v, seg_to_v,
                                              run_dir[seg_run])
    seg_from = list(seg_from)
    seg_to = list(seg_to)
    seg_run_list = list(seg_run)
    seg_vstart = list(seg_from_v - starts[seg_run])
    seg_vend = list(seg_to_v - starts[seg_run])
    seg_len = list(cumulative[seg_to_v] - cumulative[seg_from_v])
    seg_dir = list(merged_dir)
    seg_phys = list(seg_phys)

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
            seg_phys.append(len(seg_phys))

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
        "seg_phys": np.asarray(seg_phys, dtype="<u4"),
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
    parser.add_argument("--roads", type=Path, help="highway/ferry ways with their nodes")
    parser.add_argument("--barriers", type=Path, help="nodes of those ways matching NODE_FILTER")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--print-node-filter", action="store_true",
                        help="print the osmium tags-filter expressions for --barriers and exit")
    options = parser.parse_args(argv)
    if options.print_node_filter:
        print(" ".join(NODE_FILTER))
        return 0
    if options.roads is None or options.output is None:
        parser.error("--roads and --output are required")
    header = extract(options.roads, options.barriers, options.output)
    print(json.dumps({key: header[key] for key in ("nodes", "segments", "runs", "policyVersion")}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
