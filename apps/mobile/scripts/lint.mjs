// Lints exactly what CI lints. `expo start` writes `expo-env.d.ts` and `.expo/types`, which a
// clean checkout does not have; they give `process.env` real types, so type-aware rules such as
// no-unsafe-assignment pass locally and fail in CI. Lint without them (and without ESLint's
// per-file cache, which is keyed on each file's own contents and so misses type changes made in
// other files), then put them back.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const generated = ['expo-env.d.ts', join('.expo', 'types')].filter((path) => existsSync(path));
const stash = mkdtempSync(join(tmpdir(), 'navoss-lint-'));
const moved = [];
let status = 1;
try {
  for (const [index, path] of generated.entries()) {
    const target = join(stash, String(index));
    renameSync(path, target);
    moved.push([target, path]);
  }
  rmSync(join('.expo', 'cache', 'eslint'), { force: true, recursive: true });
  const result = spawnSync('expo', ['lint', '--no-cache', ...process.argv.slice(2)], {
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
  status = result.status ?? 1;
} finally {
  for (const [from, to] of moved) renameSync(from, to);
  rmSync(stash, { force: true, recursive: true });
}
process.exit(status);
