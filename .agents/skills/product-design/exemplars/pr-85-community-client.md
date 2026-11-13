# PR #85: native community reports and traffic client (merged)

**Decided**

- Nothing is sent until the driver turns on **Share road reports** (off by default); within 400 m of saved Home or Work or a trip's start, destination or stops a report stays private unless confirmed. The CarPlay grid title says "Report (private)" or "Report to drivers" before a type is chosen.
- Traffic sharing is off by default, only during turn-by-turn with real location fixes, and the client trims 400 m at both ends and around stops on the device (the server cannot check this).
- Old-server behaviour was designed first: against a server that answers 404 for `/v2/community/*` and `/v2/traffic/*` the app makes one `/v2/config` and one `/v2/traffic/status` request, no registration, no challenge, no markers; submit refuses locally and CarPlay shows "Not available yet". Verified on the simulator through a write-blocking proxy to the real production API.
- Failures map to plain messages ("No connection. Try again in a moment."); the JS bridge returns typed results, never codes to show.
- Still-there is asked only after passing a report, never near a turn, never over another alert; letting it disappear sends nothing.

**Mistakes caught by independent review (and the tests that now fail without each fix)**

- A report labelled private could be sent publicly, and there was no home guard: added the consent switch and the private-place guard.
- Improving GPS accuracy let parked jitter "earn" path distance and release a trip's protected end.
- Concurrent asserted writes could arrive out of counter order; the transaction is serialised per installation.
- The CarPlay Still-there alert stayed up after a maneuver came near (not covered by a test; reviewed in code only).
- Client data had to match the server byte for byte; it was proven with 97 vectors generated from the TypeScript helper, because `String(format:"%.6f")` differs from `toFixed(6)` on exact ties.

**Left unverified**: real App Attest on a physical device, interactive CarPlay, arrival ending a trip's sharing in the simulator.

**Lesson**: the tests the author wrote shared the author's assumptions; the review found the problems. Independent vectors and mutation checks (remove the fix, watch the test fail) are required for privacy fixes (`AGENTS.md`).
