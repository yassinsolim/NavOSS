#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const siteRoot = resolve(import.meta.dirname, '..');
const outputRoot = resolve(siteRoot, 'dist');

execFileSync(process.execPath, [resolve(import.meta.dirname, 'check.mjs')], {
  cwd: siteRoot,
  stdio: 'inherit',
});

rmSync(outputRoot, { force: true, recursive: true });
mkdirSync(outputRoot, { recursive: true });
cpSync(resolve(siteRoot, 'src'), outputRoot, { recursive: true });

console.log(`Built static site at ${outputRoot}`);
