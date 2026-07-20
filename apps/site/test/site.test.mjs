import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const sourceRoot = resolve(import.meta.dirname, '..', 'src');

test('homepage presents the product and honest alpha posture', () => {
  const homepage = readFileSync(resolve(sourceRoot, 'index.html'), 'utf8');
  const styles = readFileSync(resolve(sourceRoot, 'styles.css'), 'utf8');

  assert.match(homepage, /<h1[^>]*>NavOSS<\/h1>/);
  assert.match(homepage, /Calgary technical alpha/);
  assert.match(homepage, /no\s+live\s+traffic/i);
  assert.match(styles, /app-navigation\.jpg/);
});

test('legal and support pages expose stable public routes', () => {
  const privacy = readFileSync(resolve(sourceRoot, 'privacy.html'), 'utf8');
  const support = readFileSync(resolve(sourceRoot, 'support.html'), 'utf8');

  assert.match(privacy, /Foreground location/);
  assert.match(privacy, /No advertising or cross-app tracking/);
  assert.match(support, /GitHub Issues/);
  assert.match(support, /not an emergency service/);
});

test('every page carries the shared chevron identity', () => {
  for (const page of [
    'index.html',
    'privacy.html',
    'support.html',
    'data-sources.html',
    'licenses.html',
  ]) {
    assert.match(readFileSync(resolve(sourceRoot, page), 'utf8'), /navoss-chevron\.svg/);
  }
});
