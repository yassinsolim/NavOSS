#!/usr/bin/env python3
"""Execute the documented read-only FTS5/category recipe, without logging query inputs."""
import argparse
import importlib.util
import json
import math
import sqlite3
from pathlib import Path

_spec = importlib.util.spec_from_file_location("offline_search", Path(__file__).with_name("build-search.py"))
_search = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_search)


def query(database, text, category, latitude, longitude, radius_km, limit, aliases, scripts):
    if not 1 <= limit <= 100 or not 0 < radius_km <= 200:
        raise ValueError("Query limit/radius out of range")
    longitude_km = 111.32 * math.cos(math.radians(latitude))
    parameters = {
        "fts_query": _search.prefix_query(text, aliases), "normalized": _search.normalize(text, aliases),
        "latitude": latitude, "longitude": longitude, "longitude_km": longitude_km, "limit": limit,
        "category": category,
        "west": longitude - radius_km / longitude_km,
        "east": longitude + radius_km / longitude_km,
        "south": latitude - radius_km / 111.32, "north": latitude + radius_km / 111.32,
    }
    parameters["name_fts_query"] = "{name_tokens variant_tokens} : (" + parameters["fts_query"] + ")"
    parameters["address_fts_query"] = "address_tokens : (" + parameters["fts_query"] + ")"
    if not category and not parameters["fts_query"]:
        return []
    filename = "category-query.sql" if category else "search-query.sql"
    connection = sqlite3.connect(f"{database.resolve().as_uri()}?mode=ro&immutable=1", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        if connection.execute("PRAGMA user_version").fetchone()[0] != 1:
            raise ValueError("Unsupported offline search schema")
        return [dict(row) for row in connection.execute((scripts / filename).read_text(), parameters)]
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("database", type=Path)
    parser.add_argument("--query", default="")
    parser.add_argument("--category")
    parser.add_argument("--latitude", type=float, required=True)
    parser.add_argument("--longitude", type=float, required=True)
    parser.add_argument("--radius-km", type=float, default=20)
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--normalization", type=Path, required=True)
    args = parser.parse_args()
    if not -90 < args.latitude < 90 or not -180 <= args.longitude <= 180:
        raise ValueError("Invalid origin")
    rows = query(args.database, args.query, args.category, args.latitude, args.longitude,
                 args.radius_km, args.limit, json.loads(args.normalization.read_text()), Path(__file__).parent)
    print(json.dumps(rows, ensure_ascii=False))


if __name__ == "__main__":
    main()
