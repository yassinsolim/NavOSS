#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const inventory = JSON.parse(
  execFileSync('corepack', ['pnpm', 'licenses', 'list', '--prod', '--no-optional', '--json'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }),
);
const lockfile = readFileSync(resolve(repositoryRoot, 'pnpm-lock.yaml'));
const lockfileHash = createHash('sha256').update(lockfile).digest('hex');

const sections = Object.entries(inventory)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([license, packages]) => {
    const rows = packages
      .map((dependency) => ({
        homepage: dependency.homepage ?? '',
        name: dependency.name,
        versions: [...dependency.versions].sort().join(', '),
      }))
      .sort((left, right) =>
        left.name === right.name
          ? left.versions.localeCompare(right.versions)
          : left.name.localeCompare(right.name),
      )
      .map(
        ({ homepage, name, versions }) =>
          `- \`${name}\` - \`${versions}\`${homepage.length > 0 ? ` - <${homepage}>` : ''}`,
      );

    return [`## ${license}`, '', ...rows].join('\n');
  });

const notice = `# Third-Party Notices

This inventory is generated from required production JavaScript dependencies in \`pnpm-lock.yaml\`.
It excludes development-only and optional packages, downloaded map/routing data,
native build-tool dependencies, and external services. Those components retain
their own licenses and attribution requirements.

Lockfile SHA-256: \`${lockfileHash}\`

Regenerate with:

\`\`\`sh
corepack pnpm licenses:generate
\`\`\`

${sections.join('\n\n')}
`;

writeFileSync(resolve(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), notice);
