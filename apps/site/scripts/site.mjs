// Shared build and validation for the static NavOSS site. Pages in src/ use `<!-- @head -->`,
// `<!-- @header -->` and `<!-- @footer -->` markers; the build fills them from src/partials so every
// page shares one layout, then validates the output that is actually published.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { extname, relative, resolve } from 'node:path';

export const siteRoot = resolve(import.meta.dirname, '..');
export const sourceRoot = resolve(siteRoot, 'src');
export const origin = 'https://navoss.yassin.app';

export const pages = [
  { file: 'index.html', route: '/' },
  { file: 'privacy.html', route: '/privacy' },
  { file: 'support.html', route: '/support' },
  { file: 'data-sources.html', route: '/data-sources' },
  { file: 'licenses.html', route: '/licenses' },
];

const partialsDirectory = 'partials';

function partial(name) {
  return readFileSync(resolve(sourceRoot, partialsDirectory, `${name}.html`), 'utf8').trim();
}

function indentLike(marker, block) {
  return block
    .split('\n')
    .map((line, index) => (index === 0 || line === '' ? line : `${marker}${line}`))
    .join('\n');
}

function markCurrentPage(header, route) {
  const escaped = route.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return header.replace(new RegExp(`(<a\\b[^>]*\\shref="${escaped}")`), '$1 aria-current="page"');
}

export function renderPage(page) {
  const source = readFileSync(resolve(sourceRoot, page.file), 'utf8');
  const blocks = {
    head: partial('head'),
    header: markCurrentPage(partial('header'), page.route),
    footer: partial('footer'),
  };
  return source.replace(/^([ \t]*)<!-- @(head|header|footer) -->$/gm, (_match, indent, name) => {
    return indent + indentLike(indent, blocks[name]);
  });
}

export function buildSite(outputRoot) {
  rmSync(outputRoot, { force: true, recursive: true });
  mkdirSync(outputRoot, { recursive: true });
  cpSync(sourceRoot, outputRoot, {
    recursive: true,
    filter: (path) => relative(sourceRoot, path).split('/')[0] !== partialsDirectory,
  });
  for (const page of pages) writeFileSync(resolve(outputRoot, page.file), renderPage(page));
}

function listFiles(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? listFiles(root, path) : [relative(root, path)];
  });
}

function attributeValues(html, attribute) {
  return [...html.matchAll(new RegExp(`\\s${attribute}="([^"]*)"`, 'g'))].map(([, value]) => value);
}

function idsIn(html) {
  return new Set(attributeValues(html, 'id'));
}

// Every value that makes a browser fetch something on page load. Navigation links (`<a href>`) are
// excluded because they only load when the visitor chooses them.
export function loadedResources(html) {
  const resources = [];
  for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const [, tag, attributes] = match;
    const lowerTag = tag.toLowerCase();
    if (lowerTag === 'a') continue;
    for (const attribute of ['src', 'srcset', 'poster', 'data']) {
      for (const [, value] of attributes.matchAll(new RegExp(`\\s${attribute}="([^"]*)"`, 'g'))) {
        resources.push(...value.split(',').map((part) => part.trim().split(/\s+/)[0]));
      }
    }
    if (lowerTag === 'link') {
      const rel = /\srel="([^"]*)"/.exec(attributes)?.[1] ?? '';
      const href = /\shref="([^"]*)"/.exec(attributes)?.[1];
      if (href && rel !== 'canonical') resources.push(href);
    }
    // SVG <image>/<use> references.
    if (lowerTag === 'image' || lowerTag === 'use') {
      const href = /\s(?:xlink:)?href="([^"]*)"/.exec(attributes)?.[1];
      if (href) resources.push(href);
    }
  }
  return resources;
}

export function cssUrls(css) {
  return [...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map(([, url]) => url);
}

function resolveLocal(outputRoot, reference) {
  const [path] = reference.split('#');
  if (path === '' || path === '/') return resolve(outputRoot, 'index.html');
  const page = pages.find((candidate) => candidate.route === path);
  if (page) return resolve(outputRoot, page.file);
  return resolve(outputRoot, path.replace(/^\//, ''));
}

export function validateSite(outputRoot) {
  const failures = [];
  const rendered = new Map(
    pages.map((page) => [page.file, readFileSync(resolve(outputRoot, page.file), 'utf8')]),
  );
  const titles = new Map();

  for (const page of pages) {
    const html = rendered.get(page.file);
    const fail = (message) => failures.push(`${page.file}: ${message}`);

    for (const [label, pattern] of [
      ['Canadian English language', /<html\s+lang="en-CA">/],
      ['description', /<meta\s+name="description"\s+content="[^"]+"\s*\/?>/s],
      [
        'viewport',
        /<meta\s+name="viewport"\s+content="width=device-width, initial-scale=1"\s*\/?>/,
      ],
      [
        'canonical URL',
        new RegExp(`<link\\s+rel="canonical"\\s+href="${origin}${page.route}"\\s*/?>`),
      ],
      ['skip link', /<a class="skip-link" href="#main">/],
      ['banner landmark', /<header(?:\s|>)/],
      ['main landmark', /<main id="main"(?:\s|>)/],
      ['contentinfo landmark', /<footer(?:\s|>)/],
      ['shared stylesheet', /<link rel="stylesheet" href="\/styles\.css"/],
      ['light and dark colour scheme', /<meta name="color-scheme" content="light dark"/],
    ]) {
      if (!pattern.test(html)) fail(`missing ${label}`);
    }

    const title = /<title>([^<]+)<\/title>/.exec(html)?.[1];
    if (!title) fail('missing title');
    else if (titles.has(title)) fail(`duplicate title shared with ${titles.get(title)}`);
    else titles.set(title, page.file);

    if ((html.match(/<h1[\s>]/g) ?? []).length !== 1) fail('must have exactly one h1');
    if (/<!-- @(head|header|footer) -->/.test(html)) fail('unrendered layout marker');
    if (/\b(REQUIRED|TODO|localhost|api\.example)\b/.test(html)) {
      fail('contains a placeholder or development host');
    }

    // The CSP is `script-src 'none'; style-src 'self'`, so anything inline would be blocked.
    if (/<script[\s>]/i.test(html)) fail('contains a script element');
    if (/<style[\s>]/i.test(html)) fail('contains an inline style element');
    if (/\sstyle="/i.test(html)) fail('contains an inline style attribute');
    if (/\son[a-z]+="/i.test(html)) fail('contains an inline event handler');
    if (/<iframe[\s>]/i.test(html)) fail('embeds an iframe');

    const ids = [...attributeValues(html, 'id')];
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (duplicates.length > 0) fail(`duplicate ids: ${[...new Set(duplicates)].join(', ')}`);

    for (const [image] of html.matchAll(/<img\b[^>]*>/g)) {
      if (!/\salt="/.test(image)) fail(`image without alt text: ${image}`);
      if (!/\swidth="\d+"/.test(image) || !/\sheight="\d+"/.test(image)) {
        fail(`image without intrinsic size: ${image}`);
      }
    }

    for (const resource of loadedResources(html)) {
      if (/^(?:[a-z]+:)?\/\//i.test(resource)) fail(`loads a third-party resource ${resource}`);
      else if (!resource.startsWith('/')) fail(`loads a non-root-relative resource ${resource}`);
      else if (!existsSync(resolveLocal(outputRoot, resource)))
        fail(`missing resource ${resource}`);
    }

    for (const href of attributeValues(html, 'href')) {
      if (/^(?:https?:|mailto:)/.test(href)) continue;
      if (href.startsWith('#')) {
        if (href !== '#' && !idsIn(html).has(href.slice(1))) fail(`broken fragment ${href}`);
        continue;
      }
      if (!href.startsWith('/')) {
        fail(`relative link ${href}`);
        continue;
      }
      const target = resolveLocal(outputRoot, href);
      if (!existsSync(target)) {
        fail(`broken link ${href}`);
        continue;
      }
      const fragment = href.split('#')[1];
      if (fragment && extname(target) === '.html') {
        const targetHtml =
          rendered.get(relative(outputRoot, target)) ?? readFileSync(target, 'utf8');
        if (!idsIn(targetHtml).has(fragment)) fail(`broken fragment ${href}`);
      }
    }

    for (const [, image] of html.matchAll(/<meta property="og:image" content="([^"]+)"/g)) {
      if (!image.startsWith(`${origin}/`)) fail(`og:image must be served from ${origin}`);
      else if (!existsSync(resolve(outputRoot, image.slice(origin.length + 1)))) {
        fail(`missing og:image ${image}`);
      }
    }
  }

  const css = readFileSync(resolve(outputRoot, 'styles.css'), 'utf8');
  for (const url of cssUrls(css)) {
    if (!url.startsWith('/')) failures.push(`styles.css: loads a non-local resource ${url}`);
    else if (!existsSync(resolve(outputRoot, url.slice(1)))) {
      failures.push(`styles.css: missing resource ${url}`);
    }
  }
  if (/@import/.test(css)) failures.push('styles.css: @import adds a render-blocking request');

  const sitemap = readFileSync(resolve(outputRoot, 'sitemap.xml'), 'utf8');
  for (const page of pages) {
    if (!sitemap.includes(`<loc>${origin}${page.route}</loc>`)) {
      failures.push(`sitemap.xml: missing ${page.route}`);
    }
  }

  const files = listFiles(outputRoot);
  if (files.some((file) => file.startsWith(`${partialsDirectory}/`))) {
    failures.push('partials must not be published');
  }

  return failures;
}

export function contentSecurityPolicy() {
  const config = JSON.parse(readFileSync(resolve(siteRoot, 'site.json'), 'utf8'));
  const header = config.headers
    .flatMap((rule) => rule.headers)
    .find((candidate) => candidate.key === 'Content-Security-Policy');
  return Object.fromEntries(
    header.value.split(';').map((directive) => {
      const [name, ...values] = directive.trim().split(/\s+/);
      return [name, values];
    }),
  );
}
