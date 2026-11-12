#!/usr/bin/env node

import { resolve } from 'node:path';

import { buildSite, pages, siteRoot, validateSite } from './site.mjs';

const outputRoot = resolve(siteRoot, 'dist');

buildSite(outputRoot);
const failures = validateSite(outputRoot);
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`Built ${String(pages.length)} validated pages at ${outputRoot}`);
