import { execFile } from 'node:child_process';
import { copyFile, cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { CALGARY_STREET_TYPE_ALIASES } from '../../apps/api/src/calgary-street-types.js';
import { normalizeSearchText } from '../../apps/api/src/search-text.js';
import { createOfflineStyle, type OfflineStyle } from './tools.mjs';

const exec = promisify(execFile);
export const OFFLINE_STYLE_NAMES = ['liberty', 'bright', 'positron', 'dark'] as const;
const FONT_STACKS = ['Noto Sans Regular', 'Noto Sans Bold', 'Noto Sans Italic'];

export function searchNormalization(): Record<string, string> {
  const tokens = [
    ...Object.keys(CALGARY_STREET_TYPE_ALIASES),
    'east',
    'west',
    'northeast',
    'northwest',
    'southeast',
    'southwest',
  ];
  return Object.fromEntries(tokens.sort().map((token) => [token, normalizeSearchText(token)]));
}

export async function directoryByteSize(directory: string): Promise<number> {
  let size = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Offline resources must not contain symlinks');
    size += entry.isDirectory() ? await directoryByteSize(path) : (await stat(path)).size;
  }
  return size;
}

export async function buildResources(
  sources: string,
  directory: string,
  scripts: string,
  graphConfigPath: string,
): Promise<number> {
  const styleSource = join(directory, 'source-styles');
  const fontSource = join(directory, 'source-fonts');
  const resources = join(directory, 'resources');
  await Promise.all([
    mkdir(styleSource, { recursive: true }),
    mkdir(fontSource, { recursive: true }),
  ]);
  await exec('tar', [
    '-xzf',
    join(sources, 'openfreemap-styles.tar.gz'),
    '-C',
    styleSource,
    '--strip-components=1',
  ]);
  await exec('tar', [
    '-xzf',
    join(sources, 'maplibre-demotiles.tar.gz'),
    '-C',
    fontSource,
    '--strip-components=1',
  ]);
  await Promise.all([
    mkdir(join(resources, 'styles'), { recursive: true }),
    mkdir(join(resources, 'glyphs'), { recursive: true }),
    mkdir(join(resources, 'sprites'), { recursive: true }),
    mkdir(join(resources, 'licenses'), { recursive: true }),
  ]);
  for (const name of OFFLINE_STYLE_NAMES) {
    const style = JSON.parse(
      await readFile(join(styleSource, 'styles', name, 'style.json'), 'utf8'),
    ) as OfflineStyle;
    for (const layer of style.layers) {
      const layout = layer.layout as Record<string, unknown> | undefined;
      const fonts = layout?.['text-font'];
      if (
        fonts !== undefined &&
        (!Array.isArray(fonts) || fonts.some((font) => !FONT_STACKS.includes(String(font))))
      ) {
        throw new Error(`Style uses an unpackaged font stack: ${name}`);
      }
    }
    await writeFile(
      join(resources, 'styles', `${name}.json`),
      JSON.stringify(createOfflineStyle(style, name)) + '\n',
    );
    await copyFile(
      join(styleSource, 'styles', name, 'LICENSE.md'),
      join(resources, 'licenses', `${name}.txt`),
    );
  }
  for (const stack of FONT_STACKS) {
    await cp(join(fontSource, 'font', stack), join(resources, 'glyphs', stack), {
      recursive: true,
    });
    for (let first = 0; first < 65_536; first += 256) {
      const glyph = await stat(join(resources, 'glyphs', stack, `${first}-${first + 255}.pbf`));
      if (!glyph.isFile() || glyph.size === 0) throw new Error(`Missing glyph range: ${stack}`);
    }
  }
  for (const suffix of ['.json', '.png', '@2x.json', '@2x.png']) {
    await copyFile(
      join(styleSource, 'sprites', 'sprites', 'ofm_f384', `ofm${suffix}`),
      join(resources, 'sprites', `ofm${suffix}`),
    );
  }
  await copyFile(join(styleSource, 'LICENSE.md'), join(resources, 'licenses', 'openfreemap.txt'));
  for (const name of [
    'search-schema.sql',
    'search-query.sql',
    'category-query.sql',
    'sources.lock.json',
  ]) {
    await copyFile(join(scripts, name), join(resources, name));
  }
  await writeFile(
    join(resources, 'search-normalization.json'),
    JSON.stringify(searchNormalization()) + '\n',
  );
  const config = JSON.parse(await readFile(graphConfigPath, 'utf8')) as Record<string, unknown> & {
    mjolnir: Record<string, unknown>;
  };
  config.mjolnir = {
    ...config.mjolnir,
    tile_extract: 'routing.tar',
    tile_dir: '',
    traffic_extract: '',
    admin: '',
    timezone: '',
    default_speeds_config: '',
    transit_dir: '',
    transit_feeds_dir: '',
  };
  config.additional_data = { elevation: '' };
  // Keep engine diagnostics out of user location/trip logs; API errors still propagate.
  config.logging = { type: '', color: false };
  await writeFile(join(resources, 'routing-config.json'), JSON.stringify(config) + '\n');
  await writeFile(
    join(resources, 'ATTRIBUTION.txt'),
    [
      '© OpenStreetMap contributors — https://www.openstreetmap.org/copyright — ODbL 1.0',
      '© OpenMapTiles — https://openmaptiles.org/ — schema design CC BY 4.0, code BSD-3-Clause',
      'OpenFreeMap styles — BSD-3-Clause / CC BY 4.0; Positron and Dark derive from Carto/Stamen/Paul Norman (CC BY 3.0)',
      'Noto Sans Regular, Bold, Italic — SIL Open Font License 1.1 (licenses inside glyph folders)',
      'Maki icons — CC0 1.0; right arrow — public domain; OpenFreeMap integration — MIT',
      'Natural Earth — public domain — https://www.naturalearthdata.com/about/terms-of-use/',
      'OSM coastline, lake centreline and timezone boundaries — ODbL 1.0; processing tools have separate licenses.',
      'Valhalla 3.9.1 — MIT. Offline data has no live traffic or closure updates.',
      '',
    ].join('\n'),
  );
  return directoryByteSize(resources);
}
