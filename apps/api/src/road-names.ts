/**
 * Road names as drivers see and hear them. Valhalla gives a road every OSM name it carries: its
 * route number, its posted name, then official and translated names ("Highway 401 Express",
 * "Macdonald-Cartier Freeway"; "Wellington Street", "rue Wellington"). The phone banner, the
 * CarPlay road pill and the route card's "via" each show one road name in one line, so:
 *
 * - a road's name is its first posted name (the OSM `name`, which is what the street sign says,
 *   English first on Ontario's bilingual signs), or its route number when it has no name;
 * - written instructions keep a route number beside that name only when the name does not
 *   already carry it ("15/Autoroute des Laurentides", but "Highway 401 Express");
 * - spoken instructions say the name only.
 *
 * Other names are dropped. Text only: no field is added or removed.
 */
export interface RoadName {
  isRouteNumber: boolean;
  value: string;
}

export function primaryRoadName(names: readonly RoadName[]): string {
  const posted = names.find((name) => !name.isRouteNumber && name.value.trim() !== '');
  return (posted ?? names.find((name) => name.value.trim() !== ''))?.value.trim() ?? '';
}

function writtenRoadName(names: readonly RoadName[]): string {
  const primary = primaryRoadName(names);
  const route = names.find((name) => name.isRouteNumber && name.value.trim() !== '');
  if (route === undefined || route.value.trim() === primary) return primary;
  const number = /\d+[A-Z]?/u.exec(route.value)?.[0];
  const carried =
    number !== undefined && new RegExp(`(?<![\\p{L}\\p{N}])${number}(?![\\p{L}\\p{N}])`, 'u');
  return carried !== false && carried.test(primary) ? primary : `${route.value.trim()}/${primary}`;
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Replaces a run of two or more of one road's names, joined as Valhalla joins them ("/" in
 * written text, ", " in spoken text), with what drivers are shown or told.
 */
function collapseNameRuns(
  text: string,
  roads: readonly (readonly RoadName[])[],
  separator: '/' | ', ',
): string {
  let collapsed = text;
  for (const names of roads) {
    const values = [
      ...new Set(names.map((name) => name.value.trim()).filter((value) => value !== '')),
    ];
    if (values.length < 2) continue;
    const alternative = values
      .sort((left, right) => right.length - left.length)
      .map(escaped)
      .join('|');
    const run = new RegExp(
      `(?<![\\p{L}\\p{N}])(?:${alternative})(?:${escaped(separator)}(?:${alternative}))+(?![\\p{L}\\p{N}])`,
      'gu',
    );
    collapsed = collapsed.replace(run, () =>
      separator === '/' ? writtenRoadName(names) : primaryRoadName(names),
    );
  }
  return collapsed;
}

export function writtenInstruction(text: string, roads: readonly (readonly RoadName[])[]): string {
  return collapseNameRuns(text, roads, '/');
}

// Valhalla chains a following cue as "<cue>. Then <Cue>", keeping the second cue's capital.
const CHAINED_CUE =
  /(?<=\. Then )(Arrive|Bear|Continue|Drive|Enter|Exit|Go|Head|Keep|Make|Merge|Stay|Take|Turn|You|Your)\b/gu;

export function spokenInstruction(text: string, roads: readonly (readonly RoadName[])[]): string {
  return collapseNameRuns(text, roads, ', ').replace(CHAINED_CUE, (word) =>
    word.toLocaleLowerCase('en-CA'),
  );
}

/** The legacy OSRM-format step name joins a road's names with "; ". */
export function primaryLegacyRoadName(name: string): string {
  return name.split(';')[0]?.trim() ?? '';
}
