import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isRetryableMaestroInfrastructureFailure,
  readMaestroDebugOutput,
} from '../scripts/maestro-retry.mjs';

describe('Maestro retry policy', () => {
  it.each([
    'Accessibility failed with kAXErrorInvalidUIElement',
    'AXErrorInvalidUIElement while reading hierarchy',
    'The operation could not be completed. AXError error -25202.',
    'xcuitest.installer.LocalXCTestInstaller$IOSDriverTimeoutException',
    'iOS driver not ready in time, consider increasing timeout',
    'UnknownFailure(errorResponse=Request for viewHierarchy failed, code: 500, body: )',
    'java.net.ConnectException: Failed to connect to /127.0.0.1:54452',
  ])('retries a known simulator accessibility failure: %s', (output) => {
    expect(isRetryableMaestroInfrastructureFailure(output)).toBe(true);
  });

  it.each([
    'Element not found: text: Start',
    'Assertion failed: route preview is not visible',
    'Timed out after 120000 ms',
    'Application org.navoss.mobile crashed',
  ])('does not retry an application or assertion failure: %s', (output) => {
    expect(isRetryableMaestroInfrastructureFailure(output)).toBe(false);
  });

  it('reads Maestro logs from its nested debug-output directory', async () => {
    const debugPath = await mkdtemp(join(tmpdir(), 'navoss-maestro-debug-'));
    const runPath = join(debugPath, '.maestro', 'tests', 'run-id');
    await mkdir(runPath, { recursive: true });
    await writeFile(
      join(runPath, 'maestro.log'),
      'java.net.ConnectException: Failed to connect to /127.0.0.1:54452\n',
    );

    try {
      const output = await readMaestroDebugOutput(debugPath);
      expect(isRetryableMaestroInfrastructureFailure(output)).toBe(true);
    } finally {
      await rm(debugPath, { force: true, recursive: true });
    }
  });
});
