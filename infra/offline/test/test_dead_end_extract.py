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
        self.assertEqual(extract.way_policy({"highway": "primary", "access:conditional": "destination @ (weight>5)"})[0], 5)

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

    def test_barriers(self):
        self.assertFalse(extract.barrier_blocks({"barrier": "gate"}))
        self.assertTrue(extract.barrier_blocks({"barrier": "gate", "access": "private"}))
        self.assertTrue(extract.barrier_blocks({"barrier": "gate", "motor_vehicle:conditional": "no @ (Dec 01-May 15)"}))
        self.assertTrue(extract.barrier_blocks({"barrier": "bollard"}))
        self.assertFalse(extract.barrier_blocks({"barrier": "bollard", "motor_vehicle": "yes"}))
        self.assertFalse(extract.barrier_blocks({"barrier": "cattle_grid"}))


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
            self.assertEqual(json.loads((output / "header.json").read_text())["policyVersion"], 1)


if __name__ == "__main__":
    unittest.main()
