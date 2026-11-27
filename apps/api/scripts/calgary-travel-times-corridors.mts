// Places every corridor of the City of Calgary travel-times table on a Valhalla graph with the
// same code the API runs at startup, and reports each check: length against the table, share of
// the length on the expected roads, and the free-flow speed the baseline implies.
//
//   VALHALLA_BASE_URL=http://127.0.0.1:8016/ corepack pnpm --filter @navoss/api travel-times:corridors
//
// Exits 1 when a corridor fails for any reason other than a missing baseline. Only the table's own
// coordinates are sent to Valhalla.

import { CORRIDOR_TABLE } from '../src/calgary-travel-times/corridors.ts';
import { createCorridorPlacer, impliedFreeFlowKph } from '../src/calgary-travel-times/placement.ts';
import { createValhallaMapMatcher } from '../src/traffic/map-matcher.ts';

const base = process.env.VALHALLA_BASE_URL ?? 'http://127.0.0.1:8016/';
const mapMatcher = createValhallaMapMatcher({
  endpoint: new URL('trace_attributes', base).toString(),
});
const placer = createCorridorPlacer({
  mapMatcher,
  routeEndpoint: new URL('route', base).toString(),
});

let placed = 0;
let failed = 0;
for (const corridor of CORRIDOR_TABLE.corridors) {
  const outcome = await placer.place(corridor);
  const length = outcome.lengthMeters;
  const kph =
    length === undefined || corridor.baselineMinutes === null
      ? undefined
      : impliedFreeFlowKph(length, corridor.baselineMinutes);
  const status = outcome.status === 'placed' ? 'placed' : `off (${outcome.reason})`;
  if (outcome.status === 'placed') placed += 1;
  else if (outcome.reason !== 'no-baseline') failed += 1;
  console.log(
    [
      corridor.segment.padEnd(64),
      `${((length ?? 0) / 1_000).toFixed(2).padStart(6)} km`,
      `expected ${(corridor.expectedMeters / 1_000).toFixed(2).padStart(6)} km`,
      `roads ${(outcome.roadShare ?? 0).toFixed(2)}`,
      `baseline ${String(corridor.baselineMinutes ?? '-').padStart(2)} min`,
      `free flow ${kph === undefined ? '  -' : kph.toFixed(0).padStart(3)} km/h`,
      outcome.status === 'placed' ? `${String(outcome.corridor.pieces.length)} edges` : '',
      status,
    ].join('  '),
  );
}
for (const entry of CORRIDOR_TABLE.leftOut) {
  console.log(`${entry.segment.padEnd(64)}  left out: ${entry.reason}`);
}
console.log(
  `${String(placed)} placed, ${String(CORRIDOR_TABLE.corridors.length - placed)} off, ${String(CORRIDOR_TABLE.leftOut.length)} left out of ${String(CORRIDOR_TABLE.corridors.length + CORRIDOR_TABLE.leftOut.length)} labels.`,
);
process.exit(failed > 0 ? 1 : 0);
