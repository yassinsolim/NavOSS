#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const mobileDirectory = resolve(scriptDirectory, '..');
const rootDirectory = resolve(mobileDirectory, '../..');
const finalArtifacts = resolve(
  rootDirectory,
  process.env.NAVOSS_ARTIFACTS_DIR ?? 'artifacts/navigation-validation',
);
const temporaryArtifacts = `${finalArtifacts}.tmp`;
const logsDirectory = join(temporaryArtifacts, 'logs');
const screenshotsDirectory = join(temporaryArtifacts, 'screenshots');
const pixelsDirectory = join(temporaryArtifacts, 'pixels');
const simulatorName = process.env.NAVOSS_SIMULATOR_NAME ?? 'NavOSS iPhone 15 Pro Max';
const developerDirectory =
  process.env.DEVELOPER_DIR ?? '/Applications/Xcode.app/Contents/Developer';
const carPlayOnly = process.argv.includes('--carplay-only');
const phoneOnly = process.argv.includes('--phone-only');
const reuseBuild = process.argv.includes('--reuse-build');
const phases = [];
const failures = [];
const children = new Set();
const startedAt = new Date();
let simulatorId;
let appPath;

const environment = {
  ...process.env,
  DEVELOPER_DIR: developerDirectory,
  EXPO_PUBLIC_API_URL: 'http://127.0.0.1:3001',
  MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true',
  MAESTRO_CLI_NO_ANALYTICS: '1',
  NAVOSS_API_URL: 'http://127.0.0.1:3001',
  NAVOSS_CARPLAY_ENABLED: '1',
  NAVOSS_CARPLAY_ENTITLEMENT_ENABLED: '0',
  NAVOSS_GOOGLE_PLACES_ENABLED: '0',
  NAVOSS_SIMULATOR_NAME: simulatorName,
  PATH: `${process.env.PATH ?? ''}:${process.env.HOME}/.maestro/bin`,
};

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function commandString(command, args) {
  return [command, ...args].map((value) => JSON.stringify(value)).join(' ');
}

function terminateProcessGroup(child, signal = 'SIGTERM') {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function run(command, args, options = {}) {
  const logPath = options.logPath;
  const log = logPath === undefined ? undefined : createWriteStream(logPath, { flags: 'a' });
  const started = Date.now();
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? rootDirectory,
      detached: true,
      env: { ...environment, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      terminateProcessGroup(child);
      rejectRun(
        new Error(
          `Timed out after ${String(options.timeoutMs ?? 300_000)} ms: ${commandString(command, args)}`,
        ),
      );
    }, options.timeoutMs ?? 300_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      log?.write(chunk);
      if (options.echo) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      log?.write(chunk);
      if (options.echo) process.stderr.write(chunk);
    });
    child.on('error', rejectRun);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      log?.end();
      const result = { code: code ?? 1, durationMs: Date.now() - started, signal, stderr, stdout };
      if (code === 0) resolveRun(result);
      else
        rejectRun(
          Object.assign(
            new Error(
              `${commandString(command, args)} exited ${String(code)}${signal ? ` (${signal})` : ''}`,
            ),
            { result },
          ),
        );
    });
  });
}

function startService(name, command, args, cwd, env = {}) {
  const log = createWriteStream(join(logsDirectory, `${name}.log`), { flags: 'a' });
  const child = spawn(command, args, {
    cwd,
    detached: true,
    env: { ...environment, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on('close', () => {
    children.delete(child);
    log.end();
  });
  return child;
}

async function phase(name, action, { critical = false } = {}) {
  const entry = { name, startedAt: new Date().toISOString(), status: 'running' };
  phases.push(entry);
  const phaseStarted = Date.now();
  try {
    await action();
    entry.status = 'passed';
  } catch (error) {
    entry.status = 'failed';
    entry.error = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${entry.error}`);
    if (critical) throw error;
  } finally {
    entry.durationMs = Date.now() - phaseStarted;
  }
}

async function waitForUrl(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(500);
  }
  throw new Error(`Service did not become ready: ${url}`);
}

function findSimulator() {
  const result = spawnSync('xcrun', ['simctl', 'list', '--json', 'devices', 'available'], {
    encoding: 'utf8',
    env: environment,
  });
  if (result.status !== 0) throw new Error(result.stderr || 'simctl list failed');
  const devices = Object.values(JSON.parse(result.stdout).devices).flat();
  const simulator = devices.find((device) => device.isAvailable && device.name === simulatorName);
  if (simulator === undefined) throw new Error(`Simulator not found: ${simulatorName}`);
  return simulator.udid;
}

async function screenshot(name) {
  const destination = join(screenshotsDirectory, `${name}.png`);
  await run('xcrun', ['simctl', 'io', simulatorId, 'screenshot', destination], {
    logPath: join(logsDirectory, 'screenshots.log'),
    timeoutMs: 30_000,
  });
  return destination;
}

async function captureCarPlayScenario(name, scenario, appearance) {
  await run('xcrun', ['simctl', 'terminate', simulatorId, 'org.navoss.mobile'], {
    logPath: join(logsDirectory, 'carplay.log'),
    timeoutMs: 15_000,
  }).catch(() => undefined);
  await run(
    'xcrun',
    ['simctl', 'launch', '--terminate-running-process', simulatorId, 'org.navoss.mobile'],
    {
      env: {
        SIMCTL_CHILD_NAVOSS_CARPLAY_VISUAL_APPEARANCE: appearance,
        SIMCTL_CHILD_NAVOSS_CARPLAY_VISUAL_SCENARIO: scenario,
      },
      logPath: join(logsDirectory, 'carplay.log'),
      timeoutMs: 30_000,
    },
  );
  await delay(5_000);
  await screenshot(name);
}

async function sha256(path) {
  const data = await readFile(path);
  return createHash('sha256').update(data).digest('hex');
}

async function cleanup() {
  if (simulatorId !== undefined) {
    spawnSync('xcrun', ['simctl', 'location', simulatorId, 'clear'], { env: environment });
    spawnSync('xcrun', ['simctl', 'terminate', simulatorId, 'org.navoss.mobile'], {
      env: environment,
    });
  }
  for (const child of children) terminateProcessGroup(child);
}

await rm(temporaryArtifacts, { force: true, recursive: true });
await mkdir(logsDirectory, { recursive: true });
await mkdir(screenshotsDirectory, { recursive: true });
await mkdir(pixelsDirectory, { recursive: true });

try {
  await phase(
    'preflight',
    async () => {
      if (Number(process.versions.node.split('.')[0]) !== 24) {
        throw new Error(`Node 24 is required; found ${process.versions.node}`);
      }
      for (const command of ['xcodebuild', 'xcrun', 'corepack', 'maestro', 'swift']) {
        const result = spawnSync('sh', ['-c', `command -v ${command}`], {
          encoding: 'utf8',
          env: environment,
        });
        if (result.status !== 0) throw new Error(`Missing command: ${command}`);
      }
      simulatorId = findSimulator();
      await writeFile(
        join(temporaryArtifacts, 'environment.json'),
        `${JSON.stringify(
          {
            developerDirectory,
            node: process.version,
            simulatorId,
            simulatorName,
            xcode: spawnSync('xcodebuild', ['-version'], {
              encoding: 'utf8',
              env: environment,
            }).stdout.trim(),
          },
          null,
          2,
        )}\n`,
      );
    },
    { critical: true },
  );

  if (!phoneOnly) {
    await phase('native-tests', async () => {
      await run('corepack', ['pnpm', '--filter', '@navoss/mobile', 'test:native:ios'], {
        logPath: join(logsDirectory, 'native-tests.log'),
        timeoutMs: 180_000,
      });
    });
  }

  await phase(
    'build-simulator-app',
    async () => {
      if (reuseBuild) {
        const installedApp = spawnSync(
          'xcrun',
          ['simctl', 'get_app_container', simulatorId, 'org.navoss.mobile', 'app'],
          { encoding: 'utf8', env: environment },
        );
        appPath = installedApp.stdout.trim();
        if (installedApp.status !== 0 || !existsSync(appPath)) {
          throw new Error('Cannot reuse build because NavOSS is not installed on the simulator.');
        }
        return;
      }
      await run(
        'corepack',
        ['pnpm', 'exec', 'expo', 'prebuild', '--platform', 'ios', '--clean', '--no-install'],
        {
          cwd: mobileDirectory,
          logPath: join(logsDirectory, 'prebuild.log'),
          timeoutMs: 180_000,
        },
      );
      await run('pod', ['install', '--silent'], {
        cwd: join(mobileDirectory, 'ios'),
        logPath: join(logsDirectory, 'pods.log'),
        timeoutMs: 300_000,
      });
      const derivedData = resolve('/tmp/navoss-navigation-validation-derived');
      await rm(derivedData, { force: true, recursive: true });
      await run(
        'xcodebuild',
        [
          '-workspace',
          'NavOSS.xcworkspace',
          '-scheme',
          'NavOSS',
          '-configuration',
          'Debug',
          '-sdk',
          'iphonesimulator',
          '-destination',
          `platform=iOS Simulator,id=${simulatorId}`,
          '-derivedDataPath',
          derivedData,
          'CODE_SIGNING_ALLOWED=NO',
          'build',
        ],
        {
          cwd: join(mobileDirectory, 'ios'),
          logPath: join(logsDirectory, 'xcodebuild.log'),
          timeoutMs: 900_000,
        },
      );
      appPath = join(derivedData, 'Build/Products/Debug-iphonesimulator/NavOSS.app');
      if (!existsSync(appPath)) throw new Error(`Built app not found: ${appPath}`);
      await run('codesign', ['--force', '--sign', '-', appPath], {
        logPath: join(logsDirectory, 'codesign.log'),
        timeoutMs: 60_000,
      });
      await run('xcrun', ['simctl', 'boot', simulatorId], { timeoutMs: 30_000 }).catch(
        () => undefined,
      );
      await run('xcrun', ['simctl', 'bootstatus', simulatorId, '-b'], { timeoutMs: 120_000 });
    },
    { critical: true },
  );

  if (!carPlayOnly) {
    await phase(
      'phone-checkpoints',
      async () => {
        await run('xcrun', ['simctl', 'shutdown', simulatorId], {
          timeoutMs: 30_000,
        }).catch(() => undefined);
        await run('xcrun', ['simctl', 'boot', simulatorId], { timeoutMs: 30_000 });
        await run('xcrun', ['simctl', 'bootstatus', simulatorId, '-b'], {
          timeoutMs: 120_000,
        });
        if (!reuseBuild) {
          await run('xcrun', ['simctl', 'install', simulatorId, appPath], { timeoutMs: 60_000 });
        }
        await run(
          'xcrun',
          ['simctl', 'privacy', simulatorId, 'grant', 'location', 'org.navoss.mobile'],
          { timeoutMs: 30_000 },
        );
        startService('api', 'corepack', ['pnpm', '--filter', '@navoss/api', 'dev'], rootDirectory, {
          PORT: '3001',
        });
        startService(
          'metro',
          'corepack',
          [
            'pnpm',
            '--filter',
            '@navoss/mobile',
            'exec',
            'expo',
            'start',
            '--dev-client',
            '--host',
            'lan',
            '--port',
            '8081',
          ],
          rootDirectory,
        );
        await Promise.all([
          waitForUrl('http://127.0.0.1:3001/health'),
          waitForUrl('http://localhost:8081/status'),
        ]);
        await run(
          'sh',
          [
            './scripts/run-maestro-ios.sh',
            '../../.maestro/navigation-validation/phone-checkpoints.yaml',
          ],
          {
            cwd: mobileDirectory,
            logPath: join(logsDirectory, 'phone-checkpoints.log'),
            timeoutMs: 240_000,
          },
        );
        for (const name of ['preview', 'guidance', 'report']) {
          const source = `/tmp/navoss-validation-phone-${name}.png`;
          if (!existsSync(source)) throw new Error(`Maestro screenshot missing: ${source}`);
          await copyFile(source, join(screenshotsDirectory, `phone-${name}.png`));
        }
      },
      { critical: true },
    );

    await phase('phone-reroute', async () => {
      await run('sh', ['./scripts/run-reroute-maestro-ios.sh'], {
        cwd: mobileDirectory,
        logPath: join(logsDirectory, 'phone-reroute.log'),
        timeoutMs: 240_000,
      });
      await copyFile(
        '/tmp/navoss-validation-phone-reroute.png',
        join(screenshotsDirectory, 'phone-reroute.png'),
      );
    });

    await phase('phone-arrival', async () => {
      await run('sh', ['./scripts/run-arrival-maestro-ios.sh'], {
        cwd: mobileDirectory,
        env: {
          NAVOSS_SIMULATOR_APP_PATH: appPath,
          NAVOSS_SKIP_SIMULATOR_INSTALL: reuseBuild ? '1' : '0',
        },
        logPath: join(logsDirectory, 'phone-arrival.log'),
        timeoutMs: 240_000,
      });
      await copyFile(
        '/tmp/navoss-validation-phone-arrival.png',
        join(screenshotsDirectory, 'phone-arrival.png'),
      );
    });
  }

  if (!phoneOnly) {
    await phase('carplay-visuals', async () => {
      if (carPlayOnly && !reuseBuild) {
        await run('xcrun', ['simctl', 'install', simulatorId, appPath], { timeoutMs: 60_000 });
      }
      await run(
        'xcrun',
        ['simctl', 'privacy', simulatorId, 'grant', 'location', 'org.navoss.mobile'],
        {
          timeoutMs: 30_000,
        },
      );
      await run(
        'maestro',
        [
          '--device',
          simulatorId,
          'test',
          resolve(rootDirectory, '.maestro/navigation-validation/allow-location.yaml'),
        ],
        {
          logPath: join(logsDirectory, 'allow-location.log'),
          timeoutMs: 90_000,
        },
      );
      for (const [name, scenario, appearance] of [
        ['carplay-preview-light', 'preview', 'light'],
        ['carplay-preview-dark', 'preview', 'dark'],
        ['carplay-progress-05', 'progress-05', 'light'],
        ['carplay-progress-60', 'progress-60', 'light'],
        ['carplay-overview', 'overview', 'light'],
        ['carplay-clear', 'clear', 'light'],
      ]) {
        await captureCarPlayScenario(name, scenario, appearance);
      }
    });
  }

  await phase('pixel-validation', async () => {
    const { readdir } = await import('node:fs/promises');
    const screenshotNames = await readdir(screenshotsDirectory);
    const paths = screenshotNames
      .filter((name) => name.endsWith('.png'))
      .map((name) => join(screenshotsDirectory, name));
    if (paths.length === 0) throw new Error('No screenshots were captured.');
    const result = await run(
      'swift',
      [join(scriptDirectory, 'analyze-navigation-png.swift'), ...paths],
      {
        logPath: join(logsDirectory, 'pixel-validation.log'),
        timeoutMs: 120_000,
      },
    );
    const metrics = JSON.parse(result.stdout);
    await writeFile(join(pixelsDirectory, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
    for (const metric of metrics) {
      if (
        metric.nonBackgroundRatio < 0.01 ||
        metric.quantizedColorCount < 32 ||
        metric.luminanceVariance < 20 ||
        metric.dominantRatio > 0.99
      ) {
        throw new Error(`Screenshot appears blank or stale: ${basename(metric.path)}`);
      }
      const recognizedText = metric.recognizedText.join(' ').toLowerCase();
      if (recognizedText.includes('allow') && recognizedText.includes('location')) {
        throw new Error(`Permission dialog obscures screenshot: ${basename(metric.path)}`);
      }
    }
    const hashes = await Promise.all(
      paths.map(async (path) => [basename(path), await sha256(path)]),
    );
    if (new Set(hashes.map(([, hash]) => hash)).size !== hashes.length) {
      throw new Error('Two screenshot checkpoints are byte-identical.');
    }
    const metricsByName = new Map(metrics.map((metric) => [basename(metric.path), metric]));
    const routeVisibleMetrics = [
      metricsByName.get('carplay-preview-light.png'),
      metricsByName.get('carplay-progress-05.png'),
      metricsByName.get('carplay-overview.png'),
    ].filter((metric) => metric !== undefined);
    if (routeVisibleMetrics.some((metric) => metric.routeGreenRatio < 0.003)) {
      throw new Error('A CarPlay route scenario does not contain enough route-green pixels.');
    }
    const previewMetric = metricsByName.get('carplay-preview-light.png');
    const clearMetric = metricsByName.get('carplay-clear.png');
    if (
      previewMetric !== undefined &&
      clearMetric !== undefined &&
      clearMetric.routeGreenRatio > previewMetric.routeGreenRatio * 0.35
    ) {
      throw new Error('CarPlay clear scenario retained the route overlay.');
    }
    for (const [first, second] of [
      ['carplay-preview-light.png', 'carplay-preview-dark.png'],
      ['carplay-progress-05.png', 'carplay-progress-60.png'],
      ['carplay-progress-05.png', 'carplay-overview.png'],
    ]) {
      const firstMetric = metricsByName.get(first);
      const secondMetric = metricsByName.get(second);
      if (firstMetric === undefined || secondMetric === undefined) continue;
      const changedCells = firstMetric.perceptualSignature.filter(
        (value, index) => Math.abs(value - secondMetric.perceptualSignature[index]) >= 8,
      ).length;
      if (changedCells / firstMetric.perceptualSignature.length < 0.08) {
        throw new Error(`Screenshots are not visually distinct: ${first} and ${second}`);
      }
    }
    await writeFile(
      join(pixelsDirectory, 'sha256.json'),
      `${JSON.stringify(Object.fromEntries(hashes), null, 2)}\n`,
    );
  });
} catch (error) {
  if (failures.length === 0) failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await cleanup();
  const summary = {
    failures,
    finishedAt: new Date().toISOString(),
    mode: carPlayOnly ? 'carplay-only' : phoneOnly ? 'phone-only' : 'all',
    reuseBuild,
    passed: failures.length === 0,
    phases,
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
  };
  await writeFile(
    join(temporaryArtifacts, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  await rm(finalArtifacts, { force: true, recursive: true });
  await mkdir(dirname(finalArtifacts), { recursive: true });
  await rename(temporaryArtifacts, finalArtifacts);
  console.log(`Navigation validation artifacts: ${finalArtifacts}`);
  console.log(summary.passed ? 'NAVIGATION_VALIDATION_PASSED' : 'NAVIGATION_VALIDATION_FAILED');
}

if (failures.length > 0) process.exitCode = 1;
