#!/usr/bin/env node

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSite, contentSecurityPolicy, pages, validateSite } from './site.mjs';

const outputRoot = mkdtempSync(join(tmpdir(), 'navoss-site-check-'));
const failures = [];

try {
  buildSite(outputRoot);
  failures.push(...validateSite(outputRoot));
} finally {
  rmSync(outputRoot, { force: true, recursive: true });
}

const csp = contentSecurityPolicy();
for (const [directive, expected] of [
  ['default-src', ["'self'"]],
  ['script-src', ["'none'"]],
  ['style-src', ["'self'"]],
  ['font-src', ["'self'"]],
  ['object-src', ["'none'"]],
  ['frame-ancestors', ["'none'"]],
]) {
  if (JSON.stringify(csp[directive]) !== JSON.stringify(expected)) {
    failures.push(`site.json: ${directive} must be ${expected.join(' ')}`);
  }
}
if (!csp['img-src']?.every((source) => ["'self'", 'data:'].includes(source))) {
  failures.push("site.json: img-src may only allow 'self' and data:");
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`Validated ${String(pages.length)} built site pages, their resources and the CSP.`);
