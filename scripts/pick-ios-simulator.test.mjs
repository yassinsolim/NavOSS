import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const picker = join(dirname(fileURLToPath(import.meta.url)), 'pick-ios-simulator.py');

function pick(runtimes) {
  return spawnSync('python3', [picker], {
    encoding: 'utf8',
    input: JSON.stringify({ runtimes }),
  });
}

test('picks the newest Pro Max from the newest iOS runtime regardless of list order', () => {
  const result = pick([
    {
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-25-4',
      isAvailable: true,
      supportedDeviceTypes: [
        {
          identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max',
          name: 'iPhone 16 Pro Max',
        },
      ],
      version: '25.4',
    },
    {
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
      isAvailable: true,
      supportedDeviceTypes: [
        {
          identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max',
          name: 'iPhone 17 Pro Max',
        },
        {
          identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
          name: 'iPhone 17 Pro',
        },
        {
          identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-11-Pro-Max',
          name: 'iPhone 11 Pro Max',
        },
      ],
      version: '26.5',
    },
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trim(),
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5 com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max',
  );
});
