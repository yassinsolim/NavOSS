import { describe, expect, it } from 'vitest';

import { maneuverText } from '../src/features/navigation/maneuver-text.js';

describe('maneuver text', () => {
  it('sets the action apart from where it leads', () => {
    expect(
      maneuverText(
        'Keep right to take Barlow Trail NE toward Calgary International Airport.',
        'Barlow Trail NE',
      ),
    ).toEqual({
      primary: 'Keep right',
      secondary: 'Barlow Trail NE toward Calgary International Airport',
    });
    expect(maneuverText('Turn left onto Macleod Trail SE.', 'Macleod Trail SE')).toEqual({
      primary: 'Turn left',
      secondary: 'Macleod Trail SE',
    });
    expect(
      maneuverText(
        'Take exit 266 onto Airport Trail toward Calgary International Airport.',
        'Deerfoot Trail NE',
      ),
    ).toEqual({
      primary: 'Take exit 266',
      secondary: 'Airport Trail toward Calgary International Airport',
    });
  });

  it('keeps an instruction whole when it names no destination, and adds the road', () => {
    expect(maneuverText('Turn right.', '9 Avenue SW')).toEqual({
      primary: 'Turn right',
      secondary: '9 Avenue SW',
    });
    expect(maneuverText('You have arrived at your destination.', '')).toEqual({
      primary: 'You have arrived at your destination',
      secondary: '',
    });
  });

  it('does not repeat a road the instruction already names', () => {
    expect(maneuverText('Continue on Deerfoot Trail NE.', 'Deerfoot Trail NE')).toEqual({
      primary: 'Continue on Deerfoot Trail NE',
      secondary: '',
    });
  });

  it('never loses words: both lines together still carry the whole instruction', () => {
    const instruction = 'Keep left toward Departures/Rental Car Return/Hotels/Départs.';
    const { primary, secondary } = maneuverText(instruction, 'Airport Road NE');
    expect(primary).toBe('Keep left');
    expect(secondary).toBe('Departures/Rental Car Return/Hotels/Départs');
  });
});
