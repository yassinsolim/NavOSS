# Regional offline bundles

This is the **server/build contract** for offline maps. The pipeline and manifest endpoint are
implemented, and the app consumes them (see [App integration](#app-integration)). Artifacts are
hosted on Cloudflare R2 ([Hosting](#hosting-cloudflare-r2)), but production does not serve the
manifest yet: until it does, the app says “Offline maps are not available yet”.

Reproduce with [`infra/offline/README.md`](../../infra/offline/README.md). Build outputs, raw inputs,
logs and verification screenshots are ignored under `artifacts/offline/`.

## Source and toolchain

- Matching dated **Geofabrik Alberta + British Columbia** public extracts. First ingestion verifies
  provider MD5, extended PBF structure and exact matching OSM replication timestamps; subsequent
  use verifies recorded SHA-256. The merged PBF feeds maps, routing and search.
- Planetiler **0.10.2** (SHA-256-pinned JAR), its bundled **OpenMapTiles 3.16.0** profile, MVT/gzip,
  tile zooms **0–14**. Street zooms overzoom z14 geometry; no public tile endpoint is scraped.
- Offline routing: **Valhalla 3.9.1**, pinned to the engine in **Rallista valhalla-mobile 0.6.4**
  ([embedded commit](https://github.com/valhalla/valhalla/commit/bafb69902220615a48307d5c790fb6c943802ba4)).
  `--routing-engine-version` must match that pin. The image copies the **Compose 3.8.2 config
  generator**, preserving its routing defaults, two-thread build/enhance phases, no elevation or
  traffic extract, existing checksum-verified static speed profile and Canada-admin repair.
  **Online production stays on 3.8.2.** Engine equality is required for the offline wrapper/graph
  pair, not between online and offline services; any route/ETA differences must be disclosed.
- SQLite **3.45.1**, FTS5/RTree; PyOsmium **3.7.0**, Osmium **1.16.0**, PyProj **3.6.1**. The toolbox
  uses digest-pinned multi-architecture images and Ubuntu package snapshot `20261112T230000Z`.
- Natural Earth, coastline/lake geometry, time zones, styles, fonts and sprites have independent
  locked snapshots in `sources.lock.json`. Their date is not the OSM `dataDate`.

The default static Alberta hybrid speed profile SHA-256 is
`0a3f87cfabf76c2428ee851e1d5b61f90ef21d6952e9a4a1d4759887713931d7`. These are static defaults, not
observed live traffic. Missing/non-covered neighbouring-country admin relations are not invented;
the existing repair links the valid AB/BC admin geometry to Canada before graph enhancement.

## Region partitioning and cross-region routing

`infra/offline/regions/definitions.json` is the selection data; `regions.geojson` is the generated,
versioned download coverage. `generate-regions.py` verifies the checked-in Geofabrik boundary
hashes, clips selections to the two extract masks, adds **20,000 metres in EPSG:3347**, and checks
that the non-bulk cores together cover the complete AB+BC source extent. Polygon coordinates are
**[longitude, latitude]**. Geofabrik's masks are buffered **extract extents**, not official province
boundaries, and BC includes offshore clipping extent. Their
[licence](https://github.com/geofabrik/polygons_download.geofabrik.de#license) is an OSM produced work
under ODbL 1.0, requiring OSM attribution.

| ID                            | Download selection                                             |
| ----------------------------- | -------------------------------------------------------------- |
| `calgary`                     | Calgary, Airdrie, Cochrane and Okotoks                         |
| `edmonton`                    | Edmonton and surrounding communities                           |
| `southern-alberta`            | Southern Alberta, including the rural south                    |
| `central-alberta`             | Central Alberta and Red Deer                                   |
| `rockies`                     | Banff–Jasper–Golden corridor, crossing the provincial boundary |
| `northern-alberta`            | Northern Alberta                                               |
| `metro-vancouver`             | Metro Vancouver and Fraser Valley through Hope                 |
| `vancouver-island`            | Vancouver Island and Gulf Islands                              |
| `bc-interior`                 | BC Interior, Okanagan and Kootenays                            |
| `bc-coast`                    | Central/north coast and offshore extract footprint             |
| `northern-bc`                 | Northern BC                                                    |
| `alberta`, `british-columbia` | Optional bulk province bundles                                 |

Calgary's buffered download bounds are
`[-114.94061159290979, 50.46917701586312, -113.10938840709025, 51.68142625124934]`.
The map/search extraction retains complete ways and multipolygon members, then filters the actual
outputs to coverage. Every regional routing extract is selected from **one connected AB+BC graph**,
not built independently. Graph tiles intersecting the polygon are included at each hierarchy level,
so routing coverage has coarser tile margins than the advertised polygon.

**Overlap is not a promise that two distant endpoint packs can route across an undownloaded middle.**
The installer must keep one graph identity active, and route origins/waypoints/destinations plus
returned route segments must remain inside installed coverage. Request the intervening packs or
report unavailable offline coverage; never stitch unrelated route fragments or silently send an
“offline” request to the network.

The standard reader consumes **one tar**, not a set of unrelated tar files. `assemble-routing.py`
unions compatible extracts, checks identical overlapping `.gph` payloads and exact engine/header
versions, and rebuilds the index. It rejects unmarked independent graphs, mixed graph identities,
conflicting duplicate tiles and unsafe tar members. A bulk pack already covering the required
trip can be used directly, avoiding an unnecessary second graph copy.

## Exact manifest contract: version 1

`packages/contracts/src/offline-bundle.ts` exports the strict
`OfflineBundleManifestSchema` / `OfflineBundleManifest` through the contracts index.

`GET /v1/offline/manifest` reads the file named by **`NAVOSS_OFFLINE_MANIFEST_PATH`**. It never
fetches or proxies artifact URLs. Missing/unconfigured/oversized/invalid files return **503**
`application/problem+json`, not an empty success manifest. The read is bounded to 4 MiB and opened
by descriptor; publish updates by atomic rename. A successful response has a weak SHA-256 ETag,
`Cache-Control: public, max-age=300, must-revalidate`, and conditional **304** support. HEAD is
read-only; there is no mutation endpoint. Filesystem paths and source JSON are not logged/exposed.

Top-level fields:

- `schemaVersion: 1`.
- `bundleVersion: YYYY-MM-DD-v1-<12 lowercase hex>`: content-derived release identity.
- `dataDate: YYYY-MM-DD`, `osmTimestamp` (matching OSM snapshot date), `generatedAt` (UTC/ISO time).
- `minimumAppContractVersion`: positive integer; currently **1 for the offline bundle consumer**,
  separate from NavOSS's native guidance contract v8. The app must refuse newer required versions.
- `graph`: `id` (64-hex SHA-256 of the canonical connected graph),
  `routingEngineVersion: "3.9.1"`, `tileFormat: "valhalla-gph"`,
  `tileFormatVersion: "3.9.1"` (upstream GPH header version), and `speedProfileSha256`.
- `regions`: unique region IDs; all use the same data date and connected graph ID.

Each region:

- `id`, `name`, `polygon` (GeoJSON **MultiPolygon**, closed rings),
  `bounds: [west,south,east,north]` containing that polygon, `overlapMeters`, `dataDate`.
- `artifacts.maps`: `url`, integer `byteSize`, lowercase 64-hex `sha256`,
  `format: "pmtiles"`, `formatVersion: 3`, `schema: "openmaptiles"`,
  `schemaVersion: "3.16.0"`, `minZoom: 0`, `maxZoom: 14`.
- `artifacts.routing`: common URL/bytes/hash, `format: "valhalla-tar"`, `formatVersion: 1`
  (**indexed-tar container layout**, not GPH version), `graphId`,
  `routingEngineVersion: "3.9.1"`, `tileFormat: "valhalla-gph"`, `tileFormatVersion: "3.9.1"`.
- `artifacts.search`: common URL/bytes/hash, `format: "sqlite-fts5"`, `formatVersion: 1`,
  `schemaVersion: 1`.
- `artifacts.resources`: common URL/bytes/hash, `format: "tar-gzip"`, `formatVersion: 1`,
  `schemaVersion: 1`, `unpackedByteSize`, `styles: ["liberty","bright","positron","dark"]`.
  Regions share this content-hashed resource artifact; download/unpack it once.
- `attribution`: `{text,url,license}` records. Display OSM and linked OpenMapTiles attribution on
  both maps, and retain all notices in About/offline download details.

Artifact URLs are immutable HTTPS URLs without credentials, fragments or expiring query tokens.
Only **loopback HTTP** is permitted for local verification. Positive byte counts are bounded by
JavaScript's safe integer range. Unknown contract keys, mixed dates/graphs, invalid hashes,
inverted bounds and unsupported formats/engine versions are rejected.

## File layouts the app must implement

### Map and resource binding

`maps.pmtiles` is a seekable **PMTiles v3** archive with **gzip MVT** (`tileType=1`,
`tileCompression=2`, internal gzip metadata). It is not a MapLibre OfflineManager SQLite pack;
`mergeOfflineRegions` cannot install it. MapLibre Native's
[`pmtiles://file://` support](https://maplibre.org/maplibre-native/ios/latest/documentation/maplibre-native-for-ios/pmtiles/)
predates the pinned iOS 6.26.0 engine.

`resources.tar.gz` expands to:

```text
styles/{liberty,bright,positron,dark}.json
glyphs/Noto Sans {Regular,Bold,Italic}/{first}-{last}.pbf
sprites/ofm.{json,png}
sprites/ofm@2x.{json,png}
routing-config.json
search-normalization.json
search-schema.sql
search-query.sql
category-query.sql
sources.lock.json
ATTRIBUTION.txt
licenses/…
```

Styles are MapLibre v8 JSON with portable references:
`pmtiles://maps.pmtiles`, `./glyphs/{fontstack}/{range}.pbf`, `./sprites/ofm`.
Before rendering, bind map and shared-resource roots to absolute encoded file URLs. The reference
`bindOfflineStyle` yields `pmtiles://file:///…/maps.pmtiles`, `file:///…/glyphs/…` and
`file:///…/sprites/ofm`; use URL encoding for spaces in Application Support and font names. Apply
phone/CarPlay custom styling only after binding, without introducing unbundled sources/fonts.

The four styles retain OpenMapTiles roads/labels/buildings/POIs. The optional hosted Natural Earth
shaded raster is deliberately removed; Natural Earth vectors remain. Fonts/sprites are from
licensed source archives, including all 768 BMP glyph files and both sprite scales, not dependent
on `tiles.openfreemap.org`. Attribution hyperlinks are not resource fetches.

### Routing tar

`routing.tar` is **uncompressed**, suitable for mmap/seek on device and Rallista's tar reader.
`index.bin` is the first regular member. Each index entry is 16-byte **little-endian**
`<uint64 offset, uint32 GraphId, uint32 size>`; GraphId is `(tileNumber << 3) | hierarchyLevel`.
Tiles use hierarchy levels 0/1/2 and preserve the connected graph's IDs. `navoss-graph.json` records
`graphId`, engine/GPH versions, data date and speed profile hash. Transfer gzip is not implied.

Use the packaged `routing-config.json`, binding its `mjolnir.tile_extract` to the selected/assembled
absolute tar path and retaining empty traffic/elevation paths. The file retains Compose's routing
defaults while running the pinned **3.9.1** engine. Engine diagnostic logging is disabled for
privacy; errors still propagate through the actor API. Prefer Rallista's `Valhalla(configPath:)`
when loading this config: serializing its `ValhallaConfig` model can discard the top-level logging
section and substitute wrapper defaults. The Expo/SPM packaging and response-to-NavOSS adapter are
explicit app-wave work, not implemented here.

### Search SQLite schema and recipe

Read with `mode=ro&immutable=1`; require `application_id=0x4e564f53` (`NVOS`), `user_version=1`.
Do not open for writes, enable WAL, or store user queries in the database.

- `metadata(key,value)`: schema/consumer version, region ID, OSM date/timestamp, source/license and
  regional PBF SHA-256.
- `places`: integer ID `osm_id*4 + {node:0,way:1,relation:2}`, OSM type/id, display `name`,
  `name_source` (`osm`, `address`, `category`), `names_json` with original name/alt/short/official/
  language variants, category, raw OSM class/subtype, latitude/longitude, house number/street/city/
  postcode/address, normalized FTS fields. Category-generated names remain explicitly labelled.
- `place_categories(category,place_id)`: exact Explore tag mappings reused from
  `infra/compose/nominatim-special-phrases.csv`; a fast-food POI may match restaurant and takeout.
- `places_rtree`: point bounding boxes for nearby category searches.
- `places_fts`: external-content FTS5 over name, variant, address and category tokens,
  `unicode61 remove_diacritics 2`, prefix indexes for 2/3/4-character tokens.

The build indexes public OSM place/amenity/shop/tourism/leisure/healthcare/office/airport/railway/
historic/man-made/named-building features and explicit addresses. It does not interpolate missing
house numbers or infer streets/cities. Closed-way/multipolygon representative points lie inside
areas but are **not verified driveway/entrance arrival points**. Invalid source geometry is omitted
and counted, never replaced with guessed coordinates.

Normalize NFKD/diacritics/lowercase and token separators, then use the packaged normalization table
(the existing Calgary street/direction convention). Quote each FTS token; text tokens get `*`.
Completed numbers in a multi-token address are exact, preventing `101 9 Avenue` from matching
`1012 96 Avenue`. Bind `name_fts_query`, `address_fts_query`, `fts_query`, normalized text, origin,
longitude kilometre scale, and limit as in `search-query.sql` / `query-search.py`.

The query gives complete name/variant matches priority over address matches, with a mixed-field
fallback only when neither exists. BM25 bounds candidate pools; exact names and then proximity rank
those valid matches, with text rank as a tie-breaker. This prevents address-city token collisions
and stops a distant “Calgary Town Hall” from outranking nearby “Calgary Tower” for `Calgar Tow`.
`category-query.sql` uses exact category + RTree radius bounds and nearest point ranking. Distances
are an equirectangular ranking approximation, **not driving distances**.

Across installed regional databases, deduplicate by OSM type/id; overlap is expected. Search text
and origin stay on device. OSM coverage/completeness and naming are not Google/Pelias guarantees.

## Recommended on-device layout and installation

```text
Application Support/NavOSSOffline/
  staging/<bundleVersion>/<regionId>/…
  regions/<regionId>/<bundleVersion>/{maps.pmtiles,routing.tar,search.sqlite}
  shared/<resources-sha256>/{styles,glyphs,sprites,licenses,…}
  routing/<graphId>/<installed-region-set-hash>/routing.tar
  active.json
```

Download with resumable byte ranges, verify exact byte count and SHA-256, safely extract resources
(refuse traversal/symlinks/hardlinks), check schema/engine versions and install by atomic rename.
Keep the last active set until the new maps/search/resources and, if needed, assembled routing tar
are ready. Keep in-use files alive through an active navigation session; swap the native engine at
a safe serialized boundary, not underneath a running route/matcher. Use the same active snapshot
on phone and CarPlay.

Budget from manifest bytes, not province guesses: new download bytes (unique resource hash once)

- unpacked resources + any new assembled tar (bounded by sum of input routing tars) + retained old
  active set + filesystem overhead. A single suitable tar can be read directly. Exclude reproducible
  maps/graphs/search from iCloud backups. Offline routes do not carry live community/paid-provider
  traffic or current closure updates; never upload a trip or search merely because a pack is missing.

## Hosting: Cloudflare R2

Artifacts are hosted in the R2 bucket `navoss-offline` behind `https://navoss-offline.yassin.app`
(provisioned 2026-11-15 on the owner's personal account; exact inventory, publish, replace and
emergency-stop commands in [`infra/offline/README.md`](../../infra/offline/README.md#hosting)).
Release keys are immutable (`<bundleVersion>/…`), carry `Content-Length`, `ETag`,
`Last-Modified`, `Accept-Ranges: bytes`, an exact `Content-Type`, no content encoding and
`Cache-Control: public, max-age=31536000, immutable`. The small mutable manifest stays behind the
existing API (`NAVOSS_OFFLINE_MANIFEST_PATH`). The owner's requirement is that hosting costs
nothing; R2 has **no spending cap**, so the design makes a charge practically impossible and
small if it ever happened.

### Cost model

Sources, checked 2026-11-15: [R2 pricing](https://developers.cloudflare.com/r2/pricing/) (updated
October 30, 2026), [R2 limits](https://developers.cloudflare.com/r2/platform/limits/),
[default cache behaviour](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/),
[range requests](https://developers.cloudflare.com/cache/reference/range-requests/),
[rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/),
[available notifications](https://developers.cloudflare.com/notifications/notification-available/)
and [public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/).

| Item             | Free each month                      | Beyond that         |
| ---------------- | ------------------------------------ | ------------------- |
| Standard storage | 10 GB-month (average of daily peaks) | $0.015 per GB-month |
| Class A (writes) | 1,000,000                            | $4.50 per million   |
| Class B (reads)  | 10,000,000                           | $0.36 per million   |
| Egress           | always free                          | always free         |

Usage is rounded **up** to the next billing unit (1,000,001 operations bill as two million).

- **Uploads** are Class A: one `PutObject` per file, or `CreateMultipartUpload` +
  one `UploadPart` per part + `CompleteMultipartUpload`. Listing objects (`ListObjects`, including
  browsing the bucket in the dashboard) is also Class A. Deletes and multipart aborts are free.
  Publishing this release cost **9 Class A operations** (eight wrangler puts and one signed S3
  put); creating the bucket and its lifecycle rules cost three more. The public hostname has no
  write or list path, so nobody else can cause Class A.
- **Downloads** are Class B, one `GetObject` per request that reaches R2, ranged or not; a resume is
  a new request; `HeadObject` also counts. A `404` for a missing key is billed too (the pricing
  FAQ bills requests that pass authorization). The app makes one request per artifact and one
  more per resume, and never retries on its own: a region is 4 requests (3 when the shared
  resources are already installed) plus one per resume.
- **The CDN cache absorbs reads**, and a cache hit never reaches R2. On the free plan Cloudflare
  caches by file extension only: `.tar` and `.gz` are cached by default, `.pmtiles` and
  `.sqlite` are not, so a **cache rule** for the hostname (dashboard step below) is needed for the
  maps and search files. Objects over **512 MB** are never cached on Free/Pro/Business; the
  all-Alberta `maps.pmtiles` is 524,743,452 bytes (500.4 MiB), so whether it caches depends on
  which unit the limit means; it is counted here as always reaching R2. Each Cloudflare data
  centre fills its own cache, so the first request per object per location is a miss.
- **Storage** is one release, 1,452,230,980 bytes (14.5% of the free 10 GB). During a release swap
  both releases exist for the seven-day grace period, about 2.9 GB at peak and about 1.8 GB-month
  for that month.

**Worst realistic beta month.** 200 phones each install all of Alberta and Calgary, and every
install needs ten resumes on a bad connection: 200 × (7 artifacts + 20 resumes) = 5,400 Class B
operations even if no request were ever answered from cache, 0.054% of the free allowance. Ten
times that, or a year of monthly releases (about 120 Class A operations), stays below 1%.
Certificate-transparency scanners began probing the new hostname within minutes (61 `404`
requests in its first 25 minutes); at that rate they add about 105,000 Class B a month, about 1%.

**Abuse.** One client looping requests for an uncached object (for example a one-byte range of
the Alberta maps file) costs one Class B operation per request. At 20 requests a second, all
month, that is 51.8 million: about **$15** beyond the free 10 million. The rate-limiting rule
below (10 requests per 10 seconds per IP, then a 10-second block) holds one address to about one
request every two seconds, roughly 1.3 million a month, so one looping client stays inside the
free tier; it takes about eight addresses looping without pause for a month to pass it, and each
further million costs $0.36. A botnet of 1,000 addresses doing the same for a whole month would
cost on the order of **$460**; the daily usage check exists to catch that in its first day.

**What cannot be capped.** R2 has no spending limit or automatic stop. Free-plan rate limiting
counts per IP and per Cloudflare data centre, applies only after a few seconds, cannot match the
hostname (Path is the only free-plan field), and cannot stop many addresses. Usage-based billing
notifications are for Pro plans and pay-as-you-go accounts, so a Free zone may not offer them.
Distributed read traffic that misses the cache is therefore the remaining exposure. It is bounded
only by detection (`r2-usage.mts`, run daily) and the manual emergency stop: detaching the custom
domain, after which no request reaches R2.

### Guardrails in place

- Private by default: the `r2.dev` URL is disabled and the custom domain is the only public path.
  It serves objects by exact key and cannot list or write.
- One release in the bucket. A new release replaces the old after a seven-day grace period, so
  storage stays below 3 GB (30% of the free 10 GB), and the usage check fails above that.
- Lifecycle rule `abort-incomplete-multipart-1d`: an abandoned multipart upload is never stored
  for more than a day.
- Immutable cache headers, exact content types and identity encoding on every object, so the
  CDN can serve ranges and resumes from cache.
- `infra/offline/r2-usage.mts` reads storage and month-to-date operations from Cloudflare's
  analytics (it performs no R2 operation) and exits non-zero above 3 GB, 40 objects, 100,000
  Class A or 1,000,000 Class B (10% of the free operations).
- `infra/offline/verify-hosting.mts` and `infra/compose/check-stack.sh` check every manifest URL
  before and after the manifest is published.

### Dashboard steps for the account owner

The `wrangler login` token has no zone-rules or notifications permission (the rulesets and
alerting APIs answer `403`), so these were not applied and the existing rate-limiting slot could
not be inspected. In the Cloudflare dashboard, zone `yassin.app`:

1. **Cache rule** (Caching → Cache Rules → Create rule). Name `navoss-offline artifacts`;
   custom filter expression `(http.host eq "navoss-offline.yassin.app")`; cache eligibility
   **Eligible for cache**; leave Edge TTL on "use cache-control header if present" and Browser
   TTL on "respect origin". Deploy. This makes `.pmtiles` and `.sqlite` cacheable; nothing else in
   the zone matches.
2. **Rate-limiting rule** (Security → Security rules → Create rule → Rate limiting rule). The free
   plan has one rate-limiting rule per zone: if one already exists, **do not replace it**; report
   it instead. Otherwise: name `navoss-offline downloads`; expression
   `(http.request.uri.path contains "-v1-")` (every release key contains `-v1-`, the API's paths do
   not; the free plan cannot match the hostname); characteristic IP; **10 requests per 10
   seconds**; action **Block** for **10 seconds**. The app makes at most one request at a time.
3. **Usage notifications** (Notifications → Add → Usage Based Billing). If R2 is offered, add
   alerts at 1,000,000 Class B operations, 100,000 Class A operations and 3 GB of storage. If the
   notification type is not offered on this account, schedule `r2-usage.mts` daily instead.

Verify steps 1 and 2 with `verify-hosting.mts` run twice (the second run should report `HIT` for
every object except perhaps the Alberta maps file), and by checking that the 11th request in ten
seconds from one address answers `429`.

Provider request metadata reveals the IP address and the downloaded region (from the key), not
search text or route positions; it is disclosed in the privacy policy. No Logpush or log export
is configured.

### Hosted verification record (2026-11-15)

- Upload: every object was read back through `https://navoss-offline.yassin.app` and matched its
  local size, MD5 `ETag` and SHA-256 (the all-Alberta maps file was also checked by R2 itself
  against `x-amz-checksum-sha256` on upload). `verify-hosting.mts` passed for all seven manifest
  URLs: `200`, exact length, `Accept-Ranges: bytes`, immutable caching, identity encoding and a
  correct `206` tail range.
- Manifest: regenerated with `build.sh --base-url https://navoss-offline.yassin.app` from the
  cached build; same bundle version `2026-11-11-v1-798f5c442644`; identical to the loopback
  manifest except the artifact URLs and `generatedAt`.
- End to end without production: the API ran locally with `NAVOSS_OFFLINE_MANIFEST_PATH` set to
  that manifest, and a Debug build of `main` on an iOS 26.5 simulator listed All Alberta (1.2 GB)
  and Calgary (346 MB) and downloaded Calgary from the real hostname. The region was installed,
  deleted and downloaded again; the second download was paused 84,594,215 bytes into
  `routing.tar`, resumed with a byte range, and installed. With the API stopped, searching
  "Calgary Tower" returned four "Offline results · OpenStreetMap data from 2026-11-11", and a route
  to it was planned on the device ("Offline route · No traffic or closures", 10.0 km). Only the
  `.pmtiles` and `.sqlite` downloads reached R2 (**4 Class B operations** for both installs); the
  `.tar` and `.gz` requests, including the ranged resume, were answered from Cloudflare's cache.

### Alternatives considered: existing Cloudflare Tunnel + Caddy

Technically Caddy can mount `releases/` read-only and serve ranged static files without loading
multi-GB responses into the API. A separate static handle should **not apply `encode zstd gzip`**
to PMTiles, tar, SQLite or tar.gz payloads: checksums/ranges refer to the stored bytes. Serve
immutable artifacts with `Cache-Control: public, max-age=31536000, immutable`; use the API's short
manifest cache policy. Keep directory browsing and access logging off. A representative handle:

```caddyfile
handle_path /offline/* {
  root * /srv/navoss/offline/releases
  header Cache-Control "public, max-age=31536000, immutable"
  file_server
}
```

Put encoding only in the API handle, and mount the artifact directory explicitly; this is a
hosting example, **not an applied Compose/Caddy change**.

However, the [CDN service-specific terms](https://www.cloudflare.com/service-specific-terms-application-services/)
(September 28, 2026) require appropriate Paid Services/Enterprise arrangements for large-file or
disproportionate non-HTML delivery and permit limiting access otherwise. A free Tunnel/CDN is not
an unlimited navigation-pack bandwidth entitlement. [Cache limits](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/)
are **512 MB per object** on Free/Pro/Business, versus 5 GB default on Enterprise; multi-GB objects
will not fit that cache. Upload limits are a separate constraint, not download-size permission.
Uncached transfers consume the origin/ISP's uplink for every download, contend with API traffic,
and inherit the VM/Tunnel availability; rollback/retained versions consume local SSD space.

Direct unproxied Caddy avoids the CDN large-file terms but exposes an internet origin and its
bandwidth/security burden, requiring a separate deployment/security decision. S3-compatible
providers are also possible but usually meter internet egress; compare storage + request + egress
fees, distribution terms and retention, not only advertised storage prices. R2 is the current
recommendation because these open-data binary downloads fit its object-storage purpose and free
egress model. No production bandwidth/hosting behaviour is claimed as verified.

## Measurement and verification record

Source snapshot: **2026-11-11T21:22:47Z**. Workstation: OrbStack Linux **aarch64**, 10 CPUs,
12,599,537,664 Docker RAM bytes; host macOS arm64. The following is the observed **3.8.2 baseline**
build retained for the requested engine comparison. These are actual files/timers, not estimates.
The final mobile-matched 3.9.1 measurement and verification record follows.

| Baseline artifact                        | Calgary bytes | All Alberta bytes |
| ---------------------------------------- | ------------: | ----------------: |
| OpenMapTiles PMTiles                     |    38,084,635 |       524,743,452 |
| Indexed routing tar                      |    99,164,160 |       287,528,960 |
| Search SQLite                            |   147,111,936 |       293,961,728 |
| Shared resources (download once)         |    61,597,240 |  same shared file |
| Shared resources, unpacked logical bytes |   105,000,756 | same shared files |

Baseline shared connected graph: **588,922,880 bytes**, **3,348 graph tiles**. Calgary extract:
**53 graph tiles**; Alberta extract: **1,466**. Search: Calgary **376,920 rows**, including **354,632
addresses** and **21,353 category POIs**; Alberta **730,323 rows**, **664,575 addresses**, **52,707
category POIs** (one invalid geometry omitted and counted).

| Baseline stage                       | Measured seconds |
| ------------------------------------ | ---------------: |
| Shared admins/time zones             |           36.516 |
| Canada-parent repair                 |            0.718 |
| Shared graph build                   |          111.444 |
| Canonical graph tar                  |            0.934 |
| Resource copy + gzip pack            |            4.885 |
| Calgary PBF extraction               |           46.816 |
| Calgary maps                         |           37.057 |
| Calgary routing select + pack        |            1.178 |
| Calgary search                       |           88.779 |
| Alberta PBF extraction               |           57.876 |
| Alberta maps                         |           89.406 |
| Alberta routing select + pack        |            1.946 |
| Alberta search                       |          446.893 |
| Full command, cached input downloads |          933.659 |

Initial cold source fetches were separately measured: AB+BC PBF downloads/checksums **224.84 s**;
Planetiler auxiliary downloads **70.25 s**; first toolbox Docker build **49.34 s**. Later runs reuse
validated inputs. The source PBFs were **352,288,219 bytes AB** and **1,249,393,767 bytes BC**.

The baseline command completed both Calgary and all Alberta. The production VM, on-device iOS
installation/SPM linkage, physical CarPlay/offline driving, amd64 Ubuntu VM, full BC regional builds,
CDN/object hosting, interrupted phone downloads and low-storage behaviour are not verified by this
server/build slice. Licensing/attribution inventory is in [`data-sources.md`](../data-sources.md).

### Final mobile-matched 3.9.1 build

The one-command build completed **Calgary and all Alberta end to end** with the pinned 3.9.1 engine,
the 3.8.2 Compose config generator, the same OSM input snapshot and the same static speed/admin
preparation. Release: **`2026-11-11-v1-798f5c442644`**. Connected graph SHA-256:
`42a8d4bf662b153182698743896f26075465fe14a1dce74d1e5d2e64c24921ea`.
The final search recipe was republished after verifying that proximity correctly ranks the nearby
Calgary Tower ahead of a distant Calgary Town Hall for a partial-name query.

| Final artifact                                                             | Calgary bytes | All Alberta bytes |
| -------------------------------------------------------------------------- | ------------: | ----------------: |
| OpenMapTiles PMTiles                                                       |    38,084,635 |       524,743,452 |
| 3.9.1 indexed routing tar                                                  |    99,164,160 |       287,528,960 |
| SQLite FTS5/RTree                                                          |   147,111,936 |       293,961,728 |
| Shared resource download (once)                                            |    61,597,437 |         same file |
| Shared resources, unpacked logical bytes                                   |   105,001,070 |        same files |
| Download total including shared resources                                  |   345,958,168 |     1,167,831,577 |
| Installed file-content total, excluding tar retained/merge/update overhead |   389,361,801 |     1,211,235,210 |

Map and search artifact SHA-256 values were identical to the same-input 3.8.2 baseline; routing
payload hashes changed, as expected for the 3.9.1-built graph. The connected tar remained
**588,922,880 bytes / 3,348 tiles**. Regional routing selections remained **53 Calgary / 1,466
Alberta tiles**; search counts remained **376,920 / 730,323 rows**. These totals include actual OSM
addresses and named POIs/buildings, not synthetic/civic fallback records.

| Final fresh-build stage                                  | Measured seconds |
| -------------------------------------------------------- | ---------------: |
| Admins/time zones                                        |           29.517 |
| Canada-parent repair                                     |            0.913 |
| AB+BC 3.9.1 graph build                                  |          109.547 |
| Canonical connected tar                                  |            0.938 |
| Resource copy + gzip pack                                |            4.980 |
| Calgary PBF extraction                                   |           37.488 |
| Calgary maps                                             |           38.165 |
| Calgary routing select + pack                            |            1.027 |
| Calgary search                                           |           87.357 |
| Alberta PBF extraction                                   |           57.483 |
| Alberta maps                                             |          117.597 |
| Alberta routing select + pack                            |            1.965 |
| Alberta search                                           |          466.481 |
| Full fresh command with cached source downloads          |          966.243 |
| Cached-artifact publication of the improved query recipe |           13.146 |

The snapshot-pinned toolbox was separately built successfully on Linux aarch64; its APT snapshot
fetched the declared package versions, with **11 Python behavioural tests passing**. `du -sk`
measured **15,467,992 KiB** of retained local offline inputs/caches/evidence after the builds;
this includes multiple comparison builds, and is **not** a peak-working-disk estimate. The host
still reported **308 GiB free** at that measurement.

### Empirical routing pair, compatibility and deltas

`verify/routing.mts` used only the existing repository's public Calgary benchmark cases. It ran
three isolated local engines: 3.9.1 with the **3.9.1-built Calgary extract**, online-like 3.8.2 with
the **3.8.2-built full graph**, and 3.9.1 reading the **3.8.2-built full graph**. Runtime config
retained the same static routing settings. All five 3.9.1 routes and route-derived `map_snap`
traces succeeded; all five 3.9.1-on-3.8.2 route/trace pairs also succeeded.

| Public case                    |      3.8.2 km / s | 3.9.1 offline km / s | Distance delta m | ETA delta s |
| ------------------------------ | ----------------: | -------------------: | ---------------: | ----------: |
| Downtown → airport             | 19.124 / 1215.905 |    19.124 / 1215.905 |                0 |           0 |
| Downtown → university          |  8.432 / 1091.312 |     8.432 / 1091.312 |                0 |           0 |
| Downtown → Chinook             |  6.370 / 1037.180 |     6.370 / 1037.180 |                0 |           0 |
| Downtown → East Hills          | 18.930 / 1521.757 |    18.930 / 1521.757 |                0 |           0 |
| Downtown → Canada Olympic Park | 14.729 / 1364.080 |    14.729 / 1364.080 |                0 |           0 |

Observed deltas were **0 m / 0 s for these five cases**, not a guarantee that all online/offline
routes match. Trace durations differed from route durations by at most **0.088 s** due to matching
the route-derived shape. The compatibility result supports investigating a shared older graph
for both engines later; the current app contract still requires the pinned **3.9.1 pair** and does
not silently accept older bundles. Production was **not contacted**; its older data/live traffic
conditions can produce different routes/ETAs. No real GPS traces or iOS wrapper execution were
used. The saved comparison report contains only case IDs, statuses and distance/time summaries,
not coordinates or route geometry.

### Offline visual, search and manifest verification

MapLibre GL JS **6.18.0** + PMTiles JS **4.5.0** rendered the real Calgary archive and offline
resource files through the local range server. External requests were denied by both CSP and the
test browser's loopback-only allowlist. All eight PNGs were **captured and visually inspected**:

| Style    | City z11 rendered features | Street z17 rendered features | PNG names                                  |
| -------- | -------------------------: | ---------------------------: | ------------------------------------------ |
| Liberty  |                      1,275 |                          527 | `liberty-city.png`, `liberty-street.png`   |
| Bright   |                      1,445 |                          526 | `bright-city.png`, `bright-street.png`     |
| Positron |                        803 |                          266 | `positron-city.png`, `positron-street.png` |
| Dark     |                        784 |                          301 | `dark-city.png`, `dark-street.png`         |

Every view reported ready with **zero MapLibre render errors**. The resource-timing ledger recorded
**66 local resources / zero external URLs**. Streets, place labels, sprites and (Liberty) 3D building
extrusions were visible; Positron intentionally omits POIs. The raw upstream Dark style has very
low-contrast dark paint/text (confirmed in the pinned source), not missing offline data; the app
wave should apply NavOSS's existing readability customization after local URL binding.

Real FTS/category queries against the final Calgary database returned:

- `101 9 Avenue SE` → **Calgary Tower**, explicit OSM address `101 9 Avenue SE Calgary T2P 1J9`.
- `Calgar Tow` near the tower → **Calgary Tower first**, followed by the Calgary Place apartment
  towers, rather than a distant town hall or a tower matching only an address-city token.
- exact category `cafe`, 20 km radius → **Starbucks**, **Bono Coffee Roasters**, **Waves Coffee House**
  as the first three nearest source-tagged cafes; category filtering is not a fuzzy name guess.

The actual generated manifest was served by `buildApp` at the new endpoint: **200**, correct
3.9.1 graph/region metadata, then **304 with an empty body** for its ETag. Independent SHA-256
verification passed for all seven final published files (three per region plus shared resources).
All repository check/lint/test/build gates passed, alongside shellcheck and Python behavioural
tests. The screenshot/evidence files remain under ignored `artifacts/offline/evidence/`; they are
not app screenshots or a physical offline-driving claim.

## App integration

- **Engine.** `modules/navoss-navigation/ios/valhalla_mobile.rb` fetches Rallista valhalla-mobile
  0.6.4's prebuilt `valhalla-wrapper.xcframework` (SHA-256 pinned to upstream's Package.swift
  checksum) and its `tzdata.tar` while CocoaPods evaluates `NavOSSNavigation.podspec`, so
  `expo prebuild --clean`, EAS and CI get it without a committed binary. A small Objective-C++
  bridge (`Offline/NavOSSValhallaActor.mm`) calls the wrapper's `route` entry point directly; the
  wrapper's Swift packages are not linked. Requests always ask for native Valhalla **JSON**
  (`"format": "json"`); `navOSSOfflineTrips` adapts it, keeping lanes, exit numbers and sign
  branch/toward elements separate. Offline trips carry no speed limits (native JSON route output
  has no per-edge limits) and no traffic.
- **Install.** `NavOSSOfflineStore` implements the layout above: one region pipeline at a time,
  resumable byte-range downloads into `staging/`, exact size + SHA-256 checks, safe resource
  extraction, PMTiles/tar/SQLite sanity checks, rename into `regions/<id>/<bundleVersion>/`,
  atomic `active.json`. Superseded versions are deleted on the next launch. The tree is excluded
  from iCloud backup. Downloads pause (and resume later) when iOS ends background time.
- **Use.** Offline routes and search read exactly one installed region: the widest covering every
  stop (or the search origin). Routes leaving that region's polygon are rejected. Online is
  always tried first while the device has a network; native reroutes and CarPlay fall back
  through `NavOSSNavigationAPIClient.offlineFallback`, the phone through
  `src/features/offline/offline-maps.ts`. Offline routes are labelled “Offline route · No traffic
  or closures”, offline search “Offline results · OpenStreetMap data from <date>”. Maps switch to
  the bound local style (same four slugs, same customisation) with no network, with “Prefer
  offline maps” inside a region, or when the hosted style fails; phone and CarPlay attribution
  say “Offline map · © OpenMapTiles · © OpenStreetMap”.
- **CarPlay harness.** Scenario `offline-preview` (`NAVOSS_CARPLAY_VISUAL_SCENARIO`) draws the
  installed region's offline style; it needs a region installed on the simulator, so it is not in
  the default `validate:navigation:ios` list.
