-- A category is a checked OSM tag mapping, not a fuzzy match on a business name.
-- The caller supplies a bounding box for its chosen radius and longitude_km as in search-query.sql.
SELECT p.id, p.osm_type, p.osm_id, p.name, p.name_source, p.names_json, p.category,
       p.osm_class, p.osm_subtype, p.latitude, p.longitude, p.address,
       ((p.latitude - :latitude) * 111.32) * ((p.latitude - :latitude) * 111.32)
         + ((p.longitude - :longitude) * :longitude_km)
         * ((p.longitude - :longitude) * :longitude_km) AS distance2_km
FROM places_rtree r
JOIN places p ON p.id = r.id
JOIN place_categories c ON c.place_id = p.id AND c.category = :category
WHERE r.max_lon >= :west AND r.min_lon <= :east
  AND r.max_lat >= :south AND r.min_lat <= :north
ORDER BY distance2_km, p.id
LIMIT :limit;
