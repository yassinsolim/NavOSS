export interface ManeuverText {
  /** The action, short enough to read in a glance: "Keep right", "Take exit 266". */
  primary: string;
  /** Where it leads: the road, and any "toward" destination. Empty when there is nothing to add. */
  secondary: string;
}

const CONNECTORS = /\s+(?:to take|onto|toward|towards)\s+/i;

/**
 * Splits a routing instruction into the action and where it leads, so the maneuver banner can
 * set the action large and never truncate it. "Keep right to take Barlow Trail NE toward
 * Calgary International Airport." becomes "Keep right" over "Barlow Trail NE toward Calgary
 * International Airport". An instruction with no destination part keeps its full text and takes
 * the road name, when that adds something, as its second line.
 */
export function maneuverText(instruction: string, roadName: string): ManeuverText {
  const sentence = instruction.trim().replace(/\.$/, '');
  const match = CONNECTORS.exec(sentence);
  if (match === null || match.index === 0) {
    const road = roadName.trim();
    return {
      primary: sentence,
      secondary: sentence.toLowerCase().includes(road.toLowerCase()) ? '' : road,
    };
  }
  return {
    primary: sentence.slice(0, match.index),
    secondary: sentence.slice(match.index + match[0].length),
  };
}
