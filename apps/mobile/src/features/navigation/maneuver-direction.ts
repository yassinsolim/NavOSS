export type ManeuverDirection = 'arrive' | 'left' | 'right' | 'roundabout' | 'straight' | 'uturn';

export function maneuverDirection(maneuverType: string, instruction: string): ManeuverDirection {
  const normalized = `${maneuverType} ${instruction}`.toLowerCase();

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
