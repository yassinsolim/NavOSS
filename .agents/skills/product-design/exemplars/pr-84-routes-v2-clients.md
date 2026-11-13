# PR #84: `/v2/routes` clients with lanes, signposts and through rejoin (merged)

**Decided**

- Optional data is decoded leniently: a malformed optional field is dropped on its own and never fails the route. Unknown and unlimited speed limits show no number and never warn.
- Lanes and exit signs show in the maneuver banner's `children` seam only when the data is present and trustworthy. Congestion draws and the community attribution appears only on a route that traffic actually observed; otherwise the line says exactly "No live traffic".
- The speech planner says what the signs say only when the route carries it ("Take exit 248 toward Banff"); it never reads absent data. v2 and v1 spoken instructions describe different steps; v1 is shifted on decode and tests show both speak identically.
- Coverage copy names what the server declares; the generic search label stopped saying "Calgary".
- Real recorded responses are the test fixtures, not hand-written ones (`apps/mobile/test/fixtures/routes-v2/`).

**Mistakes caught**

- The first version failed against production: the deployed `/v2/config` advertised `/v1/routes` and "Calgary and Kelowna service areas", and the strict schema rejected it. Fix: lenient config parsing, with compatibility tests built from recorded production and new-server fixtures. Lesson: test against the deployed server's real answers, not only the new server's.
- Instruction text shrank to unreadable size next to the lane strip, and the exit sign truncated at the largest text size. Both were found on screenshots and fixed.
- Ramp symbols drew straight from bearings (205 to 206 degrees); fixed after the CarPlay run and not re-rendered.

**Known issue left**: switching to the largest text size during a trip leaves the banner laid out at the old size until relaunch (`coverage-gaps.md`).
