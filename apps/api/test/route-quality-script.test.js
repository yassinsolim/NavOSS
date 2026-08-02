import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveInputPath } from '../scripts/resolve-input-path.mjs';

describe('route-quality script paths', () => {
  it('falls back from the root invocation directory to the package working directory', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'navoss-route-quality-path-'));
    const repositoryRoot = join(fixture, 'repository');
    const packageRoot = join(repositoryRoot, 'apps', 'api');
    const casesPath = join(packageRoot, 'scripts', 'route-quality-calgary-50.json');
    await mkdir(join(packageRoot, 'scripts'), { recursive: true });
    await writeFile(casesPath, '{}\n');

    try {
      await expect(
        resolveInputPath('./scripts/route-quality-calgary-50.json', {
          invocationDirectory: repositoryRoot,
          workingDirectory: packageRoot,
        }),
      ).resolves.toBe(casesPath);
    } finally {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it('prefers an explicit path relative to the invocation directory', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'navoss-route-quality-path-'));
    const casesPath = join(fixture, 'apps', 'api', 'scripts', 'route-quality-calgary-50.json');
    await mkdir(join(fixture, 'apps', 'api', 'scripts'), { recursive: true });
    await writeFile(casesPath, '{}\n');

    try {
      await expect(
        resolveInputPath('./apps/api/scripts/route-quality-calgary-50.json', {
          invocationDirectory: fixture,
          workingDirectory: join(fixture, 'apps', 'api'),
        }),
      ).resolves.toBe(casesPath);
    } finally {
      await rm(fixture, { force: true, recursive: true });
    }
  });
});
