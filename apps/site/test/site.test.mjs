import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const sourceRoot = resolve(import.meta.dirname, '..', 'src');

test('homepage presents the product and honest beta posture', () => {
  const homepage = readFileSync(resolve(sourceRoot, 'index.html'), 'utf8');
  const styles = readFileSync(resolve(sourceRoot, 'styles.css'), 'utf8');

  assert.match(homepage, /<h1[^>]*>NavOSS<\/h1>/);
  assert.match(homepage, /Calgary now[\s\S]*North America next/);
  assert.match(homepage, /Build 15/);
  assert.match(homepage, /no\s+live\s+traffic/i);
  assert.match(styles, /navoss-map-current\.jpg/);
  assert.doesNotMatch(styles, /app-navigation\.jpg/);
  assert.ok(statSync(resolve(sourceRoot, 'assets', 'navoss-map-current.jpg')).size > 800_000);
  assert.match(homepage, /navoss-social-preview\.jpg/);
  assert.match(homepage, /og:image:width" content="1200"/);
  assert.match(homepage, /og:image:height" content="630"/);
});

test('legal and support pages expose stable public routes', () => {
  const privacy = readFileSync(resolve(sourceRoot, 'privacy.html'), 'utf8');
  const dataSources = readFileSync(resolve(sourceRoot, 'data-sources.html'), 'utf8');
  const support = readFileSync(resolve(sourceRoot, 'support.html'), 'utf8');

  assert.match(privacy, /Location and active navigation/);
  assert.match(privacy, /Clear saved and recent destinations/);
  assert.match(privacy, /No advertising or cross-app tracking/);
  assert.match(
    privacy,
    /selected\s+public\s+name\s+and\s+coordinate\s+directly\s+to\s+Google\s+Places/,
  );
  assert.match(privacy, /More reviews on Google Maps/);
  assert.match(privacy, /photos,[\s\S]*rating count,[\s\S]*review text/);
  assert.match(privacy, /denies grants after 8,000 in a month/);
  assert.match(privacy, /no place name, coordinate, account,[\s\S]*device identifier/);
  assert.match(privacy, /up to 25 private correction drafts/);
  assert.doesNotMatch(privacy, /does not fetch, cache, scrape, or display Google Places ratings/);
  assert.match(
    dataSources,
    /Builds\s+without\s+the\s+restricted\s+Google\s+key\s+make\s+no\s+Google\s+place-details\s+request/,
  );
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
