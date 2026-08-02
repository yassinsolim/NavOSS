import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function resolveInputPath(
  inputPath,
  {
    invocationDirectory = process.env.INIT_CWD ?? process.cwd(),
    workingDirectory = process.cwd(),
  } = {},
) {
  const candidates = [
    resolve(invocationDirectory, inputPath),
    resolve(workingDirectory, inputPath),
  ];
  for (const candidate of new Set(candidates)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next supported invocation directory.
    }
  }
  throw new Error(`Route-quality cases not found: ${inputPath}`);
}
