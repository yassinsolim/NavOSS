# Production VM specification

Status: production backend deployed; restore/rollback and soak exercises remain

This VM hosts the live Canada-wide NavOSS production API, its versioned Canada Valhalla/Nominatim data (kept current by the [automatic map updater](#automatic-map-updates)), PostgreSQL/PostGIS, the Calgary public-data search indexer, Caddy, and Cloudflare Tunnel. Geospatial imports run sequentially and must preserve at least 4 GiB of available guest memory with no sustained swap growth.

## Proxmox VM

| Setting          | Value                                                               |
| ---------------- | ------------------------------------------------------------------- |
| Name             | Proxmox VM 100; guest hostname `navoss-dev`                         |
| OS               | Ubuntu Server 24.04.4 LTS                                           |
| Machine          | `q35`                                                               |
| Firmware         | OVMF (UEFI) with EFI disk; Secure Boot/pre-enrolled keys disabled   |
| QEMU Guest Agent | Enabled                                                             |
| CPU              | 1 socket, 6 cores, CPU type `host` (from 4 on 2026-11-15)           |
| NUMA             | Disabled                                                            |
| Memory           | 24 GiB fixed (from 16 GiB on 2026-11-15, for the Canada release)    |
| Ballooning       | Disabled                                                            |
| SCSI controller  | VirtIO SCSI single                                                  |
| Network          | VirtIO NIC at `192.168.1.74`; guest UFW enabled                     |
| Start at boot    | Guest services enabled; Proxmox VM onboot pending until soak passes |
| ACPI             | Enabled                                                             |

Do not overcommit these six cores or 24 GiB against host capacity. The host must retain its own existing safety margin after this VM is running under peak load.

## Disks

Use SSD/NVMe-backed thin storage where available. Enable `Discard`, `SSD emulation`, and `IO thread` on every SCSI disk. Use cache mode `No cache` unless the storage administrator has a measured, power-protected reason to use write-back.

| Device           |    Size | Backup | Guest use                                                                                              |
| ---------------- | ------: | ------ | ------------------------------------------------------------------------------------------------------ |
| `scsi0`          |   60 GB | Yes    | Ubuntu, packages, logs, swap, containerd store                                                         |
| `scsi1`          |  40 GiB | Yes    | `/srv/navoss/state`: PostgreSQL, secrets/config references, application backups                        |
| `scsi2`          |  260 GB | No     | `/srv/navoss/artifacts`: Docker data, Valhalla graphs, Nominatim indexes, downloads, staging artifacts |
| Cloud-Init drive | Default | N/A    | Initial user, SSH key, network configuration                                                           |

`scsi2` contains reproducible artifacts and is excluded from Proxmox backup to keep backup size bounded. Keep the active and previous validated graph/index versions for atomic rollback. Never place the PostgreSQL data directory on `scsi2`.

On 2026-11-15, `scsi0` was expanded from 40 GB to 60 GB; the root filesystem was 56 GB and 53% used. Docker's data root is `/srv/navoss/artifacts/docker`, but `/var/lib/containerd` (21 GB at the time) is on the root disk.

Memory was restored from 8,192 MiB to 16,384 MiB on the same date. One reboot caused 57 seconds of API downtime; the stack recovered on its own.

Later on 2026-11-15 the lead resized VM 100 for Canada-wide coverage: 6 cores, 24 GiB RAM, `scsi2`
grown online to 260 GB, one reboot. The system disk stays 60 GB. pve01 cannot give VM 100 more
today: it keeps 8 GB of RAM unallocated and its NVMe pool must stay under 80 %. The Canada
build fits these limits only one heavy step at a time
([`north-america.md`](../architecture/north-america.md#sizing-on-vm-100-6-vcpu-24-gib-260-gb-artifact-disk)).

The 2026-11-15 Canada build measured 9 minutes for inputs, about 35 minutes for both Valhalla
passes on 4 cores (8,767 tiles, 3.9 GB after cleanup), and 147 minutes for Nominatim with a
10 GiB container and `--osm2pgsql-cache 3000` (18 GB frozen database). Peak artifact disk was
about 89 GB; after cutover 60 GB of 255 GB was used. The first import was OOM-killed after
10 minutes because the image ignored `OSM2PGSQL_CACHE` and selected 12.4 GB; #124 fixed it.
At 15:44 UTC the Canada cutover used API image `4708d34`. Rollback image tag:
`navoss-api:pre-canada-registry`; restore `infra/compose/.env.pre-canada-20261115T154413Z`
and run `docker compose up -d --no-build --wait valhalla nominatim api caddy` for data rollback.
The current API image is from `36c8a9f`, deployed on 2026-11-15; its immediate image rollback tag is
`navoss-api:pre-canada-search-fixes`. The earlier cutover tag and data backup above remain distinct.

Format `scsi1` and `scsi2` as ext4 and mount them by filesystem UUID with `defaults,noatime`.

## Cloud-Init and OS

| Setting          | Value                                                                      |
| ---------------- | -------------------------------------------------------------------------- |
| Hostname         | `navoss-dev`                                                               |
| User             | `navoss`                                                                   |
| Authentication   | SSH public key only; no password login                                     |
| DNS              | Existing trusted LAN resolver, with public fallback only if policy permits |
| Time zone        | `Etc/UTC`; application timers specify `America/Edmonton` explicitly        |
| IPv4             | `192.168.1.74`                                                             |
| IPv6             | Link-local enabled; public NAT64 behavior remains a release test           |
| Upgrade packages | All initial updates applied; ongoing patching is an operations requirement |

The QEMU guest agent is active. OpenSSH uses key-only authentication, root login and password authentication are disabled, and SSH forwarding is disabled.

Create a 4 GiB swap file on `scsi0` with `vm.swappiness=10`. Swap is emergency protection, not normal capacity. Any sustained swap growth during the soak test fails the deployment gate.

## Network policy

Do not port-forward this VM from the public internet. `navoss-api.yassin.app` uses an outbound Cloudflare Tunnel to `127.0.0.1:8080` on the VM.

Proxmox/guest firewall policy:

- Default inbound: deny.
- Allow TCP 22 only from the trusted management subnet or VPN.
- Allow ICMP/ICMPv6 from the trusted LAN for diagnostics.
- Allow established/related traffic.
- Allow outbound DNS, NTP, HTTP/HTTPS, Cloudflare Tunnel, GitHub Container Registry, GitHub, Geofabrik, Calgary Open Data, and OS package mirrors.
- Do not expose PostgreSQL, Docker, Valhalla, Nominatim, metrics, or admin endpoints publicly.
- Valhalla, Nominatim, and PostgreSQL have no host-published ports. Caddy alone publishes `127.0.0.1:8080`; cloudflared metrics bind `127.0.0.1:2000`.

Initial Cloudflare Tunnel ingress:

```text
navoss-api.yassin.app -> http://127.0.0.1:8080
fallback                -> HTTP 404
```

## Initial service budgets

These are hard starting limits, not targets to consume:

| Service                               |                                 Initial memory budget |
| ------------------------------------- | ----------------------------------------------------: |
| Nominatim/PostgreSQL                  |    6 GiB container limit (8 GiB for the Canada index) |
| Valhalla                              |    2 GiB container limit (4 GiB for the Canada graph) |
| Staged build (one at a time)          | Valhalla 8 GiB or Nominatim import 10 GiB, never both |
| Reports PostgreSQL/PostGIS            |                 768 MiB limit; 256 MiB shared buffers |
| Calgary search indexer                |                               512 MiB container limit |
| NavOSS API                            |                               768 MiB container limit |
| Caddy                                 |                               192 MiB container limit |
| OS, cloudflared, cache, safety margin |   Remaining memory; 14 GiB available after deployment |

Build or import only one heavy artifact at a time. Prefer staging validated Valhalla graphs and Nominatim indexes away from tester traffic. If an on-VM build is unavoidable, stop the corresponding serving container, apply explicit CPU/memory limits, and never build during a tester session.

## Automatic map updates

`navoss-map-update.timer` runs `infra/compose/map-update.sh run` as root early every Tuesday
(01:30 America/Edmonton, up to 15 minutes later; a missed run happens at the next boot). It keeps
the routing graph on a recent Geofabrik Canada release and rebuilds the search index monthly.
Every build step is `stage-coverage.sh` (the manual runbook in `infra/compose/README.md`), so a
timer build and a manual one are the same build.

One run:

1. **Release check.** Resolves `north-america/canada/canada-latest.osm.pbf` to its dated file
   (`canada-YYMMDD.osm.pbf`) and requires its `.md5`. If the live graph (the release in
   `VALHALLA_DATA_DIR`) is that release, the run ends as `up-to-date` and builds nothing. Geofabrik
   publishes daily, so the weekly timer is the graph's cadence. The index is due when it is
   28 days older than the newest release (`MAP_UPDATE_NOMINATIM_MAX_AGE_DAYS`), and only together
   with a graph of that release, because the staged API serves both. Nominatim replication cannot
   replace these re-imports: the index is imported with `FREEZE=true`, which drops the update tables.
2. **Gates.** It refuses (exit 75, unit failed, nothing started) when any of these fails:
   - `nvme-fast` (from `pve-api`) would pass **78 %** (`MAP_UPDATE_POOL_MAX_PCT`) once the build's
     peak is written. The pool alerts at 80 %; the two points (about 38 GB) are for the other guests
     while the build runs. An unreadable pool status also refuses.
   - The artifact disk lacks the peak plus 20 GB. `stage-coverage.sh` also keeps its own per-step floors.
   - `MemAvailable` is below the build container's limit plus a 4 GiB floor: 12 GiB for a graph,
     15 GiB with an index.

   Peaks come from the live artifacts: the extract twice (download and routing filter) plus three
   times the graph, about 25 GB for Canada; an index adds two and a half times the live index,
   about 45 GB (the 2026-11-15 import peaked at about 89 GB of disk in all). When the graph fits and
   the index does not, the index waits for a later run.

3. **Build** with `stage-coverage.sh inputs` and `valhalla` (both passes, admin repair, the reviewed
   Alberta and Ontario speed profile from `prepare-valhalla-speeds.sh`), and when due `nominatim`.
   Build containers have the limits the runbook measured (8 GiB graph, 10 GiB import) and run at a
   quarter of the live services' CPU weight with `--oom-score-adj 500`, so the kernel kills a build
   before a live service. The unit's own processes (downloads, osmium) run at `Nice=10`, low I/O
   priority and `MemoryMax=4G`.
4. **Verify before the swap.** The new graph is served on `127.0.0.1:18002` and must give the
   downtown Calgary to YYC route within the `check-stack.sh` window (18–20.5 km, 1050–1300 s) and
   one route per province (`route-quality-canada.json`, as `check-coverage.sh` picks them) within
   its distance range. A new index goes through `stage-coverage.sh serve` and `verify`, then search
   probes in five provinces on the staged API. The live stack must also pass its checks before
   anything changes.
5. **Swap.** `.env` is saved as `.env.pre-map-update-<UTC time>`, its data values are replaced, and
   `docker compose up -d --no-build --wait` recreates `valhalla api` (and `nominatim`, then the
   special phrases, with an index). About a minute of routing downtime; a few minutes of search
   downtime with an index. Then `check-stack.sh` and the public probes: the Calgary airport route
   and five Nominatim searches through `https://navoss-api.yassin.app`, each of which must report
   the new `datasetVersion`. Any failure, or the run being stopped mid-swap, restores the saved
   `.env`, recreates the same services and checks them again.
6. **Prune** at the start and end of every run: only the live and the previous build of each kind
   (`valhalla-canada-*`, `nominatim/canada-*`) and the extracts they use remain. A directory that
   any container mounts, or that holds a `.navoss-keep` file, is never removed: create that file in
   a stage you are building by hand outside the updater. Then `fstrim` returns the space to
   `nvme-fast`. The newest five `.env.pre-map-update-*` backups are kept.

The run holds `/srv/navoss/artifacts/.stage.lock` from start to end and hands it to its
`stage-coverage.sh` steps, so no manual step can start during a run, and a run started during a
manual step, or while a manual `serve` session's staging containers are up, is refused.
`stage-coverage.sh stop canada` ends a running update like any step. The traffic overlay graph
(`COMMUNITY_TRAFFIC_GRAPH_ID` set) is never replaced: such a run is refused.

Records: `/srv/navoss/state/map-update/status.json` (last run: result, reason, newest release, live
and rollback paths), one log per run in `/srv/navoss/state/map-update/runs/` (newest 30), and the
journal (`journalctl -u navoss-map-update`). The rollback targets are in `previous-valhalla` and
`previous-nominatim` in the same directory.

```sh
cd /home/navoss/NavOSS/infra/compose
sudo ./map-update.sh plan                 # dry run: release, gates, plan, live probes; changes nothing
sudo systemctl start navoss-map-update    # a real run now, as the timer runs it
sudo ./map-update.sh status
systemctl list-timers navoss-map-update.timer
# Back to the previous graph or index, verified like a swap:
sudo ./map-update.sh rollback valhalla
sudo ./map-update.sh rollback nominatim
```

Install or update the units from the deployed checkout:

```sh
sudo install -m 0644 navoss-map-update.service navoss-map-update.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now navoss-map-update.timer
```

To pause updates, `sudo systemctl disable --now navoss-map-update.timer`. A by-hand rollback
without the script restores the newest `.env.pre-map-update-*` and runs
`sudo docker compose up -d --no-build --wait --wait-timeout 1800 valhalla nominatim api`, then
`./check-stack.sh`.

On 2026-11-27 the superseded artifacts were deleted to make room: both Alberta+BC graphs
(`valhalla-alberta-british-columbia-260730` and `-ca-parent`, 2.8 GB each), the Alberta+BC index
(`nominatim/alberta-british-columbia-260730`, 6.0 GB), the July Alberta graph (`valhalla`,
0.97 GB) and index (`nominatim/postgres`, 7.5 GB), and the Alberta and BC extracts (6.1 GB), about
26 GB in all. `.env.pre-canada-20261115T154413Z` names them and can no longer be restored.

## Backup and recovery

- Include `scsi0` and `scsi1` in nightly Proxmox Backup Server or equivalent backups.
- Exclude `scsi2`; its contents must be reproducible from versioned inputs.
- Run compressed mode-0640 PostgreSQL logical backups to `/srv/navoss/state/backups/postgres` before the Proxmox backup window; retain 14 days. Exclude reproducible `calgary_search_*` tables.
- Encrypt the Proxmox backup target/transport. The local gzip dump is not independently encrypted.
- Retain configuration in Git without secret values.
- Keep a documented restore command and perform a clean restore before external TestFlight.

The 2026-11-15 deployment was preceded by logical backup `navoss-20261115T033116Z.sql.gz` and Proxmox snapshot `pre-deploy-20261115`; the snapshot was deleted after verification. Neither is evidence of a completed PostgreSQL restore or Valhalla/Nominatim rollback demonstration; those acceptance boxes remain open.

## SSH handoff

The `navoss` account is the deployment user. Keep sudo access limited to the commands required for Docker, systemd, firewall, package, and recovery operations where practical.

Required access:

- SSH public-key authentication for `navoss` through the local `navoss-prod` alias.
- Membership in no privileged group except temporary bootstrap sudo.
- Do not send a root password, user password, private key, API token, or Cloudflare token in chat.
- Provide only the VM's private LAN hostname/IP, SSH port if nonstandard, and confirmation that the public key was installed.

## Acceptance gate

The following readiness and recovery exercises remain relevant despite TestFlight distribution:

- [x] QEMU guest agent reports a healthy guest.
- [x] `scsi1` and `scsi2` remounted correctly after the July 20 controlled VM reboot.
- [x] Docker, `navoss-stack.service`, cloudflared, and the backup timer recovered after that reboot without manual intervention.
- [x] `/health`, `/ready`, `/v1/config`, POST search, routing, and cameras pass through `https://navoss-api.yassin.app`.
- [x] Route-quality tests pass all 17 Calgary variants at 73 ms p95 latency.
- [ ] A minimum 24-hour soak retains at least 4 GiB guest-available memory at peak and establishes search latency/error baselines.
- [x] Current serving state has 14 GiB available, zero swap use, and no OOM event.
- [ ] PostgreSQL restore and Valhalla/Nominatim rollback are demonstrated.
- [x] UFW permits inbound SSH only from `192.168.1.0/24`; Caddy and cloudflared metrics bind loopback; no backend data service is host-published.
