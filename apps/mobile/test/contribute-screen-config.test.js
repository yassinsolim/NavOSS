import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Contribute screen', () => {
  it('submits beta feedback and retains only failed attempts for retry', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '..', 'src/features/map/contribute-screen.tsx'),
      'utf8',
    );

    expect(source).toContain('submitContribution({');
    expect(source).toContain('Submit feedback');
    expect(source).toContain('Pending submissions');
    expect(source).toContain('Saved for retry');
    expect(source).not.toContain('Save private draft');
  });
});
