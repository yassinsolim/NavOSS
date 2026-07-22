# Calgary route-quality report

Date: 2026-07-20

## Verdict

The NavOSS automated route-quality gate passed all 17 tested variants across 12 representative Calgary corridors against the production Alberta Valhalla deployment. This is evidence that the current Valhalla integration returns plausible, internally consistent routes. It is not evidence of Apple Maps or Google Maps parity.

Manual Apple Maps and Google Maps measurements remain **not run**. NavOSS has no licensed API access to either provider, and their route data must not be scraped. Use the worksheet below to capture a same-time comparison from their consumer apps.

## Automated result

| Corridor                         | Mode           | Distance |      ETA | API latency |
| -------------------------------- | -------------- | -------: | -------: | ----------: |
| Downtown to Airport              | Default        |  19.1 km | 22.5 min |       73 ms |
| Downtown to Airport              | Avoid highways |  16.4 km | 38.2 min |       70 ms |
| Downtown to University           | Default        |   8.4 km | 20.2 min |       48 ms |
| Downtown to Chinook              | Default        |   6.5 km | 17.1 min |       39 ms |
| Downtown to East Hills           | Default        |  18.9 km | 29.0 min |       45 ms |
| Downtown to East Hills           | Avoid highways |  12.2 km | 30.0 min |       49 ms |
| Downtown to Canada Olympic Park  | Default        |  14.5 km | 27.2 min |       54 ms |
| Downtown to South Health Campus  | Default        |  28.5 km | 29.9 min |       46 ms |
| Downtown to South Health Campus  | Avoid highways |  25.4 km | 53.2 min |       60 ms |
| Crowfoot to Saddletowne          | Default        |  33.4 km | 30.8 min |       38 ms |
| Crowfoot to Saddletowne          | Avoid highways |  23.8 km | 52.1 min |       42 ms |
| Foothills to South Health Campus | Default        |  31.3 km | 32.0 min |       47 ms |
| East Hills to Westhills          | Default        |  28.5 km | 32.5 min |       39 ms |
| East Hills to Westhills          | Avoid highways |  22.0 km | 54.0 min |       52 ms |
| McKenzie Towne to Airport        | Default        |  34.7 km | 29.2 min |       36 ms |
| Rockyview to University          | Default        |  12.3 km | 21.7 min |       40 ms |
| Stampede to Foothills            | Default        |   8.5 km | 19.9 min |       44 ms |

Summary: 17 passed, 0 failed, p95 API latency 73 ms. The run used the production API image, Caddy ingress, Alberta Valhalla graph, and the same loopback endpoint served by the Cloudflare tunnel.

The gate checked:

- plausible corridor-specific distance and duration ranges;
- one to three alternatives and a credible average speed;
- route and step distances agreeing within 3%;
- origin/destination road-access offsets within case-specific tolerances;
- no geometry gap over 2 km and at least 20 geometry points;
- spoken-instruction coverage of at least 75%;
- avoid-highways geometry changing where that variant is requested;
- latency below 5 seconds; and
- an explicit `traffic: unavailable` posture.

Observed geometry and step totals differed by at most 0.2%. Spoken-instruction coverage ranged from 88.9% to 94.7%. Canada Olympic Park had the largest accepted destination offset at 187.9 m because its point-of-interest centroid is well inside the site rather than on the access road.

## Manual comparison protocol

1. Capture all three products within two minutes, from the same coordinates, with driving mode selected.
2. Record local date/time and whether Apple or Google reports traffic disruption.
3. Record distance, ETA, primary roads, first maneuver, and any closure or restriction warning.
4. Compare the default route shape and road choices. Do not treat NavOSS ETA as live-traffic parity; NavOSS currently has no traffic feed.
5. Flag a route for investigation if it is illegal, inaccessible, uses a closed road, misses the requested destination, differs by more than 15% in distance, or differs by more than 25% in ETA without an obvious traffic explanation.
6. Have a passenger collect results. Do not interact with three navigation apps while driving.

Apple and Google agreement is a useful signal, not ground truth. Posted signs, restrictions, and direct road observation take precedence.

## Routing research and ranking policy

NavOSS requests up to two Valhalla alternates for a route preview, producing up to three route choices when reasonable alternatives exist. Valhalla may return fewer than requested, and its official documentation says alternates are not supported for time-dependent routes. NavOSS therefore ranks the available free-flow routes by exact duration first and exact distance second. Rounded minute labels never determine ordering.

This policy is comparable to the non-traffic baseline offered by larger routing products, but it cannot guarantee a faster real-world route than Google Maps or Apple Maps:

- Google Routes supports `TRAFFIC_AWARE_OPTIMAL`, departure time, traffic speed intervals, and traffic-aware route duration. Those requests use a paid preferred tier.
- Apple MapKit can request reasonable alternate routes. Apple documents `MKRoute.expectedTravelTime` as travel time under ideal conditions, while the consumer Apple Maps product may use additional proprietary signals.
- Valhalla supports historical and live traffic when suitable traffic data is imported. The current NavOSS graph has neither feed, so its API correctly reports `traffic: unavailable`.

The next route-speed milestone is not a larger highway preference: Valhalla's neutral `use_highways` default is already `0.5`. It is to acquire a licensed Calgary traffic source, import historical/live speeds and closures into Valhalla, then benchmark same-time route choices using the manual protocol above. Until then, route safety and legality take precedence over claiming competitor parity.

## Comparison worksheet

Fill the blank cells after opening the links on the same device and at the same time.

| Corridor                         | NavOSS             | Apple Maps                                                                                       | Apple result | Google Maps                                                                                                                      | Google result | Primary-road / first-maneuver notes | Verdict |
| -------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------- | ------- |
| Downtown to Airport              | 19.1 km / 19.6 min | [Open](https://maps.apple.com/?saddr=51.04427,-114.06309&daddr=51.13157,-114.01055&dirflg=d)     | REQUIRED     | [Open](https://www.google.com/maps/dir/?api=1&origin=51.04427,-114.06309&destination=51.13157,-114.01055&travelmode=driving)     | REQUIRED      | REQUIRED                            | Not run |
| Downtown to University           | 8.4 km / 15.1 min  | [Open](https://maps.apple.com/?saddr=51.04427,-114.06309&daddr=51.07795,-114.13073&dirflg=d)     | REQUIRED     | [Open](https://www.google.com/maps/dir/?api=1&origin=51.04427,-114.06309&destination=51.07795,-114.13073&travelmode=driving)     | REQUIRED      | REQUIRED                            | Not run |
| Downtown to Chinook              | 6.4 km / 12.6 min  | [Open](https://maps.apple.com/?saddr=51.04427,-114.06309&daddr=50.99865,-114.07367&dirflg=d)     | REQUIRED     | [Open](https://www.google.com/maps/dir/?api=1&origin=51.04427,-114.06309&destination=50.99865,-114.07367&travelmode=driving)     | REQUIRED      | REQUIRED                            | Not run |
| Downtown to East Hills           | 12.2 km / 21.0 min | [Open](https://maps.apple.com/?saddr=51.04427,-114.06309&daddr=51.04112,-113.9132&dirflg=d)      | REQUIRED     | [Open](https://www.google.com/maps/dir/?api=1&origin=51.04427,-114.06309&destination=51.04112,-113.9132&travelmode=driving)      | REQUIRED      | REQUIRED                            | Not run |
| Downtown to Canada Olympic Park  | 14.7 km / 20.6 min | [Open](https://maps.apple.com/?saddr=51.04427,-114.06309&daddr=51.0809235,-114.2164025&dirflg=d) | REQUIRED     | [Open](https://www.google.com/maps/dir/?api=1&origin=51.04427,-114.06309&destination=51.0809235,-114.2164025&travelmode=driving) | REQUIRED      | REQUIRED                            | Not run |
| Downtown to South Health Campus  | 28.5 km / 27.6 min | [Open](https://maps.apple.com/?saddr=51.04427,-114.06309&daddr=50.8822452,-113.9526766&dirflg=d) | REQUIRED     | [Open](https://www.google.com/maps/dir/?api=1&origin=51.04427,-114.06309&destination=50.8822452,-113.9526766&travelmode=driving) | REQUIRED      | REQUIRED                            | Not run |
| Crowfoot to Saddletowne          | 33.4 km / 28.5 min | [Open](https://maps.apple.com/?saddr=51.1236422,-114.208115&daddr=51.12075,-113.94678&dirflg=d)  | REQUIRED     | [Open](https://www.google.com/maps/dir/?api=1&origin=51.1236422,-114.208115&destination=51.12075,-113.94678&travelmode=driving)  | REQUIRED      | REQUIRED                            | Not run |
| Foothills to South Health Campus | 31.2 km / 30.9 min | [Open](https://maps.apple.com/?saddr=51.06534,-114.13308&daddr=50.8822452,-113.9526766&dirflg=d) | REQUIRED     | [Open](https://www.google.com/maps/dir/?api=1&origin=51.06534,-114.13308&destination=50.8822452,-113.9526766&travelmode=driving) | REQUIRED      | REQUIRED                            | Not run |
| East Hills to Westhills          | 28.4 km / 29.3 min | [Open](https://maps.apple.com/?saddr=51.04112,-113.9132&daddr=51.0157721,-114.1693872&dirflg=d)  | REQUIRED     | [Open](https://www.google.com/maps/dir/?api=1&origin=51.04112,-113.9132&destination=51.0157721,-114.1693872&travelmode=driving)  | REQUIRED      | REQUIRED                            | Not run |
| McKenzie Towne to Airport        | 34.7 km / 29.1 min | [Open](https://maps.apple.com/?saddr=50.9164994,-113.9643527&daddr=51.13157,-114.01055&dirflg=d) | REQUIRED     | [Open](https://www.google.com/maps/dir/?api=1&origin=50.9164994,-113.9643527&destination=51.13157,-114.01055&travelmode=driving) | REQUIRED      | REQUIRED                            | Not run |
| Rockyview to University          | 12.9 km / 19.0 min | [Open](https://maps.apple.com/?saddr=50.9908499,-114.0971138&daddr=51.07795,-114.13073&dirflg=d) | REQUIRED     | [Open](https://www.google.com/maps/dir/?api=1&origin=50.9908499,-114.0971138&destination=51.07795,-114.13073&travelmode=driving) | REQUIRED      | REQUIRED                            | Not run |
| Stampede to Foothills            | 9.3 km / 14.9 min  | [Open](https://maps.apple.com/?saddr=51.03746,-114.05193&daddr=51.06534,-114.13308&dirflg=d)     | REQUIRED     | [Open](https://www.google.com/maps/dir/?api=1&origin=51.03746,-114.05193&destination=51.06534,-114.13308&travelmode=driving)     | REQUIRED      | REQUIRED                            | Not run |

## Reproduce

Against the production API:

```sh
NAVOSS_API_URL=https://navoss-api.yassin.app \
	corepack pnpm --filter @navoss/api test:routes:live
```

The executable cases live in `apps/api/scripts/route-quality-cases.json`; the gate is `apps/api/scripts/route-quality.mjs`.
