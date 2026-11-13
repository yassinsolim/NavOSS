import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

import { buildSite, loadedResources, pages, validateSite } from '../scripts/site.mjs';

let outputRoot;
const built = (file) => readFileSync(resolve(outputRoot, file), 'utf8');
const text = (html) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
const section = (html, id) => {
  const match = new RegExp(`<section[^>]*\\sid="${id}"[\\s\\S]*?</section>`).exec(html);
  assert.ok(match, `section #${id} exists`);
  return match[0];
};

before(() => {
  outputRoot = mkdtempSync(join(tmpdir(), 'navoss-site-test-'));
  buildSite(outputRoot);
});

after(() => rmSync(outputRoot, { force: true, recursive: true }));

test('the published site passes every structural, privacy and link check', () => {
  assert.deepEqual(validateSite(outputRoot), []);
});

test('validation rejects third-party requests and CSP-blocked inline code', () => {
  const copy = mkdtempSync(join(tmpdir(), 'navoss-site-broken-'));
  try {
    cpSync(outputRoot, copy, { recursive: true });
    const support = resolve(copy, 'support.html');
    writeFileSync(
      support,
      readFileSync(support, 'utf8').replace(
        '</main>',
        '<img src="https://tiles.example.org/1.png" alt="" width="1" height="1" /><p style="color:red">x</p><a href="/nowhere">x</a></main>',
      ),
    );
    const failures = validateSite(copy).join('\n');
    assert.match(
      failures,
      /support\.html: loads a third-party resource https:\/\/tiles\.example\.org/,
    );
    assert.match(failures, /support\.html: contains an inline style attribute/);
    assert.match(failures, /support\.html: broken link \/nowhere/);
  } finally {
    rmSync(copy, { force: true, recursive: true });
  }
});

test('resource scanner sees every load-time request but not navigation links', () => {
  const html =
    '<link rel="canonical" href="https://a.test/"><link rel="stylesheet" href="/s.css"><img src="/a.png" srcset="/b.png 2x, https://c.test/c.png 3x"><a href="https://github.com/">x</a>';
  assert.deepEqual(loadedResources(html), ['/s.css', '/a.png', '/b.png', 'https://c.test/c.png']);
});

test('every page shares one header and footer and marks itself as current', () => {
  const chrome = (html) => {
    const header = /<header class="site-header">[\s\S]*?<\/header>/.exec(html)[0];
    const footer = /<footer class="site-footer">[\s\S]*?<\/footer>/.exec(html)[0];
    return { header: header.replace(/ aria-current="page"/g, ''), footer };
  };
  const reference = chrome(built('index.html'));
  for (const page of pages) {
    const html = built(page.file);
    assert.deepEqual(chrome(html), reference, `${page.file} uses the shared layout`);
    const current = [...html.matchAll(/\shref="([^"]+)" aria-current="page"/g)].map(
      ([, href]) => href,
    );
    const linked = reference.header.includes(`href="${page.route}"`);
    assert.deepEqual(
      current,
      linked ? [page.route] : [],
      `${page.file} marks only itself as current`,
    );
  }
});

test('homepage states what NavOSS is and keeps unreleased features labelled', () => {
  const homepage = built('index.html');
  const hero = text(/<section class="hero"[\s\S]*?<\/section>/.exec(homepage)[0]);
  assert.match(hero, /private, account-free, open-source navigation/);
  assert.match(hero, /iOS \+ CarPlay technical beta/);
  assert.match(hero, /Alberta and British Columbia are rolling out/);

  const shipping = text(section(homepage, 'features'));
  assert.doesNotMatch(shipping, /live traffic|offline|community|report/i);

  const roadmap = section(homepage, 'roadmap');
  const items = [...roadmap.matchAll(/<li class="roadmap__item">[\s\S]*?<\/li>/g)].map(([item]) =>
    text(item),
  );
  assert.equal(items.length, 3);
  for (const [index, label] of [
    'Community road reports',
    'Community traffic',
    'Offline maps',
  ].entries()) {
    assert.match(items[index], new RegExp(`In development ${label}`));
  }

  const beta = section(homepage, 'beta');
  assert.match(beta, /href="https:\/\/github\.com\/yassinsolim\/NavOSS"/);
  assert.match(text(beta), /passenger/);
});

test('hero illustration is decorative to assistive tech and says it is invented', () => {
  const homepage = built('index.html');
  assert.equal(homepage.match(/class="(?:phone|carplay)" aria-hidden="true"/g)?.length, 2);
  assert.match(
    text(homepage),
    /Illustration of NavOSS guidance\. Streets and places are invented\./,
  );
});

test('social preview metadata points at a 1200×630 image on this origin', () => {
  const homepage = built('index.html');
  assert.match(
    homepage,
    /og:image" content="https:\/\/navoss\.yassin\.app\/assets\/navoss-social-preview\.png"/,
  );
  const png = readFileSync(resolve(outputRoot, 'assets/navoss-social-preview.png'));
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630]);
});

test('privacy contents list matches its sections', () => {
  const privacy = built('privacy.html');
  const toc = /<nav class="toc"[\s\S]*?<\/nav>/.exec(privacy)[0];
  const linked = [...toc.matchAll(/href="#([^"]+)"/g)].map(([, id]) => id);
  const sections = [...privacy.matchAll(/<h2 id="([^"]+)">/g)]
    .map(([, id]) => id)
    .filter((id) => id !== 'toc-title');
  assert.deepEqual(linked, sections);
});

test('legal and support pages keep their published commitments', () => {
  const privacy = text(built('privacy.html'));
  const dataSources = text(built('data-sources.html'));
  const support = text(built('support.html'));

  assert.match(privacy, /Location and active navigation/);
  assert.match(privacy, /Clear saved and recent destinations/);
  assert.match(privacy, /No advertising or cross-app tracking/);
  assert.match(privacy, /selected public name and coordinate directly to Google Places/);
  assert.match(privacy, /More reviews on Google Maps/);
  assert.match(privacy, /denies grants after 8,000 in a month/);
  assert.match(privacy, /no place name, coordinate, account, device identifier/);
  assert.match(
    privacy,
    /Accepted submissions.*scheduled for deletion from the live database after 90 days/,
  );
  assert.match(privacy, /DriveBC webcams are not enforcement cameras/);
  assert.match(
    dataSources,
    /Builds without the restricted Google key make no Google place-details request/,
  );
  assert.match(dataSources, /Production routes are calculated by self-hosted Valhalla/);
  assert.match(dataSources, /illustrations on this website are original artwork/);
  assert.match(support, /GitHub Issues/);
  assert.match(support, /not an emergency service/);
});
