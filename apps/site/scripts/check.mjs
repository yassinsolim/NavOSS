#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const siteRoot = resolve(import.meta.dirname, '..');
const sourceRoot = resolve(siteRoot, 'src');
const pages = ['index.html', 'privacy.html', 'support.html', 'data-sources.html', 'licenses.html'];
const routeTargets = new Map([
  ['/', 'index.html'],
  ['/privacy', 'privacy.html'],
  ['/support', 'support.html'],
  ['/data-sources', 'data-sources.html'],
  ['/licenses', 'licenses.html'],
]);
const failures = [];

for (const page of pages) {
  const path = resolve(sourceRoot, page);
  const contents = readFileSync(path, 'utf8');

  for (const [label, pattern] of [
    ['Canadian English language', /<html\s+lang="en-CA">/],
    ['description', /<meta\s+name="description"\s+content="[^"]+"\s*\/?>/s],
    ['viewport', /<meta\s+name="viewport"\s+content="[^"]+"\s*\/?>/s],
    ['canonical URL', /<link\s+rel="canonical"\s+href="[^"]+"\s*\/?>/s],
    ['main content', /<main(?:\s|>)/],
    ['footer', /<footer(?:\s|>)/],
  ]) {
    if (!pattern.test(contents)) failures.push(`${page}: missing ${label}`);
  }

  if (/\b(REQUIRED|TODO|localhost|api\.example)\b/.test(contents)) {
    failures.push(`${page}: contains a placeholder or development host`);
  }

  const localReferences = [...contents.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map(
    ([, reference]) => reference,
  );

  for (const reference of localReferences) {
    if (reference.startsWith('/assets/')) {
      if (!existsSync(resolve(sourceRoot, reference.slice(1)))) {
        failures.push(`${page}: missing asset ${reference}`);
      }
      continue;
    }

    if (!routeTargets.has(reference) && reference !== '/styles.css') {
      failures.push(`${page}: unknown local route ${reference}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`Validated ${String(pages.length)} site pages and their local references.`);
