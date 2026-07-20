import { describe, expect, it } from 'vitest';

import { maneuverDirection } from '../src/features/navigation/maneuver-direction.js';

describe('maneuver direction', () => {
  it('classifies turns from normalized instructions', () => {
    expect(maneuverDirection('turn', 'Turn left onto Macleod Trail SE.')).toBe('left');
    expect(maneuverDirection('turn', 'Turn right onto Airport Road NE.')).toBe('right');
  });

  it('prioritizes U-turns and roundabouts', () => {
    expect(maneuverDirection('turn', 'Make a U-turn.')).toBe('uturn');
    expect(maneuverDirection('rotary', 'Enter the roundabout.')).toBe('roundabout');
  });

  it('recognizes arrival and defaults to straight', () => {
    expect(maneuverDirection('arrive', 'You have arrived at your destination.')).toBe('arrive');
    expect(maneuverDirection('depart', 'Head north.')).toBe('straight');
  });
});
