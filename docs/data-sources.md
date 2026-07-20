# Official Data Sources

## Calgary Place and Address Search

NavOSS combines a local copy of two City of Calgary datasets with its self-hosted
OpenStreetMap/Nominatim index. The local copy is refreshed every 24 hours and swapped
atomically after a complete import, so user searches never query Calgary Open Data directly.
Before a swap, the indexer verifies filtered source counts, rejects implausible or greater-than-10%
drops, confirms source timestamps and counts did not change during pagination, and checks the
staging-table totals. The previous accepted index remains available for immediate rollback.

### Business licences

- Dataset: [Calgary Business Licenses](https://data.calgary.ca/d/vdjc-pybd)
- Socrata dataset ID: `vdjc-pybd`
- Supplier: The City of Calgary
- Imported records: licensed businesses with a public location and `HOMEOCCIND = N`
- Search fields: trade name, public business address, community, and licence types
- Terms: [Calgary Open Data Terms of Use](https://data.calgary.ca/d/Open-Data-Terms/u45n-7awa)

Home-occupation records are deliberately excluded even when present in the public source.
The dataset does not cover every Calgary organization: some activities do not require a
municipal licence, names and locations can change between updates, and informal place names
may exist only in OpenStreetMap or neither source.

### Parcel addresses

- Dataset: [Parcel Address and lat/long](https://data.calgary.ca/d/s8b3-j88p)
- Socrata dataset ID: `s8b3-j88p`
- Supplier: The City of Calgary
- Search fields: house number and suffix, street name, street type, quadrant, and coordinates
- Terms: [Calgary Open Data Terms of Use](https://data.calgary.ca/d/Open-Data-Terms/u45n-7awa)

Common long and abbreviated street forms are normalized consistently, such as `Trail`/`TR`
and `Southeast`/`SE`. Rows without a street identity or valid coordinates are excluded rather
than guessed. Parcel coordinates identify a civic parcel and are not guaranteed to represent
an entrance, driveway, unit, or ideal vehicle arrival point.

The production index stores public source records only. It does not store search text, search
origins, selected results, routes, or user identities. Search results are ranked by exact text,
prefix and word-prefix matches, typo similarity, and then optional proximity.

## Calgary Intersection Safety Cameras

NavOSS uses The City of Calgary's official **Intersection Safety Cameras** dataset for fixed enforcement-camera markers and alerts.

- Dataset: [Intersection Safety Cameras](https://data.calgary.ca/Health-and-Safety/Intersection-Safety-Cameras/dv2f-necx)
- Socrata dataset ID: `dv2f-necx`
- Supplier: Calgary Police Department through Calgary Open Data
- Update frequency: monthly
- Geometry: WGS84 points
- Terms: [Calgary Open Data Terms of Use](https://data.calgary.ca/d/Open-Data-Terms/u45n-7awa)

The official description states that each Intersection Safety Camera detects vehicle speed and can detect failure to stop for a red light. NavOSS therefore labels every record as a combined `red-light` and `speed-on-green` camera. It does not infer separate enforcement types.

As of July 1, 2026, the source contains 57 camera records. Five records omit ward metadata; NavOSS retains those cameras without fabricating a ward. A record must still have valid coordinates, community, quadrant, and a recognizable enforced direction. Unknown direction data fails closed and the API returns a temporary-unavailable response rather than issuing potentially incorrect alerts.

The NavOSS API fetches and validates the dataset server-side and caches successful responses for six hours. The mobile client does not send user location to Calgary Open Data. The app displays all validated official locations on the map and includes visible City of Calgary attribution.

During active guidance, an alert is eligible only when the camera:

- is no more than 45 meters from the selected route geometry;
- is ahead of current native route progress and no more than 450 meters away;
- has an enforced direction within 60 degrees of route travel direction; and
- has not already been announced during the current trip.

Eligible cameras produce a visible alert and the native iOS phrase, “Red light and speed camera ahead.” These alerts are informational. Drivers remain responsible for obeying posted signs, signals, and speed limits, and the official dataset may change between monthly updates.
