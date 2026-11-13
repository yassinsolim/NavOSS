import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildVectors, vectorsPath } from '../scripts/generate-community-assertion-vectors.mjs';

describe('App Attest client-data vectors shared with the Swift client', () => {
  it('match what the contract helper produces today', () => {
    const committed = JSON.parse(readFileSync(vectorsPath, 'utf8'));
    // JSON drops undefined headings and writes -0 as 0; the fixture records -0 separately.
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildVectors())));
  });

  it('cover the rounding cases where printf and toFixed disagree', () => {
    const vectors = buildVectors();
    expect(vectors.some((vector) => vector.clientData.includes('\n51.007813\n'))).toBe(true);
    expect(vectors.some((vector) => vector.clientData.includes('\n0.000000\n0.000000\n'))).toBe(
      true,
    );
  });
});
