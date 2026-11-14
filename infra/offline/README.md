# Regional offline bundle builder

Build tools run in Docker on macOS/OrbStack or Linux. Nothing here deploys to the production VM,
changes the online Valhalla service, or downloads tiles from OpenFreeMap's public tile endpoint.
The current phone/CarPlay app does **not** install these bundles yet.

## Prerequisites

- Repository toolchain: Node **24.18.0**, pnpm **11.13.1**; run
  `corepack pnpm install --frozen-lockfile` once after cloning.
- Docker/OrbStack. The measured workstation has 10 Docker CPUs and 12,599,537,664 bytes of Docker RAM.
  Builds are sequential: maps use 6 CPUs / 6 GiB RAM / 4 GiB Java heap; graph/search use 2 CPUs / 3 GiB.
- SSD space for inputs, graph, temporary node/feature stores, and published artifacts. See the
  [measured sizes and build times](../../docs/architecture/offline.md), not province-size estimates.

## One command

From the repository root, with the pinned Node in `PATH`:

```sh
./infra/offline/build.sh --date 261111 --regions calgary --base-url http://127.0.0.1:3021
```

`--date` is an explicit **YYMMDD Geofabrik snapshot**, not `latest`. Alberta and BC are always
checksum-verified, have matching OSM timestamps, and are merged once. Both provinces feed one
connected routing graph even when only Calgary is requested.

For the measured Calgary + all-Alberta build:

```sh
./infra/offline/build.sh --date 261111 --regions calgary,alberta \
  --routing-engine-version 3.9.1 --base-url http://127.0.0.1:3021
```

Use `--regions all` for the eleven download regions, or `--regions british-columbia` for the BC
bulk bundle. `--list-regions` prints IDs. `--output` selects the artifact/cache root (default
`artifacts/offline`, ignored by Git). A production `--base-url` must be HTTPS and denote the static
**releases** directory; it cannot contain credentials or expiring query tokens.

The routing engine parameter is pinned by `routing-engine.lock.json` to **Valhalla 3.9.1**, the
engine embedded in **Rallista valhalla-mobile 0.6.4**. Other engine values fail before building.
The toolbox copies the **3.8.2 Compose config generator** from its digest-pinned image, retaining
those routing defaults, the existing hybrid static speeds and Canada-admin repair. Production
online routing stays on 3.8.2. The manifest records the offline engine and GPH header version,
so the app must reject a bundle whose engine/format it cannot read.

### What gets built

- `maps.pmtiles`: PMTiles **v3**, gzip MVT, OpenMapTiles **3.16.0**, zooms **0–14** (overzoom at street zoom).
- `routing.tar`: uncompressed seekable indexed Valhalla tar; `index.bin` first, `.gph` tiles and
  `navoss-graph.json`. Regional extracts preserve the IDs/bytes from the same AB+BC graph.
- `search.sqlite`: SQLite **FTS5 + RTree**, `user_version=1`, `application_id=0x4e564f53` (`NVOS`).
- `resources.tar.gz`: one shared resource artifact per content hash: four offline styles, all
  768 BMP glyph ranges for Noto Sans Regular/Bold/Italic, 1×/2× sprites, routing config, query recipes,
  normalization data and original license notices. It is not downloaded once per region.

The style JSONs contain portable **relative resource references**. Bind them to installed absolute
URLs before giving a style object to MapLibre; `bindOfflineStyle` in `tools.mts` is the reference
implementation. Native maps use `pmtiles://file:///…/maps.pmtiles`. No hosted tile/glyph/sprite URL
survives binding. The optional online Natural Earth shaded raster is omitted; the generated Natural
Earth vector basemap remains. See [the exact app contract](../../docs/architecture/offline.md).

### Output, cache and reproducibility

`manifest.json` is atomically replaced only after all requested artifacts validate. Immutable files
live under `releases/<bundleVersion>/`; publication hard-links cached files rather than duplicating
multi-GB data. Each release includes `SHA256SUMS`, `provenance.json` and `build-report.json`.

Inputs are reused only after their SHA-256 checks pass. Geofabrik's MD5 sidecars and extended PBF
validation are checked on first ingestion; the immutable local SHA-256 record protects subsequent
runs. Auxiliary sources are locked by URL and SHA-256 in `sources.lock.json`; the Java, Node and
Valhalla images are digest-pinned, Planetiler's JAR is SHA-256 verified, and APT uses the fixed
Ubuntu snapshot `20261112T230000Z` with pinned package versions. Source/config changes invalidate
build caches; corrupted caches fail rather than becoming an empty or falsely ready bundle.

**Archive your inputs.** Geofabrik retires daily snapshots; use monthly snapshots for long-lived
reproduction, or retain the dated PBFs, MD5s, `SHA256SUMS` and `data.json` in `inputs/<date>/`.
The coastline and Natural Earth upstream URLs are mutable: if their bytes change, builds fail.
Retain the locked downloads or set `NAVOSS_OFFLINE_SOURCE_MIRROR` to an HTTPS snapshot mirror with
`<sha256>/<filename>` keys. Do not simply accept the new bytes under the old lock/version.

One build per artifact root is enforced with `.build-lock`. Failed work remains in `.work/` for
inspection. After confirming a crashed process is no longer running, remove its lock and failed
work; never remove another build's lock. No production directories are used by default.

## Verification

### Offline render, with external network denied

```sh
node --import tsx infra/offline/verify/prepare.mts
node --import tsx infra/offline/verify/server.mts --region calgary --port 3021
```

Open `http://127.0.0.1:3021/`. MapLibre GL JS and PMTiles JS are downloaded once from locked,
SHA-512-verified npm archives; the page then loads **only loopback resources**. Its CSP blocks
external connections. Also block every non-loopback request in the test browser. Exercise all four
styles at **City zoom** and **Street zoom**, require `data-ready="true"`, inspect the rendered map,
and capture screenshots. The state exposed as `window.offlineVerification` comes from actual
MapLibre load/render/error events, not a synthetic success indicator.

### Route + trace and engine comparison

```sh
node --import tsx infra/offline/verify/routing.mts
```

This starts an isolated, digest-pinned 3.9.1 engine on an ephemeral loopback port, routes the first
five **public Calgary** cases from the existing route benchmark, and traces each route-derived
shape with `map_snap`. It stops its containers afterward and saves only IDs, statuses and numerical
summaries, not input coordinates or route geometry.

Pass `--baseline-graph` pointing to a separately built **3.8.2 AB+BC graph directory** (containing
`valhalla.json` and `connected.tar`) to additionally measure 3.9.1 reading 3.8.2 tiles, and the same
routes in local online-like 3.8.2 versus offline 3.9.1. These are local comparisons, not production
VM checks. The measured compatibility/delta table is in the architecture document.

### Community-traffic dead-end mask

`dead-end-mask.mts` builds the topology mask that `live` community traffic requires from the same
dated input and connected graph, and `verify/dead-end-mask.mts` checks it against a local
Valhalla serving that graph. See [dead-end-mask.md](dead-end-mask.md).

### Search

```sh
image=navoss-offline-builder:mobile-0.6.4
# Build this convenient test tag from the same pinned Dockerfile if not already present.
docker build -t "$image" -f infra/offline/Dockerfile infra/offline
```

`query-search.py` executes the supplied SQL with bound, quoted tokens. Use the region cache directory
from `build-report.json` and the resource cache's `resources/search-normalization.json`. It supports
`--query`, or an exact `--category` plus an origin/radius. See the architecture doc's tested address,
partial-name and category examples. Coordinates and search text are not written to a query log.

### Tests and repository gates

```sh
docker run --rm --network none -v "$PWD/infra/offline:/scripts:ro" "$image" \
  python3 -m unittest discover -s /scripts/test -v
shellcheck infra/offline/*.sh
corepack pnpm check && corepack pnpm lint && corepack pnpm test && \
  corepack pnpm build && corepack pnpm format:check
```

Contract, endpoint, file integrity, style binding, option/version matching, and local HTTP range
behavior tests are included in the normal contracts/API test suites. Python tests exercise real
SQLite FTS/RTree queries, source-derived names/categories, safe same-graph tar assembly and region
coverage. Build outputs and screenshots remain under ignored `artifacts/`.

## Hosting

The API only reads `NAVOSS_OFFLINE_MANIFEST_PATH` at `GET /v1/offline/manifest`; it never proxies
artifacts. Mount the manifest read-only and serve artifacts separately with Content-Length,
ETag/Last-Modified, HTTP byte ranges and identity content encoding. Publish artifact keys before
switching the manifest pointer. **Recommended: R2 Standard object storage with a custom HTTPS
hostname**, not unlimited multi-GB delivery through the existing free Cloudflare Tunnel/CDN.
Hosting costs, bandwidth, terms and Caddy alternatives are documented in
[offline architecture](../../docs/architecture/offline.md). Nothing is provisioned by this builder.
