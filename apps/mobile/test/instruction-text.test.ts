import { describe, expect, it } from 'vitest';

import {
  presentedInstruction,
  readableRoadNames,
} from '../src/features/navigation/instruction-text.js';

describe('route step text', () => {
  it('reads a Valhalla highway reference joined to a street name as two names', () => {
    // Recorded from production /v1/routes, 2026-11-13 (Highway 1 / 16 Avenue NW in Calgary).
    expect(presentedInstruction('Turn left onto 1/16 Avenue NW.', 'turn')).toBe(
      'Turn left onto Highway 1 / 16 Avenue NW.',
    );
    expect(readableRoadNames('Keep right to take Deerfoot Trail/2 toward Airport.')).toBe(
      'Keep right to take Deerfoot Trail / Highway 2 toward Airport.',
    );
    expect(readableRoadNames('Turn right onto 1A/Crowchild Trail NW.')).toBe(
      'Turn right onto Highway 1A / Crowchild Trail NW.',
    );
    expect(readableRoadNames('Turn left onto Macleod Trail/Highway 2A.')).toBe(
      'Turn left onto Macleod Trail / Highway 2A.',
    );
  });

  it('leaves single names, spaced slashes and already readable text alone', () => {
    for (const text of [
      'Turn left onto Macleod Trail SE.',
      'Take exit 248 toward Calgary.',
      'Turn left onto Highway 1 / 16 Avenue NW.',
      'Continue on Highway 2/Deerfoot Trail.'.replace('2/', '2 / '),
    ]) {
      expect(readableRoadNames(text)).toBe(text);
      expect(readableRoadNames(readableRoadNames(text))).toBe(text);
    }
    expect(readableRoadNames('Continue on Highway 2/Deerfoot Trail.')).toBe(
      'Continue on Highway 2 / Deerfoot Trail.',
    );
  });

  it('does not say arrived while the destination is still ahead', () => {
    expect(presentedInstruction('You have arrived at your destination.', 'arrive')).toBe(
      'Your destination is ahead.',
    );
    expect(presentedInstruction('Your destination is on the right.', 'arrive')).toBe(
      'Your destination is on the right.',
    );
  });
});
