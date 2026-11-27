// Refreshes the free-flow baselines of the City of Calgary travel-times corridor table from
// recordings of the public feed (`aeb8-fh2w`). Each recording line group is one fetch:
// `{"fetched": "<UTC>", "rows": [<feed rows>]}`; objects may span several lines.
//
//   ssh navoss-prod 'cat ~/calgary-travel-times/*.jsonl' > /tmp/travel-times.jsonl
//   corepack pnpm --filter @navoss/api travel-times:baselines /tmp/travel-times.jsonl
//
// A baseline is the lower median of a corridor's distinct quiet-hour readings (Calgary wall time
// 22:00 to 05:00, each `last_update` counted once). A corridor with fewer than two such readings
// keeps no baseline and is never applied. The recordings hold public data only.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { z } from 'zod/v4';

import { CorridorTableSchema } from '../src/calgary-travel-times/corridors.ts';
import { calgaryWallTimeToUtcMs } from '../src/calgary-travel-times/feed.ts';

const QUIET_FROM_HOUR = 22;
const QUIET_TO_HOUR = 5;
const MIN_READINGS = 2;
const RecordedRowSchema = z.object({
  last_update: z.string(),
  road_segment: z.string(),
  travel_time_mins: z.union([z.string(), z.number()]),
});

const tablePath = fileURLToPath(
  new URL('../src/calgary-travel-times/corridors.json', import.meta.url),
);
const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  console.error('usage: calgary-travel-times-baselines <recording.jsonl>...');
  process.exit(2);
}

/** Splits concatenated JSON objects that each start a line with `{"fetched"`. */
function records(text: string): unknown[] {
  return text
    .split(/^(?=\{"fetched")/mu)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== '')
    .map((chunk) => JSON.parse(chunk) as unknown);
}

const readings = new Map<string, Map<string, number>>();
let snapshots = 0;
let firstMs = Number.POSITIVE_INFINITY;
let lastMs = Number.NEGATIVE_INFINITY;
for (const input of inputs) {
  for (const record of records(readFileSync(input, 'utf8'))) {
    if (record === null || typeof record !== 'object' || !('rows' in record)) continue;
    const rows = record.rows;
    if (!Array.isArray(rows)) continue;
    snapshots += 1;
    for (const row of rows) {
      const parsed = RecordedRowSchema.safeParse(row);
      if (!parsed.success) continue;
      const { last_update: wall, road_segment: segment } = parsed.data;
      const minutes = Number(parsed.data.travel_time_mins);
      if (!Number.isInteger(minutes) || minutes < 1) continue;
      const utc = calgaryWallTimeToUtcMs(wall);
      if (utc === undefined) continue;
      firstMs = Math.min(firstMs, utc);
      lastMs = Math.max(lastMs, utc);
      const hour = Number(wall.slice(11, 13));
      if (hour < QUIET_FROM_HOUR && hour >= QUIET_TO_HOUR) continue;
      const values = readings.get(segment) ?? new Map<string, number>();
      values.set(wall, minutes);
      readings.set(segment, values);
    }
  }
}

const table = CorridorTableSchema.parse(JSON.parse(readFileSync(tablePath, 'utf8')));
let withBaseline = 0;
for (const corridor of table.corridors) {
  const values = [...(readings.get(corridor.segment)?.values() ?? [])].sort((a, b) => a - b);
  corridor.baselineMinutes =
    values.length >= MIN_READINGS ? (values[Math.floor((values.length - 1) / 2)] ?? null) : null;
  if (corridor.baselineMinutes !== null) withBaseline += 1;
  console.log(
    `${corridor.segment.padEnd(64)} readings ${String(values.length).padStart(3)} baseline ${String(corridor.baselineMinutes)}`,
  );
}
table.baselines = {
  method: `Lower median of distinct readings between ${String(QUIET_FROM_HOUR)}:00 and 0${String(QUIET_TO_HOUR)}:00 Calgary time, at least ${String(MIN_READINGS)} per corridor`,
  recordedFrom: Number.isFinite(firstMs) ? new Date(firstMs).toISOString() : null,
  recordedTo: Number.isFinite(lastMs) ? new Date(lastMs).toISOString() : null,
  snapshots,
};
writeFileSync(tablePath, `${JSON.stringify(CorridorTableSchema.parse(table), null, 2)}\n`);
execFileSync('corepack', ['pnpm', 'exec', 'prettier', '--write', tablePath], { stdio: 'inherit' });
console.log(
  `${String(withBaseline)} of ${String(table.corridors.length)} corridors have a baseline.`,
);
