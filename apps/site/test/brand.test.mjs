import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const mobileRoot = resolve(import.meta.dirname, '..', '..', 'mobile');
const imagesRoot = resolve(mobileRoot, 'assets/images');

function pngSize(path) {
  const png = readFileSync(path);
  assert.equal(png.toString('ascii', 1, 4), 'PNG', `${path} is a PNG`);
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

test('every icon and splash image the Expo config names exists at its required size', () => {
  const { expo } = JSON.parse(readFileSync(resolve(mobileRoot, 'app.json'), 'utf8'));
  const splash = expo.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen',
  )[1];
  for (const path of [
    expo.icon,
    expo.android.adaptiveIcon.foregroundImage,
    expo.android.adaptiveIcon.monochromeImage,
    splash.image,
    splash.dark.image,
  ]) {
    assert.deepEqual(pngSize(resolve(mobileRoot, path)), [1024, 1024], path);
  }
  assert.deepEqual(pngSize(resolve(mobileRoot, expo.web.favicon)), [64, 64]);
});

test('the iOS Icon Composer bundle only references layers it ships', () => {
  const { expo } = JSON.parse(readFileSync(resolve(mobileRoot, 'app.json'), 'utf8'));
  const bundle = resolve(mobileRoot, expo.ios.icon);
  const icon = JSON.parse(readFileSync(resolve(bundle, 'icon.json'), 'utf8'));
  const layers = icon.groups.flatMap((group) => group.layers);
  assert.ok(layers.length > 0);
  for (const layer of layers) {
    assert.ok(existsSync(resolve(bundle, 'Assets', layer['image-name'])), layer.name);
  }
  const shipped = readdirSync(resolve(bundle, 'Assets')).sort();
  assert.deepEqual(
    shipped,
    layers.map((layer) => layer['image-name']).sort(),
    'no orphaned layers',
  );
  const appearances = [
    ...(icon['fill-specializations'] ?? []),
    ...layers.flatMap((layer) => layer['fill-specializations'] ?? []),
  ].map((specialization) => specialization.appearance);
  assert.ok(appearances.includes('dark'), 'dark appearance is specialised');
  assert.ok(appearances.includes('tinted'), 'tinted appearance is specialised');
});

test('map markers keep the names and sizes the app and CarPlay plugin load', () => {
  for (const [name, size] of [
    ['vehicle-arrow', 64],
    ['vehicle-car', 64],
    ['camera-marker', 48],
    ['road-closure-marker', 64],
    ['road-construction-marker', 64],
    ['road-incident-marker', 64],
  ]) {
    assert.deepEqual(pngSize(resolve(imagesRoot, `${name}.png`)), [size, size], name);
  }
});

test('every community report type has confirmed and unconfirmed marker art', () => {
  // Mirrors ROAD_REPORT_TYPES in apps/mobile/src/features/map/road-report-drafts.ts.
  for (const type of [
    'collision',
    'road-closure',
    'slow-traffic',
    'construction',
    'pothole',
    'object-on-road',
    'road-hazard',
    'stalled-vehicle',
  ]) {
    assert.deepEqual(pngSize(resolve(imagesRoot, `report-${type}.png`)), [64, 64], type);
    assert.deepEqual(
      pngSize(resolve(imagesRoot, `report-${type}-unconfirmed.png`)),
      [64, 64],
      type,
    );
  }
});
