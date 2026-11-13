export type ManeuverDirection =
  | 'arrive'
  | 'left'
  | 'right'
  | 'roundabout'
  | 'slight-left'
  | 'slight-right'
  | 'straight'
  | 'uturn';

/**
 * The arrow for a maneuver. A `/v2/routes` step states its direction (`maneuverModifier`); that
 * wins over reading the instruction, which cannot tell "Take exit 248" from going straight and
 * reads "Turn right onto Left Bank Road" as a left turn.
 */
export function maneuverDirection(
  maneuverType: string,
  instruction: string,
  maneuverModifier?: string,
): ManeuverDirection {
  const normalized = `${maneuverType} ${instruction}`.toLowerCase();

  if (maneuverType.toLowerCase() === 'arrive') {
    return 'arrive';
  }
  if (/roundabout|rotary/.test(maneuverType.toLowerCase())) {
    return 'roundabout';
  }
  switch (maneuverModifier) {
    case 'uturn':
      return 'uturn';
    case 'sharp left':
    case 'left':
      return 'left';
    case 'slight left':
      return 'slight-left';
    case 'sharp right':
    case 'right':
      return 'right';
    case 'slight right':
      return 'slight-right';
    case 'straight':
      return 'straight';
    default:
      break;
  }

  if (/u[ -]?turn/.test(normalized)) {
    return 'uturn';
  }
  if (normalized.includes('roundabout') || normalized.includes('rotary')) {
    return 'roundabout';
  }
  if (normalized.includes('left')) {
    return 'left';
  }
  if (normalized.includes('right')) {
    return 'right';
  }
  if (normalized.includes('arrive') || normalized.includes('destination')) {
    return 'arrive';
  }

  return 'straight';
}
