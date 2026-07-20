# Contributing to NavOSS

Thanks for helping build privacy-first navigation in the open. NavOSS is an early Calgary technical alpha, not a production navigation or safety service.

## Before You Start

- Search existing issues before opening a new one.
- Use an issue to discuss substantial features, provider changes, data ingestion, privacy changes, or architectural work before implementation.
- Never collect route traces while driving unless a passenger operates the device and everyone involved has consented.
- Never submit private addresses, raw personal trip history, credentials, proprietary map data, or data copied from commercial navigation products.

## Local Setup

NavOSS requires Node.js 24.18.0 and pnpm 11.13.0 through Corepack.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm test
```

Run the API locally:

```sh
HOST=0.0.0.0 PORT=3001 corepack pnpm --filter @navoss/api dev
```

Native iOS and simulator instructions are in the [README](README.md#ios-simulator).

## Pull Requests

1. Branch from `main` and keep the change focused.
2. Add tests that scale with behavioral risk.
3. Run the relevant focused test while iterating.
4. Before requesting review, run:

```sh
corepack pnpm format:check
corepack pnpm check
corepack pnpm lint
corepack pnpm test
corepack pnpm build
git diff --check
```

Run the Swift and Maestro suites when changing native navigation or user journeys. Explain any gate that could not run.

## Developer Certificate of Origin

NavOSS uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/) instead of a contributor license agreement. Sign every commit to certify that you have the right to submit it:

```sh
git commit --signoff
```

This adds a `Signed-off-by` trailer using your configured Git identity.

## Licensing

Contributions are accepted under the license of the directory they modify:

- mobile and shared client contracts: MPL-2.0;
- hosted API/backend/operations/data pipeline: AGPL-3.0-only; and
- documentation and brand assets: all rights reserved unless stated otherwise.

See [LICENSES/README.md](LICENSES/README.md) before moving code across those boundaries. Third-party code or data must include provenance, compatible terms, and required attribution.

## Safety and Privacy

- Navigation behavior must fail conservatively and avoid unverified parity or safety claims.
- Request bodies, search queries, route coordinates, and raw location must not enter application logs.
- Public OSM tiles, Photon, and FOSSGIS endpoints remain development-only unless their operators explicitly approve production use.
- Security vulnerabilities belong in a private report, not a public issue. See [SECURITY.md](SECURITY.md).

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
