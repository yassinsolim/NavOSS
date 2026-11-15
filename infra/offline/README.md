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
byte ranges address them.

Zone rules on `yassin.app`, applied by API on 2026-11-15 (exact JSON in
[offline architecture](../../docs/architecture/offline.md#zone-rules)):

- **Cache rule** `navoss-offline artifacts` (new `http_request_cache_settings` entrypoint): makes
  everything on the download host eligible for cache. All seven artifacts, including the
  524,743,452-byte all-Alberta maps file, are then answered from cache (`cf-cache-status: HIT`).
- **WAF custom rule** `navoss-offline: only published files, GET, no query` (new
  `http_request_firewall_custom` entrypoint): on the download host, blocks every path except the
  manifest's artifact paths, every query string, and every method except GET (Cloudflare never
  answers HEAD from cache, so each HEAD would reach R2).
  `SHA256SUMS` and `provenance.json` are stored but not publicly served.
- **No rate-limiting rule**: the zone's single free rate-limiting slot holds the owner's existing
  "Leaked credential check" rule, which was left alone.

Usage notifications are not available on this plan; the [automatic stop](#automatic-stop) takes
their place.

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
rewrites `manifest.json`; the bundle version is content-derived, so it does not change. The
builder warns about any artifact above the CDN's 512 MiB cacheable size, because every download
of such a file would reach R2:

```sh
./infra/offline/build.sh --date 261111 --regions calgary,alberta \
  --routing-engine-version 3.9.1 --base-url https://navoss-offline.yassin.app
node infra/offline/hosting.mts cache-check artifacts/offline/manifest.json
```

**Allow the new paths in the WAF rule before anything points at them.** Until the rule lists a
release's paths, every download of it is refused (403): the release fails closed. Generate the
rule from the manifests that should be served (old and new together during a replacement) and
update it with a temporary API token that has `Zone WAF: Edit` on `yassin.app` only, revoked
afterwards:

```sh
node infra/offline/hosting.mts waf-rule OLD_MANIFEST NEW_MANIFEST > /tmp/navoss-offline-rule.json
api=https://api.cloudflare.com/client/v4/zones/$ZONE_ID/rulesets
auth="Authorization: Bearer $CLOUDFLARE_API_TOKEN"
ruleset=$(curl -fsS -H "$auth" "$api/phases/http_request_firewall_custom/entrypoint")
ruleset_id=$(printf '%s' "$ruleset" | jq -r .result.id)
rule_id=$(printf '%s' "$ruleset" | jq -r '.result.rules[]
  | select(.description == "navoss-offline: only published files, GET, no query") | .id')
curl -fsS -X PATCH -H "$auth" -H 'Content-Type: application/json' \
  --data @/tmp/navoss-offline-rule.json "$api/$ruleset_id/rules/$rule_id" >/dev/null
node --import tsx infra/offline/verify-hosting.mts artifacts/offline/manifest.json --sha256
```

`verify-hosting.mts` requires, for every artifact URL in the manifest, correct `206` answers to a
first-byte and a last-16-bytes ranged GET whose `Content-Range` total is the manifest's exact
size, an immutable `Cache-Control` and no content encoding; that the WAF refuses a query string,
an unpublished path and a HEAD (403); and that every file fits the cache. `--sha256` also
downloads each artifact once and compares its digest. Without `--sha256` it costs at most two
Class B operations per artifact (only when a location's cache is cold). Only then install the
manifest on the VM.

### Replace a release

1. Upload the new release beside the old one, run `cache-check`, allow both releases' paths in
   the WAF rule (`waf-rule OLD NEW`), and verify the new release as above. Two Calgary + Alberta
   releases are about 2.9 GB, well under the 10 GB free storage.
2. Install the new manifest on the VM.
3. After a **seven-day grace period** (a phone that fetched the old manifest can finish or resume
   its download), update the WAF rule from the new manifest alone (`waf-rule NEW`), then delete
   every key of the old release. Deletes are free operations:

   ```sh
   for key in SHA256SUMS provenance.json resources.tar.gz \
     regions/{calgary,alberta}/{maps.pmtiles,routing.tar,search.sqlite}; do
     npx --yes wrangler@4.162.0 r2 object delete "navoss-offline/$OLD/$key" --remote
   done
   ```

Never keep more than two releases. `r2-usage.mts` fails above 3 GB by default and the guard
stops hosting above 5 GB.

### Automatic stop

`r2-guard.mts` runs every 5 minutes on the VM (`infra/compose/navoss-offline-guard.timer`,
installed as in [the compose README](../compose/README.md#offline-guard-install-first)). Each run
reads, from Cloudflare's analytics, the account's month-to-date Class A and Class B operations and
its stored bytes, plus the custom domain's and the `r2.dev` URL's state. It **stops hosting** when:

- Class B operations exceed **2,000,000**, Class A **200,000**, or stored bytes **5 GB** (20% of
  each free allowance; `--stop-class-b`, `--stop-class-a`, `--stop-bytes` override);
- the `r2.dev` URL is enabled; or
- usage could not be read for **4 consecutive runs** (`--max-failures`). A failed request, an
  incomplete answer or a missing storage sample is never read as zero: each run that cannot read
  usage exits 2 and counts towards the limit in its state file.

Stopping means, in order: rename the manifest to `manifest.json.stopped`, so the API answers the
quiet 503 at the next request and the app says "Offline maps are not available yet" rather than
offering downloads that would fail; then disable the custom domain
(`PUT …/r2/buckets/navoss-offline/domains/custom/navoss-offline.yassin.app {"enabled": false}`,
which keeps the domain attached so it can be re-enabled), after which no request reaches R2; and
confirm the `r2.dev` URL is disabled. Every step is attempted even if an earlier one fails, and
the run prints one line with the reason and what it did, then exits 1. Later runs keep hosting
stopped and keep exiting 1. The guard **never re-enables** anything, not even in a new month. A
domain disabled by hand is treated the same way: the manifest is withdrawn.

```sh
# On a workstation: what the guard would do now, with the operator's token. Changes nothing.
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node infra/offline/r2-guard.mts --dry-run
```

The guard's token needs exactly `Account Analytics Read` and `Workers R2 Storage Write` for this
account. R2 has no narrower permission for bucket domain settings, so the token can also write
objects: keep it only in the root-only `/srv/navoss/state/offline-guard.env`.

**Re-enable** only after finding the cause (`journalctl -u navoss-offline-guard`, `r2-usage.mts`)
and only when usage is back under the stop thresholds (normally the next month). Order matters:
the guard withdraws the manifest again while the domain is disabled.

```sh
# 1. Enable the custom domain (or dashboard: R2 → navoss-offline → Settings → Custom Domains).
sudo sh -c '. /srv/navoss/state/offline-guard.env && curl -fsS -X PUT \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  --data "{\"enabled\":true}" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets/navoss-offline/domains/custom/navoss-offline.yassin.app" >/dev/null'
# 2. Put the manifest back and let the guard confirm (exit 0, "within limits").
sudo mv /srv/navoss/artifacts/offline/manifest.json.stopped /srv/navoss/artifacts/offline/manifest.json
sudo systemctl start navoss-offline-guard.service; journalctl -u navoss-offline-guard -n 1
NAVOSS_OFFLINE_MANIFEST_DIR=/srv/navoss/artifacts/offline ./infra/compose/check-stack.sh
```

If usage is still above a threshold, step 2 stops hosting again at once; that is intended.

### Usage report

```sh
node --import tsx infra/offline/r2-usage.mts   # exit 0 within limits, 1 above, 2 unknown
```

It reads the same analytics as the guard (no R2 operation) with `CLOUDFLARE_API_TOKEN`, or the
operator's `wrangler login` when that is unset, and prints the bucket's object count and bytes,
the account's stored bytes and month-to-date Class A and Class B operations as shares of the free
tier. It fails at the lower warning levels: 3 GB stored, 40 objects, 100,000 Class A or 1,000,000
Class B operations (`--max-bytes`, `--max-objects`, `--max-class-a`, `--max-class-b` override).
A missing storage sample exits 2 rather than reporting an empty bucket.

To stop every download by hand without the guard, disable the custom domain as in re-enable step 1
with `{"enabled":false}`, or in the dashboard. Installed regions keep working on devices.
