#!/usr/bin/env python3
"""Read public OSM data into a compact, immutable phone search database (schema 1)."""
import argparse
import csv
import hashlib
import json
import re
import sqlite3
import unicodedata
from collections import Counter
from pathlib import Path

import osmium
from shapely import wkb
from shapely.geometry import LineString, Point, Polygon, shape
from shapely.prepared import prep

NAME_KEYS = {"name", "alt_name", "official_name", "short_name", "loc_name", "old_name", "int_name"}
POI_KEYS = ("amenity", "shop", "tourism", "leisure", "healthcare", "office", "place",
            "aeroway", "railway", "historic", "man_made", "building")
OSM_TYPE_CODES = {"node": 0, "way": 1, "relation": 2}


def normalize(value, aliases):
    decomposed = unicodedata.normalize("NFKD", value)
    text = "".join(character for character in decomposed if not unicodedata.combining(character)).lower()
    text = text.replace("&", " and ")
    tokens = re.sub(r"[^\w]+|_", " ", text, flags=re.UNICODE).split()
    return " ".join(aliases.get(token, token) for token in tokens)


def prefix_query(value, aliases):
    tokens = normalize(value, aliases).split()
    # Completed house/street numbers must not match 1012 or 96 in a multi-token address.
    return " AND ".join(
        f'"{token}"' + ("" if token.isdecimal() and len(tokens) > 1 else "*")
        for token in tokens
    )


def load_categories(path):
    mappings = {}
    with path.open(newline="") as source:
        for row in csv.DictReader(source):
            mappings.setdefault((row["class"], row["type"]), []).append(row["phrase"])
    return mappings


def record_fields(tags, aliases, categories):
    matches = [(key, tags[key]) for key in POI_KEYS if tags.get(key) and tags[key] not in ("no", "disused")]
    addressable = bool(tags.get("addr:housenumber") and (tags.get("addr:street") or tags.get("addr:place")))
    if not matches and not addressable:
        return None
    names = {}
    for key, value in tags.items():
        if key in NAME_KEYS or key.startswith("name:"):
            variants = list(dict.fromkeys(part.strip() for part in value.split(";") if part.strip()))
            if variants:
                names[key] = variants
    category_ids = list(dict.fromkeys(category for match in matches for category in categories.get(match, [])))
    osm_class, osm_subtype = matches[0] if matches else ("address", "house")
    house_number = tags.get("addr:housenumber")
    street = tags.get("addr:street") or tags.get("addr:place")
    city = tags.get("addr:city")
    postcode = tags.get("addr:postcode")
    address = " ".join(part for part in (house_number, street, city, postcode) if part)
    name = (names.get("name") or names.get("name:en") or [None])[0]
    if name:
        name_source = "osm"
    elif addressable:
        name, name_source = address, "address"
    elif category_ids:
        name, name_source = osm_subtype.replace("_", " ").capitalize(), "category"
    else:
        # Don't invent a searchable display name for an unspecified/unnamed OSM feature.
        return None
    variants = " ".join(dict.fromkeys(value for values in names.values() for value in values))
    category_tokens = " ".join([*category_ids, *(value.replace("_", " ") for _, value in matches)])
    return {
        "name": name, "name_source": name_source, "names_json": json.dumps(names, ensure_ascii=False, separators=(",", ":")),
        "category": category_ids[0] if category_ids else None, "categories": category_ids,
        "osm_class": osm_class, "osm_subtype": osm_subtype,
        "house_number": house_number, "street": street, "city": city, "postcode": postcode, "address": address,
        "name_tokens": normalize(name, aliases), "variant_tokens": normalize(variants, aliases),
        "address_tokens": normalize(address, aliases), "category_tokens": normalize(category_tokens, aliases),
    }


class SearchBuilder(osmium.SimpleHandler):
    def __init__(self, database, footprint, aliases, categories):
        super().__init__()
        self.database = database
        self.footprint = prep(footprint)
        self.aliases = aliases
        self.categories = categories
        self.factory = osmium.geom.WKBFactory()
        self.rows = []
        self.category_rows = []
        self.spatial_rows = []
        self.counts = Counter()

    def fields(self, tags):
        return record_fields(dict(tags), self.aliases, self.categories)

    def add(self, osm_type, osm_id, fields, point):
        if not self.footprint.covers(point):
            return
        latitude, longitude = round(point.y, 7), round(point.x, 7)
        row_id = osm_id * 4 + OSM_TYPE_CODES[osm_type]
        self.rows.append((
            row_id, osm_type, osm_id, fields["name"], fields["name_source"], fields["names_json"], fields["category"],
            fields["osm_class"], fields["osm_subtype"], latitude, longitude, fields["house_number"], fields["street"],
            fields["city"], fields["postcode"], fields["address"], fields["name_tokens"], fields["variant_tokens"],
            fields["address_tokens"], fields["category_tokens"],
        ))
        self.category_rows.extend((row_id, category) for category in fields["categories"])
        self.spatial_rows.append((row_id, longitude, longitude, latitude, latitude))
        self.counts[osm_type] += 1
        self.counts["addresses"] += bool(fields["house_number"] and fields["street"])
        self.counts["category_pois"] += bool(fields["categories"])
        self.counts["places"] += fields["osm_class"] == "place"
        if len(self.rows) >= 5000:
            self.flush()

    def flush(self):
        self.database.executemany("INSERT INTO places VALUES (" + ",".join("?" for _ in range(20)) + ")", self.rows)
        self.database.executemany("INSERT INTO place_categories VALUES (?,?)", self.category_rows)
        self.database.executemany("INSERT INTO places_rtree VALUES (?,?,?,?,?)", self.spatial_rows)
        self.rows.clear()
        self.category_rows.clear()
        self.spatial_rows.clear()

    def node(self, node):
        fields = self.fields(node.tags)
        if fields:
            if node.location.valid():
                self.add("node", node.id, fields, Point(node.location.lon, node.location.lat))
            else:
                self.counts["skipped_geometry"] += 1

    def way(self, way):
        fields = self.fields(way.tags)
        if not fields:
            return
        if any(not node.location.valid() for node in way.nodes):
            self.counts["skipped_geometry"] += 1
            return
        coordinates = [(node.location.lon, node.location.lat) for node in way.nodes]
        if len(coordinates) < 2:
            self.counts["skipped_geometry"] += 1
            return
        if len(coordinates) >= 4 and coordinates[0] == coordinates[-1] and way.tags.get("area") != "no":
            geometry = Polygon(coordinates)
            if not geometry.is_valid or geometry.is_empty:
                self.counts["skipped_geometry"] += 1
                return
            point = geometry.representative_point()
        else:
            point = LineString(coordinates).interpolate(0.5, normalized=True)
        self.add("way", way.id, fields, point)

    def area(self, area):
        if area.from_way():
            return  # Closed ways were already indexed; relation IDs remain distinct.
        fields = self.fields(area.tags)
        if not fields:
            return
        try:
            geometry = wkb.loads(self.factory.create_multipolygon(area), hex=True)
        except (RuntimeError, osmium.InvalidLocationError):
            self.counts["skipped_geometry"] += 1
            return
        if geometry.is_empty or not geometry.is_valid:
            self.counts["skipped_geometry"] += 1
            return
        self.add("relation", area.orig_id(), fields, geometry.representative_point())


def build(pbf, output, region, schema, aliases, categories, metadata):
    if output.exists():
        raise ValueError(f"Refusing to overwrite search output: {output}")
    database = sqlite3.connect(output)
    try:
        database.executescript("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY;" + schema.read_text())
        database.executemany("INSERT INTO metadata VALUES (?,?)", sorted(metadata.items()))
        builder = SearchBuilder(database, region, aliases, categories)
        node_map = output.with_suffix(".nodes")
        try:
            builder.apply_file(str(pbf), locations=True, idx=f"sparse_file_array,{node_map}")
            builder.flush()
        finally:
            node_map.unlink(missing_ok=True)
        database.execute("INSERT INTO places_fts(places_fts) VALUES ('rebuild')")
        database.execute("INSERT INTO places_fts(places_fts) VALUES ('optimize')")
        database.execute("INSERT INTO places_fts(places_fts, rank) VALUES ('integrity-check', 1)")
        database.commit()
        database.execute("VACUUM")
        if database.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("SQLite integrity check failed")
        total = database.execute("SELECT count(*) FROM places").fetchone()[0]
        if total == 0:
            raise ValueError("Search index is empty")
        return {"total": total, **dict(builder.counts)}
    finally:
        database.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pbf", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--region", type=Path, required=True)
    parser.add_argument("--schema", type=Path, required=True)
    parser.add_argument("--categories", type=Path, required=True)
    parser.add_argument("--normalization", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    args = parser.parse_args()
    feature = json.loads(args.region.read_text())["features"][0]
    data = json.loads(args.data.read_text())
    with args.pbf.open("rb") as source:
        source_hash = hashlib.file_digest(source, "sha256").hexdigest()
    metadata = {
        "schema_version": "1", "minimum_app_contract_version": "1", "region_id": feature["properties"]["id"],
        "data_date": data["dataDate"], "osm_timestamp": data["osmTimestamp"],
        "source": "OpenStreetMap contributors / Geofabrik", "license": "ODbL-1.0",
        "source_pbf_sha256": source_hash,
    }
    counts = build(args.pbf, args.output, shape(feature["geometry"]), args.schema,
                   json.loads(args.normalization.read_text()), load_categories(args.categories), metadata)
    print(json.dumps(counts, sort_keys=True))


if __name__ == "__main__":
    main()
