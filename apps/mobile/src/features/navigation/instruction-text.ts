/**
 * Valhalla writes a road with several names as "1/16 Avenue NW": the bare route number of
 * Highway 1 joined to the street name. Read aloud or at a glance that is "one sixteenth". A bare
 * number on either side of such a slash is a highway reference and is shown as "Highway 1", and
 * the names are spaced apart: "Highway 1 / 16 Avenue NW". Already spaced text is left alone, so
 * this is safe to apply more than once (the native core applies the same rule).
 */
export function readableRoadNames(text: string): string {
  return text
    .replace(/(?<![\w/])(?<!(?:Highway|Hwy|Route) )(\d{1,3}[A-Z]?)\/(?=\S)/g, 'Highway $1 / ')
    .replace(/(?<=\S)\/(\d{1,3}[A-Z]?)(?![\w/])/g, ' / Highway $1')
    .replace(/(?<=\S)\/(?=\S)/g, ' / ');
}

const ARRIVED = /^(?:you have|you've) arrived\b/i;

/**
 * The text a driver sees for a route step. Valhalla's arrival step says "You have arrived at your
 * destination." although it is shown from the previous maneuver on, often kilometres before the
 * destination; while it is still ahead it reads "Your destination is ahead." The arrived state
 * has its own card and prompt.
 */
export function presentedInstruction(instruction: string, maneuverType: string): string {
  if (maneuverType.toLowerCase() === 'arrive' && ARRIVED.test(instruction.trim())) {
    return 'Your destination is ahead.';
  }
  return readableRoadNames(instruction);
}
