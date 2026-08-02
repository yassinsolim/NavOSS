import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

const retryableInfrastructurePatterns = [
  /kAXErrorInvalidUIElement/i,
  /AXErrorInvalidUIElement/i,
  /AXError(?: error)?\s*-25202/i,
  /IOSDriverTimeoutException/i,
  /iOS driver not ready in time/i,
  /Request for viewHierarchy failed, code:\s*500/i,
  /Failed to connect to \/127\.0\.0\.1:\d+/i,
];

export function isRetryableMaestroInfrastructureFailure(output) {
  return retryableInfrastructurePatterns.some((pattern) => pattern.test(output));
}

export async function readMaestroDebugOutput(debugPath) {
  const paths = await readdir(debugPath, { recursive: true }).catch(() => []);
  const logs = paths.filter((path) => basename(path) === 'maestro.log');
  return (
    await Promise.all(logs.map((path) => readFile(join(debugPath, path), 'utf8').catch(() => '')))
  ).join('\n');
}

if (process.argv.includes('--check-stdin')) {
  let output = '';
  for await (const chunk of process.stdin) output += chunk;
  process.exitCode = isRetryableMaestroInfrastructureFailure(output) ? 0 : 1;
}
