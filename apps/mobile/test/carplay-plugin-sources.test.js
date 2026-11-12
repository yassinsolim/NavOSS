import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { sourceFiles } = require('../plugins/with-navoss-carplay.cjs');

describe('CarPlay config plugin sources', () => {
  // A Swift file under carplay/ios that the plugin does not copy never reaches the app target, so
  // its types silently vanish from CarPlay builds (or the build fails far from the cause).
  it('copies every CarPlay Swift source and nothing that does not exist', () => {
    const onDisk = readdirSync(resolve(import.meta.dirname, '..', 'carplay', 'ios'))
      .filter((name) => name.endsWith('.swift'))
      .sort();
    expect([...sourceFiles].sort()).toEqual(onDisk);
  });
});
