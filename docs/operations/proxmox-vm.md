# Production VM specification

Status: production backend deployed; restore/rollback and soak exercises remain

This VM hosts the live Canada-wide NavOSS production API, versioned Canada and retained Alberta and British Columbia Valhalla/Nominatim data, PostgreSQL/PostGIS, the Calgary public-data search indexer, Caddy, and Cloudflare Tunnel. Geospatial imports run sequentially and must preserve at least 4 GiB of available guest memory with no sustained swap growth.

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

The VM is ready for TestFlight only after:

- [x] QEMU guest agent reports a healthy guest.
- [x] `scsi1` and `scsi2` remounted correctly after the July 20 controlled VM reboot.
- [x] Docker, `navoss-stack.service`, cloudflared, and the backup timer recovered after that reboot without manual intervention.
- [x] `/health`, `/ready`, `/v1/config`, POST search, routing, and cameras pass through `https://navoss-api.yassin.app`.
- [x] Route-quality tests pass all 17 Calgary variants at 73 ms p95 latency.
- [ ] A minimum 24-hour soak retains at least 4 GiB guest-available memory at peak and establishes search latency/error baselines.
- [x] Current serving state has 14 GiB available, zero swap use, and no OOM event.
- [ ] PostgreSQL restore and Valhalla/Nominatim rollback are demonstrated.
- [x] UFW permits inbound SSH only from `192.168.1.0/24`; Caddy and cloudflared metrics bind loopback; no backend data service is host-published.
