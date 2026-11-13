# Website surface

`apps/site/src`: `index.html`, `privacy.html`, `support.html`, `data-sources.html`, `licenses.html`, shared `partials/` (head, header, footer), one `styles.css`, self-hosted Atkinson Hyperlegible Next. Static output; no framework.

## Hard constraints (checked by `corepack pnpm --filter @navoss/site check` and `test`)

- CSP from `site.json`: `script-src 'none'`, `style-src 'self'`, `img-src 'self' data:`, `font-src 'self'`, `frame-ancestors 'none'`. No inline scripts or style attributes, no third-party request of any kind (analytics, fonts, maps, embeds).
- Every internal link resolves; every page shares one header and footer; the privacy "On this page" list must match the page's `<h2 id>` sections one for one.
- The homepage's "In the app today" section must not mention live traffic, offline, community or reports. Unreleased work sits in the labelled "In development" section.
- The hero must keep stating what the product is and the technical-beta status; illustrations are invented streets and say so.

## Design

- Colour tokens mirror the app seed (`styles.css`); light and dark follow the system (`color-scheme`, two `theme-color` metas).
- Mobile first; the hero places a phone and a CarPlay illustration (decorative, `aria-hidden`).
- Documents (`privacy`, `support`, `data-sources`, `licenses`) use the `.document` layout with a callout for status.

## Content rules

All wording rules in `copy.md` apply. Specifically:

- The privacy page mirrors `docs/privacy.md` in meaning (same effective date, same retention facts, same qualifications). Where a feature is not switched on in the deployed service, the page says so in the section itself.
- Coverage statements say what the deployed service does today and name planned coverage as planned.
- Source and licence pages name every data source the shipped or deployed product uses, with its licence.

## Not yet standard

No visual regression check exists for the site; viewing it at mobile and desktop widths in light and dark is a manual step (`coverage-gaps.md`).
