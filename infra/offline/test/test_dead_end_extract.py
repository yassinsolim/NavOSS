import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

SCRIPTS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("dead_end_extract", SCRIPTS / "dead-end-extract.py")
extract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extract)


def write_osm(path, nodes, ways, node_tags=None):
    """OSM XML for nodes {id: (lat, lon)} and ways [(id, refs, tags)]."""
    xml = ['<osm version="0.6">']
    for identifier, (lat, lon) in nodes.items():
        tags = "".join(f'<tag k="{k}" v="{v}"/>' for k, v in (node_tags or {}).get(identifier, {}).items())
        xml.append(f'<node id="{identifier}" version="1" lat="{lat}" lon="{lon}">{tags}</node>')
    for identifier, refs, tags in ways:
        xml.append(f'<way id="{identifier}" version="1">')
        xml.extend(f'<nd ref="{ref}"/>' for ref in refs)
        xml.extend(f'<tag k="{key}" v="{value}"/>' for key, value in tags.items())
        xml.append("</way>")
    xml.append("</osm>")
    path.write_text("\n".join(xml))


def run_extract(directory, nodes, ways, node_tags=None):
    source = Path(directory) / "roads.osm"
    write_osm(source, nodes, ways, node_tags)
    output = Path(directory) / "topology"
    header = extract.extract(source, source, output)

    def read(name):
        info = header["arrays"][name]
        return np.frombuffer((output / f"{name}.bin").read_bytes(), dtype=np.dtype(info["dtype"]).newbyteorder("<"))
    return read


class PolicyTests(unittest.TestCase):
    def test_car_access(self):
        self.assertEqual(extract.way_policy({"highway": "residential"}), (12, extract.BOTH))
        self.assertIsNone(extract.way_policy({"highway": "track"}))
        self.assertIsNone(extract.way_policy({"highway": "footway"}))
        self.assertIsNone(extract.way_policy({"highway": "residential", "access": "private"}))
        self.assertEqual(extract.way_policy({"highway": "primary", "access": "private"}), ("drop", "access"))
        # The most specific recognised key decides.
        self.assertEqual(extract.way_policy({"highway": "secondary", "access": "no", "motor_vehicle": "yes"})[0], 7)
        self.assertEqual(extract.way_policy({"highway": "secondary", "motorcar": "no", "access": "yes"}), ("drop", "access"))
        # Lane syntax mistagged on the plain key (BC 99 has `motor_vehicle=||no`) is not a closure.
        self.assertEqual(extract.way_policy({"highway": "motorway", "motor_vehicle": "||no"}), (1, extract.FORWARD))
        self.assertEqual(extract.way_policy({"highway": "service", "service": "driveway"})[0], extract.MINOR_SERVICE)
        self.assertEqual(extract.way_policy({"highway": "service", "service": "emergency_access"}), None)

    def test_seasonal_closure_is_not_a_connection(self):
        tags = {"highway": "primary", "motor_vehicle:conditional": "no @ (Dec 01-May 14)"}
        self.assertEqual(extract.way_policy(tags), ("drop", "conditional"))
        self.assertEqual(extract.way_policy({**tags, "highway": "residential"}), None)
        # Every closing value counts, whatever the condition: never an exit, all year.
        self.assertEqual(extract.way_policy({"highway": "primary", "access:conditional": "destination @ (weight>5)"}),
                         ("drop", "conditional"))
        self.assertEqual(extract.way_policy({"highway": "primary", "motor_vehicle:conditional": "yes @ (Jun-Sep)"})[0], 5)

    def test_directions(self):
        self.assertEqual(extract.way_policy({"highway": "motorway"})[1], extract.FORWARD)
        self.assertEqual(extract.way_policy({"highway": "motorway_link"})[1], extract.FORWARD)
        self.assertEqual(extract.way_policy({"highway": "motorway", "oneway": "no"})[1], extract.BOTH)
        self.assertEqual(extract.way_policy({"highway": "residential", "junction": "roundabout"})[1], extract.FORWARD)
        self.assertEqual(extract.way_policy({"highway": "residential", "oneway": "-1"})[1], extract.BACKWARD)
        self.assertEqual(extract.way_policy({"highway": "primary", "oneway": "reversible"}), ("drop", "oneway"))

    def test_ferries_need_explicit_car_access(self):
        self.assertIsNone(extract.way_policy({"route": "ferry"}))
        self.assertIsNone(extract.way_policy({"route": "ferry", "foot": "yes"}))
        self.assertEqual(extract.way_policy({"route": "ferry", "motor_vehicle": "yes"}), (extract.FERRY, extract.BOTH))
        self.assertIsNone(extract.way_policy({"route": "ferry", "motor_vehicle": "yes",
                                              "motor_vehicle:conditional": "no @ (Dec 01-May 14)"}))
        self.assertIsNone(extract.way_policy({"route": "ferry", "motor_vehicle": "destination"}))
        self.assertIsNone(extract.way_policy({"route": "ferry", "access": "yes"}))

    def test_barriers(self):
        self.assertFalse(extract.barrier_blocks({"barrier": "gate"}))
        self.assertTrue(extract.barrier_blocks({"barrier": "gate", "access": "private"}))
        self.assertTrue(extract.barrier_blocks({"barrier": "gate", "motor_vehicle:conditional": "no @ (Dec 01-May 15)"}))
        self.assertTrue(extract.barrier_blocks({"barrier": "bollard"}))
        self.assertFalse(extract.barrier_blocks({"barrier": "bollard", "motor_vehicle": "yes"}))
        self.assertFalse(extract.barrier_blocks({"barrier": "cattle_grid"}))
        self.assertTrue(extract.barrier_blocks({"barrier": "gate", "access": "destination"}))
        self.assertTrue(extract.barrier_blocks({"barrier": "gate", "motor_vehicle": "yes;no"}))
        self.assertTrue(extract.barrier_blocks({"impassable": "yes"}))
        self.assertFalse(extract.barrier_blocks({"impassable": "yes", "motor_vehicle": "yes"}))

    def test_review_vectors_supply_no_car_connection(self):
        # Independent review of 0378b15: each of these was a two-way car connection.
        residential = {"highway": "residential"}
        for name, tags in [
            ("destination", {**residential, "access": "destination"}),
            ("customers", {**residential, "motor_vehicle": "customers"}),
            ("delivery", {**residential, "vehicle": "delivery"}),
            ("destination below a public key", {**residential, "motor_vehicle": "yes", "access": "destination"}),
            ("discouraged", {**residential, "motor_vehicle": "discouraged"}),
            ("psv", {**residential, "access": "psv"}),
            ("all members", {**residential, "motor_vehicle": "||no;no"}),
            ("a later member", {**residential, "motor_vehicle": "yes;private"}),
            ("ferry closure", {"route": "ferry", "motor_vehicle": "yes", "motor_vehicle:conditional": "no @ (Dec 01-May 14)"}),
            ("both directions", {**residential, "motor_vehicle:forward": "no", "motor_vehicle:backward": "no"}),
            ("vehicle directions", {**residential, "vehicle:forward": "no", "vehicle:backward": "destination"}),
            ("impassable", {**residential, "impassable": "yes"}),
            ("smoothness", {**residential, "smoothness": "impassable"}),
            ("impassable with access", {**residential, "impassable": "yes", "access": "yes"}),
        ]:
            with self.subTest(name):
                self.assertIsNone(extract.way_policy(tags))
        # The same closures on a publishable class are recorded as excluded with their reason.
        self.assertEqual(extract.way_policy({"highway": "primary", "access": "destination"}), ("drop", "access"))
        self.assertEqual(extract.way_policy({"highway": "primary", "impassable": "yes"}), ("drop", "impassable"))
        self.assertEqual(extract.way_policy({"highway": "primary", "motor_vehicle:forward": "no",
                                             "motor_vehicle:backward": "no"}), ("drop", "direction"))
        # An explicit car permission overrides impassable, as in Valhalla.
        self.assertEqual(extract.way_policy({**residential, "smoothness": "impassable", "motorcar": "yes"}),
                         (12, extract.BOTH))
        # Unrecognised standalone values keep the default; recognised members after them do not.
        self.assertEqual(extract.way_policy({"highway": "motorway", "motor_vehicle": "||no"}), (1, extract.FORWARD))
        self.assertEqual(extract.way_policy({**residential, "motor_vehicle": "||no", "access": "no"}), None)

    def test_directional_access(self):
        residential = {"highway": "residential"}
        self.assertEqual(extract.way_policy({**residential, "motor_vehicle:forward": "no"}), (12, extract.BACKWARD))
        self.assertEqual(extract.way_policy({**residential, "vehicle:backward": "no"}), (12, extract.FORWARD))
        self.assertEqual(extract.way_policy({**residential, "motor_vehicle:backward": "private"}), (12, extract.FORWARD))
        # An unrecognised directional value is no known direction, never both.
        self.assertEqual(extract.way_policy({**residential, "motor_vehicle:forward": "||x"}), (12, extract.BACKWARD))
        self.assertEqual(extract.way_policy({**residential, "motor_vehicle:forward:conditional": "no @ (Mo-Fr)"}),
                         (12, extract.BACKWARD))
        # A directional permission never opens what oneway closes.
        self.assertEqual(extract.way_policy({**residential, "oneway": "yes", "motor_vehicle:backward": "yes"}),
                         (12, extract.FORWARD))
        self.assertEqual(extract.way_policy({**residential, "oneway": "yes", "motor_vehicle:forward": "no"}), None)


class ExtractTests(unittest.TestCase):
    def test_topology_from_osm(self):
        nodes = {1: (51.0, -114.0), 2: (51.0, -113.99), 3: (51.0, -113.98), 4: (51.01, -113.99),
                 5: (51.0, -113.97), 6: (51.0, -113.96)}
        ways = [
            (10, [1, 2, 3], {"highway": "secondary"}),
            (11, [2, 4], {"highway": "residential"}),
            # Gated in the middle (node 5), and continuing to node 99, which the extract lacks.
            (12, [3, 5, 6, 99], {"highway": "secondary"}),
            (13, [1, 4], {"highway": "track"}),
            (14, [4, 3], {"highway": "primary", "access": "private"}),
        ]
        xml = ['<osm version="0.6">']
        for identifier, (lat, lon) in nodes.items():
            tags = '<tag k="barrier" v="bollard"/>' if identifier == 5 else ""
            xml.append(f'<node id="{identifier}" version="1" lat="{lat}" lon="{lon}">{tags}</node>')
        for identifier, refs, tags in ways:
            xml.append(f'<way id="{identifier}" version="1">')
            xml.extend(f'<nd ref="{ref}"/>' for ref in refs)
            xml.extend(f'<tag k="{key}" v="{value}"/>' for key, value in tags.items())
            xml.append("</way>")
        xml.append("</osm>")
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "roads.osm"
            source.write_text("\n".join(xml))
            output = Path(directory) / "topology"
            header = extract.extract(source, source, output)

            def read(name):
                info = header["arrays"][name]
                return np.frombuffer((output / f"{name}.bin").read_bytes(), dtype=np.dtype(info["dtype"]).newbyteorder("<"))

            self.assertEqual(sorted(read("run_way").tolist()), [10, 11, 12])
            self.assertEqual(read("dropped_way").tolist(), [14])
            flags = read("node_flags")
            # Way 10 splits at 2 (shared with 11); way 12 splits at the bollard into two terminals,
            # and its run ends before the missing node with a zero-length stub to a clipped node.
            segments = list(zip(read("seg_from").tolist(), read("seg_to").tolist(), read("seg_len").tolist()))
            self.assertEqual(len(segments), 6)
            self.assertEqual(int((flags & extract.NODE_BARRIER > 0).sum()), 2)
            self.assertEqual(int((flags & extract.NODE_CLIPPED > 0).sum()), 1)
            stub = [segment for segment in segments if flags[segment[1]] & extract.NODE_CLIPPED]
            self.assertEqual(len(stub), 1)
            self.assertEqual(stub[0][2], 0.0)
            run_flags = dict(zip(read("run_way").tolist(), read("run_flags").tolist()))
            self.assertEqual(run_flags[12], extract.WAY_MISSING_NODES)
            lengths = sorted(round(segment[2]) for segment in segments)
            self.assertEqual(lengths[1:3], [700, 700])  # 0.01° of longitude at 51°N
            # Publishable ways keep their vertices for the mask; residential ones do not.
            offsets = dict(zip(read("run_way").tolist(), read("run_coord_offset").tolist()))
            self.assertEqual(offsets[11], 0xFFFFFFFF)
            self.assertEqual(len(read("coords")), 2 * (3 + 3))
            self.assertEqual(json.loads((output / "header.json").read_text())["policyVersion"], 2)


    def test_secondary_outlet_with_a_closure_is_no_second_exit(self):
        """A pocket (nodes 10-12) hangs off core corner 1 of a square; a second road from 12 to the
        opposite corner 3 is its only other outlet. With each closure the review found, an
        independent oracle on the extracted topology finds no route between the pocket and the core
        that avoids junction 1 in both directions; with a public outlet (and BC 99's unrecognised
        `||no`) it finds one."""
        nodes = {1: (51.0, -114.0), 2: (51.0, -113.99), 3: (51.01, -113.99), 4: (51.01, -114.0),
                 10: (50.99, -114.01), 11: (50.98, -114.01), 12: (50.98, -114.0), 13: (51.0, -113.98)}
        base = [
            (1, [1, 2], {"highway": "secondary"}), (2, [2, 3], {"highway": "secondary"}),
            (3, [3, 4], {"highway": "secondary"}), (4, [4, 1], {"highway": "secondary"}),
            (5, [1, 10, 11], {"highway": "residential"}), (6, [11, 12, 10], {"highway": "residential"}),
        ]

        def second_exit(tags):
            with tempfile.TemporaryDirectory() as directory:
                read = run_extract(directory, nodes, base + [(7, [12, 13, 3], tags)])
                lonlat = read("node_lonlat").reshape(-1, 2)
                index = {osm: int(np.flatnonzero((lonlat[:, 0] == round(lon * 1e7)) & (lonlat[:, 1] == round(lat * 1e7)))[0])
                         for osm, (lat, lon) in nodes.items()
                         if ((lonlat[:, 0] == round(lon * 1e7)) & (lonlat[:, 1] == round(lat * 1e7))).any()}
                arcs = set()
                for a, b, d in zip(read("seg_from").tolist(), read("seg_to").tolist(), read("seg_dir").tolist()):
                    if d & extract.FORWARD:
                        arcs.add((a, b))
                    if d & extract.BACKWARD:
                        arcs.add((b, a))
                choke = index[1]

                def reaches(start, goal):
                    seen, queue = {start}, [start]
                    while queue:
                        node = queue.pop()
                        for a, b in arcs:
                            if a == node and b != choke and b not in seen:
                                seen.add(b)
                                queue.append(b)
                    return goal in seen
                return reaches(index[11], index[3]) and reaches(index[3], index[11])

        self.assertTrue(second_exit({"highway": "residential"}))
        self.assertTrue(second_exit({"highway": "residential", "motor_vehicle": "||no"}))
        for name, tags in [
            ("destination", {"access": "destination"}),
            ("customers", {"motor_vehicle": "customers"}),
            ("discouraged", {"motor_vehicle": "discouraged"}),
            ("psv", {"access": "psv"}),
            ("all members", {"motor_vehicle": "||no;no"}),
            ("seasonal", {"motor_vehicle:conditional": "no @ (Dec 01-May 14)"}),
            ("directional both", {"motor_vehicle:forward": "no", "motor_vehicle:backward": "no"}),
            ("directional one way out only", {"motor_vehicle:backward": "no"}),
            ("impassable", {"impassable": "yes"}),
            ("smoothness", {"smoothness": "impassable"}),
        ]:
            with self.subTest(name):
                self.assertFalse(second_exit({"highway": "residential", **tags}))
        # A ferry outlet with a seasonal closure is no exit either.
        with self.subTest("ferry"):
            self.assertFalse(second_exit({"route": "ferry", "motor_vehicle": "yes",
                                          "motor_vehicle:conditional": "no @ (Dec 01-May 14)"}))
            self.assertTrue(second_exit({"route": "ferry", "motor_vehicle": "yes"}))
        # An impassable node on the public outlet stops it too.
        with tempfile.TemporaryDirectory() as directory:
            read = run_extract(directory, nodes, base + [(7, [12, 13, 3], {"highway": "residential"})],
                               {13: {"impassable": "yes"}})
            self.assertEqual(int((read("node_flags") & extract.NODE_BARRIER > 0).sum()), 2)

    def test_retraced_and_overlapping_stretches_are_one_road(self):
        nodes = {1: (51.0, -114.0), 2: (51.0, -113.99), 3: (51.0, -113.98), 4: (51.01, -113.99),
                 5: (51.005, -113.98)}
        with tempfile.TemporaryDirectory() as directory:
            read = run_extract(directory, nodes, [
                # Drawn out and back over the same nodes; 3 is shared with the spur.
                (1, [1, 2, 3, 2, 1], {"highway": "primary"}),
                (2, [3, 4], {"highway": "residential"}),
                # Two one-way ways over the same nodes, opposite ways: one two-way road.
                (3, [1, 4], {"highway": "secondary", "oneway": "yes"}),
                (4, [4, 1], {"highway": "secondary", "oneway": "yes"}),
                # A distinct road between junctions 3 and 4 beside the spur keeps its identity.
                (5, [3, 5, 4], {"highway": "secondary"}),
            ])
            phys = read("seg_phys").tolist()
            frm, to, dirs = read("seg_from").tolist(), read("seg_to").tolist(), read("seg_dir").tolist()
            run_way = read("run_way").tolist()
            run = read("seg_run").tolist()
            way_of = [run_way[r] for r in run]
            groups = {}
            for segment, representative in enumerate(phys):
                groups.setdefault(representative, []).append(segment)
            # Way 1 has four segments (1-2, 2-3, 3-2, 2-1): two stretches of two copies each.
            way1 = [g for g in groups.values() if all(way_of[s] == 1 for s in g)]
            self.assertEqual(sorted(len(g) for g in way1), [2, 2])
            # Ways 3 and 4 are one stretch carrying both directions in each copy's own order.
            pair = [g for g in groups.values() if {way_of[s] for s in g} == {3, 4}]
            self.assertEqual(len(pair), 1)
            for segment in pair[0]:
                self.assertEqual(dirs[segment], extract.BOTH)
            # Way 5 joins the same junctions as the spur by other nodes: not a copy of anything.
            self.assertTrue(all(len(g) == 1 for g in groups.values() if any(way_of[s] == 5 for s in g)))
            self.assertTrue(all(phys[phys[s]] == phys[s] for s in range(len(phys))))
            self.assertTrue(all({frm[s], to[s]} == {frm[g[0]], to[g[0]]} for g in groups.values() for s in g))


if __name__ == "__main__":
    unittest.main()
