-- Bind quoted normalized tokens; text tokens are prefixes, completed address numbers are exact.
-- name_fts_query: {name_tokens variant_tokens} : (tokens); address_fts_query: address_tokens : (tokens).
-- longitude_km is 111.32 * cos(origin latitude in radians), computed by the caller.
-- Distances are an equirectangular ranking approximation, NOT driving distances.
WITH name_matches AS MATERIALIZED (
  SELECT places_fts.rowid, bm25(places_fts, 8.0, 3.0, 5.0, 1.0) AS text_rank, 0 AS tier
  FROM places_fts JOIN places p ON p.id = places_fts.rowid
  WHERE places_fts MATCH :name_fts_query AND p.name_source <> 'address'
  ORDER BY (p.name_tokens = :normalized) DESC, text_rank
  LIMIT 400
), address_matches AS MATERIALIZED (
  SELECT rowid, bm25(places_fts, 8.0, 3.0, 5.0, 1.0) AS text_rank, 1 AS tier
  FROM places_fts
  WHERE places_fts MATCH :address_fts_query
  ORDER BY text_rank
  LIMIT 400
), mixed_matches AS MATERIALIZED (
  SELECT rowid, bm25(places_fts, 8.0, 3.0, 5.0, 1.0) AS text_rank, 2 AS tier
  FROM places_fts
  WHERE places_fts MATCH :fts_query
    AND NOT EXISTS (SELECT 1 FROM name_matches)
    AND NOT EXISTS (SELECT 1 FROM address_matches)
  ORDER BY text_rank
  LIMIT 400
), matches AS (
  SELECT * FROM name_matches UNION ALL SELECT * FROM address_matches UNION ALL SELECT * FROM mixed_matches
), candidates AS (
  SELECT p.*, MIN(matches.tier) AS tier, MIN(matches.text_rank) AS text_rank,
    ((p.latitude - :latitude) * 111.32) * ((p.latitude - :latitude) * 111.32)
      + ((p.longitude - :longitude) * :longitude_km)
      * ((p.longitude - :longitude) * :longitude_km) AS distance2_km
  FROM matches JOIN places p ON p.id = matches.rowid
  GROUP BY p.id
)
SELECT id, osm_type, osm_id, name, name_source, names_json, category,
       osm_class, osm_subtype, latitude, longitude, address, distance2_km
FROM candidates
ORDER BY tier, (name_tokens = :normalized OR address_tokens = :normalized) DESC,
         (osm_class = 'place' AND name_tokens = :normalized) DESC,
         distance2_km, text_rank, id
LIMIT :limit;
