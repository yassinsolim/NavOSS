PRAGMA application_id = 0x4e564f53; -- ASCII NVOS
PRAGMA user_version = 1;
PRAGMA page_size = 4096;

CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE places (
  id INTEGER PRIMARY KEY,
  osm_type TEXT NOT NULL CHECK (osm_type IN ('node','way','relation')),
  osm_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  name_source TEXT NOT NULL CHECK (name_source IN ('osm','address','category')),
  names_json TEXT NOT NULL,
  category TEXT,
  osm_class TEXT NOT NULL,
  osm_subtype TEXT NOT NULL,
  latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  house_number TEXT,
  street TEXT,
  city TEXT,
  postcode TEXT,
  address TEXT NOT NULL,
  name_tokens TEXT NOT NULL,
  variant_tokens TEXT NOT NULL,
  address_tokens TEXT NOT NULL,
  category_tokens TEXT NOT NULL
);
CREATE TABLE place_categories (
  place_id INTEGER NOT NULL REFERENCES places(id),
  category TEXT NOT NULL,
  PRIMARY KEY (category, place_id)
) WITHOUT ROWID;
CREATE VIRTUAL TABLE places_rtree USING rtree(id, min_lon, max_lon, min_lat, max_lat);
CREATE VIRTUAL TABLE places_fts USING fts5(
  name_tokens, variant_tokens, address_tokens, category_tokens,
  content='places', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2', prefix='2 3 4'
);
