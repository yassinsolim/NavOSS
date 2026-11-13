# Surfaces: routing

| Surface             | Source of truth                                                                                                        | Reference             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Phone app           | `apps/mobile/src` (theme, ui, `features/map`, `features/navigation`)                                                   | `surfaces-phone.md`   |
| CarPlay             | `apps/mobile/carplay/ios/*` (scenes, map view controller), Swift `Core/CarPlay*.swift`, `docs/architecture/carplay.md` | `surfaces-carplay.md` |
| Website             | `apps/site/src`, `apps/site/site.json` (CSP), `apps/site/scripts`, `apps/site/test`                                    | `surfaces-website.md` |
| Spoken guidance     | `Core/NavigationSpeechPlanner.swift` (native); wording rules in `copy.md`                                              | `copy.md`             |
| Store and docs text | `docs/release/app-store-metadata.md`, `docs/privacy.md`, `docs/support.md`                                             | `copy.md`             |

One navigation session backs all of them: the native `NavOSSNavigation` module owns the route, matching, speech and state; the phone, CarPlay main display, Dashboard and cluster are consumers. A design decision that changes what guidance says must change it for every consumer.
