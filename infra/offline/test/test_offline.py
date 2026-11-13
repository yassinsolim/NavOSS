import hashlib
import importlib.util
import io
import json
import sqlite3
import struct
import tarfile
import tempfile
import unittest
from pathlib import Path

from shapely.geometry import Point, box, shape

SCRIPTS = Path(__file__).resolve().parents[1]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


search = module("offline_search", "build-search.py")
query_tool = module("offline_query", "query-search.py")
routing = module("offline_routing", "assemble-routing.py")
regions = module("offline_regions", "generate-regions.py")


class SearchTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="navoss-offline-test-")
        self.root = Path(self.temporary.name)
        self.aliases = {"avenue": "av", "ave": "av", "southwest": "sw"}
        self.categories = {
            ("amenity", "cafe"): ["cafe"], ("amenity", "bar"): ["bar"],
            ("amenity", "fast_food"): ["restaurant", "takeout"],
        }
        nodes = [
            (1, 0.02, 0.02, {"tourism": "attraction", "name": "Testville Tower", "alt_name": "Test Observation;Tour de Test", "addr:city": "Testville"}),
            (2, 0.001, 0.001, {"tourism": "attraction", "name": "Dome Tower", "addr:city": "Testville"}),
            (3, 0.002, 0.002, {"addr:housenumber": "101", "addr:street": "9 Avenue SW"}),
            (4, 0.003, 0.003, {"addr:housenumber": "1012", "addr:street": "96 Avenue SW"}),
            (5, 0.004, 0.004, {"amenity": "cafe", "name": "École Café", "short_name": "École"}),
            (6, 0.5, 0.5, {"amenity": "cafe", "name": "Far Café"}),
            (7, 0.0, 0.0, {"amenity": "bar", "name": "Café Bar"}),
            (8, 0.005, 0.005, {"amenity": "fast_food", "name": "Test Takeout"}),
            (9, 0.006, 0.006, {"aeroway": "aerodrome", "name": "Test Airfield"}),
            (10, 0.007, 0.007, {"amenity": "cafe"}),
            (11, 2.0, 2.0, {"amenity": "cafe", "name": "Outside Footprint"}),
            (12, 0.4, 0.4, {"building": "yes", "name": "Testville Town Hall"}),
        ]
        from xml.sax.saxutils import quoteattr
        xml = ['<osm version="0.6">']
        for identifier, latitude, longitude, tags in nodes:
            xml.append(f'<node id="{identifier}" lat="{latitude}" lon="{longitude}">')
            xml.extend(f'<tag k={quoteattr(key)} v={quoteattr(value)}/>' for key, value in tags.items())
            xml.append('</node>')
        xml.append('</osm>')
        source = self.root / "test.osm"
        source.write_text("".join(xml))
        self.database = self.root / "search.sqlite"
        self.counts = search.build(source, self.database, box(-1, -1, 1, 1), SCRIPTS / "search-schema.sql", self.aliases, self.categories, {"schema_version": "1"})

    def tearDown(self):
        self.temporary.cleanup()

    def results(self, text="", category=None):
        return query_tool.query(self.database, text, category, 0, 0, 2, 10, self.aliases, SCRIPTS)

    def test_real_fts_and_schema_are_readable_and_integrity_checked(self):
        connection = sqlite3.connect(f"{self.database.as_uri()}?mode=ro&immutable=1", uri=True)
        try:
            self.assertEqual(connection.execute("PRAGMA application_id").fetchone()[0], 0x4E564F53)
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 1)
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(self.counts["total"], 11)
            self.assertEqual(connection.execute("SELECT count(*) FROM places_rtree").fetchone()[0], 11)
        finally:
            connection.close()

    def test_partial_name_is_not_outranked_by_city_from_an_address(self):
        results = self.results("Testv Tow")
        self.assertEqual(results[0]["name"], "Testville Tower")
        self.assertNotIn("Dome Tower", [row["name"] for row in results])

    def test_completed_address_numbers_do_not_prefix_match_wrong_houses_or_streets(self):
        self.assertEqual(search.prefix_query("101 9 Avenue Southwest", self.aliases), '"101" AND "9" AND "av"* AND "sw"*')
        results = self.results("101 9 Avenue Southwest")
        self.assertEqual([row["address"] for row in results], ["101 9 Avenue SW"])

    def test_name_variants_diacritics_and_category_proximity(self):
        self.assertEqual(self.results("ecol caf")[0]["name"], "École Café")
        self.assertEqual(self.results("Test Observ")[0]["name"], "Testville Tower")
        cafes = self.results(category="cafe")
        self.assertEqual(cafes[0]["name"], "École Café")
        self.assertNotIn("Café Bar", [row["name"] for row in cafes])
        self.assertNotIn("Far Café", [row["name"] for row in cafes])
        self.assertNotIn("Outside Footprint", [row["name"] for row in cafes])
        self.assertEqual(self.results(category="takeout")[0]["name"], "Test Takeout")
        self.assertEqual(self.results("Test Airf")[0]["osm_class"], "aeroway")
        unnamed = [row for row in cafes if row["name_source"] == "category"]
        self.assertEqual(len(unnamed), 1)

    def test_input_is_quoted_not_executed_as_fts_operators(self):
        self.assertEqual(search.prefix_query('"café" OR hotel', self.aliases), '"cafe"* AND "or"* AND "hotel"*')
        self.assertEqual(self.results('"café" OR hotel'), [])
        self.assertEqual(self.results(""), [])


GRAPH = {"graphId": "a" * 64, "speedProfileSha256": "b" * 64, "routingEngineVersion": "3.9.1", "tileFormat": "valhalla-gph", "tileFormatVersion": "3.9.1", "dataDate": "2026-11-11"}


def source_tar(path, tiles, marker=None):
    with tarfile.open(path, "w") as archive:
        for name, content in tiles.items():
            content = struct.pack("<Q2f16sQ", 0, 0.0, 0.0, b"3.9.1", 0) + content
            archive.addfile(routing.member_info(name, len(content), 1), io.BytesIO(content))
        if marker is not None:
            encoded = json.dumps(marker).encode()
            archive.addfile(routing.member_info(routing.METADATA_NAME, len(encoded), 1), io.BytesIO(encoded))


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="navoss-routing-test-")
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_merging_same_graph_deduplicates_and_rebuilds_real_seek_offsets(self):
        first, second = self.root / "first.tar", self.root / "second.tar"
        source_tar(first, {"2/001/000.gph": b"first tile"}, GRAPH)
        source_tar(second, {"2/001/000.gph": b"first tile", "1/000/100.gph": b"second tile"}, GRAPH)
        output = self.root / "merged.tar"
        result = routing.assemble([first, second], output, 123)
        self.assertEqual(result["tiles"], 2)
        with tarfile.open(output) as archive, output.open("rb") as data:
            self.assertEqual(archive.getmembers()[0].name, "index.bin")
            index = archive.extractfile("index.bin").read()
            self.assertEqual(len(index), 2 * struct.calcsize(routing.INDEX_FORMAT))
            for offset, identifier, size in struct.iter_unpack(routing.INDEX_FORMAT, index):
                member = next(member for member in archive.getmembers() if member.name.endswith(".gph") and routing.graph_id(member.name) == identifier)
                self.assertEqual(offset, member.offset_data)
                self.assertEqual(size, member.size)
                data.seek(offset)
                self.assertEqual(data.read(size), archive.extractfile(member).read())
            self.assertEqual(json.load(archive.extractfile(routing.METADATA_NAME)), GRAPH)
        duplicate = self.root / "merged-again.tar"
        routing.assemble([second, first], duplicate, 123)
        self.assertEqual(hashlib.sha256(output.read_bytes()).digest(), hashlib.sha256(duplicate.read_bytes()).digest())

    def test_independent_graphs_and_conflicting_duplicate_tiles_fail_closed(self):
        first, second = self.root / "first.tar", self.root / "second.tar"
        source_tar(first, {"2/001/000.gph": b"first"}, GRAPH)
        source_tar(second, {"2/001/001.gph": b"second"}, {**GRAPH, "graphId": "c" * 64})
        with self.assertRaisesRegex(ValueError, "different graph"):
            routing.assemble([first, second], self.root / "bad.tar", 123)
        source_tar(second, {"2/001/000.gph": b"different"}, GRAPH)
        with self.assertRaisesRegex(ValueError, "tile bytes differ"):
            routing.assemble([first, second], self.root / "bad.tar", 123)

    def test_unmarked_graphs_cannot_be_merged_or_relabelled_as_compatible(self):
        first, second = self.root / "first.tar", self.root / "second.tar"
        source_tar(first, {"2/001/000.gph": b"first"})
        source_tar(second, {"2/001/001.gph": b"second"})
        with self.assertRaisesRegex(ValueError, "unmarked"):
            routing.assemble([first, second], self.root / "bad.tar", 123)
        with self.assertRaisesRegex(ValueError, "only one"):
            routing.assemble([first, second], self.root / "bad.tar", 123, GRAPH)
        canonical = self.root / "canonical.tar"
        routing.assemble([first], canonical, 123, canonicalize=True)
        marked = self.root / "marked.tar"
        routing.assemble([canonical], marked, 123, GRAPH)
        self.assertTrue(marked.is_file())

    def test_existing_outputs_and_unsafe_tar_members_are_never_overwritten(self):
        source = self.root / "source.tar"
        source_tar(source, {"../../outside.gph": b"bad"}, GRAPH)
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            routing.assemble([source], self.root / "new.tar", 123)
        existing = self.root / "existing.tar"
        existing.write_bytes(b"user file")
        with self.assertRaisesRegex(ValueError, "new path"):
            routing.assemble([source], existing, 123)
        self.assertEqual(existing.read_bytes(), b"user file")


class RegionTests(unittest.TestCase):
    def test_checked_in_regions_cover_the_complete_source_and_have_closed_footprints(self):
        definitions = json.loads((SCRIPTS / "regions/definitions.json").read_text())
        generated = regions.generate(SCRIPTS / "regions/sources", definitions)
        self.assertEqual(len(generated["features"]), len(definitions["regions"]))
        calgary = next(feature for feature in generated["features"] if feature["properties"]["id"] == "calgary")
        self.assertEqual(calgary["properties"]["overlapMeters"], 20000)
        # GeoJSON coordinates are longitude/latitude; don't transpose the Calgary footprint.
        footprint = shape(calgary["geometry"])
        self.assertTrue(footprint.covers(Point(-114.06, 51.04)))
        self.assertTrue(footprint.is_valid)
        self.assertFalse(footprint.covers(Point(-123.1, 49.2)))

    def test_poly_holes_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "holes.poly"
            path.write_text("test\n1\n0 0\n2 0\n2 2\n0 2\n0 0\nEND\n!2\n0.5 0.5\n1.5 0.5\n1.5 1.5\n0.5 1.5\n0.5 0.5\nEND\nEND\n")
            footprint = regions.read_poly(path)
            self.assertFalse(footprint.covers(Point(1, 1)))
            self.assertTrue(footprint.covers(Point(0.1, 0.1)))


if __name__ == "__main__":
    unittest.main()
