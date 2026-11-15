# Regional offline bundle builder

Build tools run in Docker on macOS/OrbStack or Linux. Nothing here deploys to the production VM,
changes the online Valhalla service, or downloads tiles from OpenFreeMap's public tile endpoint.
The app (build 75 onward) installs these bundles from a published manifest; one release is hosted on
Cloudflare R2 ([Hosting](#hosting)), but production does not serve its manifest yet.

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

`serving-graph.mts` builds the Valhalla 3.8.2 graph the online stack serves for `live` community
traffic, with a provenance record binding it to the verified extract; `dead-end-mask.mts` builds
the topology mask for that graph from the same input, and `verify/dead-end-mask.mts` checks both
against a local Valhalla serving the directory. See [dead-end-mask.md](dead-end-mask.md).

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

The phone downloads artifacts straight from object storage; the API only serves the manifest named
by `NAVOSS_OFFLINE_MANIFEST_PATH` at `GET /v1/offline/manifest` and never proxies artifacts
([production steps](../compose/README.md#offline-bundle-manifest)). The cost model, the guardrails
and what cannot be capped are in [offline architecture](../../docs/architecture/offline.md#hosting-cloudflare-r2).

### What is provisioned (2026-11-15)

On the owner's personal Cloudflare account, and nothing else in it:

- R2 bucket **`navoss-offline`**: Standard storage class (the only one the free tier covers),
  location hint Western North America. The public `r2.dev` URL is **disabled**; the only public
  path is the custom domain below. Neither path can list objects.
- Custom domain **`navoss-offline.yassin.app`** on that bucket, minimum TLS 1.2. R2 created and
  manages its DNS record; no other record in `yassin.app` was touched.
- Lifecycle rule `abort-incomplete-multipart-1d` (aborts unfinished multipart uploads after one
  day; it replaced R2's default seven-day rule). There is no expiry rule: releases are removed
  by hand as below, never by a timer that could delete the live one.
- Exactly one release, `2026-11-11-v1-798f5c442644`: nine objects, 1,452,230,980 bytes, under
  the key prefix `<bundleVersion>/` (the same layout as `releases/<bundleVersion>/`): each
  region's `maps.pmtiles`, `routing.tar` and `search.sqlite`, `resources.tar.gz`, `SHA256SUMS`
  and `provenance.json`. The release directory's own `manifest.json` (loopback URLs) and
  `build-report.json` (local cache paths) are not uploaded.

Every object carries `Cache-Control: public, max-age=31536000, immutable`, an exact
`Content-Type` (`application/vnd.pmtiles`, `application/x-tar`, `application/vnd.sqlite3`,
`application/gzip`) and no `Content-Encoding`, so the stored bytes are the checksummed bytes and
byte ranges address them. Cloudflare compresses only `SHA256SUMS` and `provenance.json` on the fly
for clients that ask; the app requests `identity` and never fetches them.

Not done from this repository, because the `wrangler login` token cannot manage zone rules or
notifications: the cache rule, the rate-limiting rule and usage notifications. They are dashboard
steps for the account owner, listed in the architecture document.

### Publish a release

With the pinned Node first in `PATH` (`npx --yes wrangler@4.162.0 login` once, as the owner):

```sh
V=2026-11-11-v1-798f5c442644      # the new bundleVersion
R=artifacts/offline/releases/$V
put() {
  npx --yes wrangler@4.162.0 r2 object put "navoss-offline/$V/$1" --remote --file "$R/$1" \
    --content-type "$2" --cache-control 'public, max-age=31536000, immutable'
}
put SHA256SUMS 'text/plain; charset=utf-8'
put provenance.json application/json
put resources.tar.gz application/gzip
for region in calgary alberta; do
  put "regions/$region/maps.pmtiles" application/vnd.pmtiles
  put "regions/$region/routing.tar" application/x-tar
  put "regions/$region/search.sqlite" application/vnd.sqlite3
done
```

Each `put` is one Class A operation. Wrangler refuses files over 300 MiB (314,572,800 bytes); the
all-Alberta `maps.pmtiles` (524,743,452 bytes) is larger. For such a file the owner creates a
temporary R2 **Account API token** in the dashboard (R2, Manage API tokens: Object Read & Write,
this bucket only) and revokes it right after. R2 accepts up to 5 GiB in one `PutObject`, so a
single signed request suffices (one Class A operation, no multipart parts to abandon), and
`x-amz-checksum-sha256` makes R2 reject bytes that do not match the local SHA-256:

```sh
f="$R/regions/alberta/maps.pmtiles"
sum=$(shasum -a 256 "$f" | cut -d' ' -f1 | xxd -r -p | base64)
# Credentials are read from stdin so they never appear in the process list or shell history.
printf 'user = "%s:%s"\n' "$R2_ACCESS_KEY_ID" "$R2_SECRET_ACCESS_KEY" |
  curl -K - --fail -sS --aws-sigv4 'aws:amz:auto:s3' -X PUT -T "$f" \
    -H 'Content-Type: application/vnd.pmtiles' \
    -H 'Cache-Control: public, max-age=31536000, immutable' \
    -H "x-amz-checksum-sha256: $sum" \
    "https://$ACCOUNT_ID.r2.cloudflarestorage.com/navoss-offline/$V/regions/alberta/maps.pmtiles"
```

Then generate the manifest for the public origin with the same builder. A cached rerun only
rewrites `manifest.json`; the bundle version is content-derived, so it does not change:

```sh
./infra/offline/build.sh --date 261111 --regions calgary,alberta \
  --routing-engine-version 3.9.1 --base-url https://navoss-offline.yassin.app
node --import tsx infra/offline/verify-hosting.mts artifacts/offline/manifest.json --sha256
```

`verify-hosting.mts` requires, for every artifact URL in the manifest, `200` with the manifest's
exact `Content-Length`, `Accept-Ranges: bytes`, an immutable `Cache-Control`, no content
encoding and a correct `206` tail range; `--sha256` also downloads each artifact once and compares
its digest. Without `--sha256` it costs at most two Class B operations per artifact. Only then
install the manifest on the VM.

### Replace a release

1. Upload the new release beside the old one and verify it as above. Two Calgary + Alberta
   releases are about 2.9 GB, well under the 10 GB free storage.
2. Install the new manifest on the VM.
3. After a **seven-day grace period** (a phone that fetched the old manifest can finish or resume
   its download), delete every key of the old release. Deletes are free operations:

   ```sh
   for key in SHA256SUMS provenance.json resources.tar.gz \
     regions/{calgary,alberta}/{maps.pmtiles,routing.tar,search.sqlite}; do
     npx --yes wrangler@4.162.0 r2 object delete "navoss-offline/$OLD/$key" --remote
   done
   ```

Never keep more than two releases. `r2-usage.mts` fails above 3 GB by default.

### Usage check and emergency stop

```sh
node --import tsx infra/offline/r2-usage.mts   # exit 0 within limits, 1 above, 2 unknown
```

It reads Cloudflare's GraphQL analytics only (no R2 operation) with `CLOUDFLARE_API_TOKEN`, or the
operator's `wrangler login` when that is unset, and prints the bucket's object count and bytes,
the account's stored bytes and month-to-date Class A and Class B operations as shares of the free
tier. It fails above 3 GB stored, 40 objects, 100,000 Class A or 1,000,000 Class B operations
(10% of the free allowances; `--max-bytes`, `--max-objects`, `--max-class-a`, `--max-class-b`
override). Storage figures are sampled and can lag an upload by hours; a missing sample exits 2
rather than reporting an empty bucket. Run it daily, for example from `launchd` or `cron` on the
operator's Mac, and act on a non-zero exit.

To stop every download at once, detach the custom domain. Cloudflare then answers no request for
the hostname, so nothing reaches R2. Installed regions keep working on devices:

```sh
npx --yes wrangler@4.162.0 r2 bucket domain remove navoss-offline --domain navoss-offline.yassin.app
# Restore later with `r2 bucket domain add … --zone-id <yassin.app zone> --min-tls 1.2`.
```
