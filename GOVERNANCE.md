# Governance

NavOSS is currently a maintainer-led project.

## Roles

- **Maintainer:** [@yassinsolim](https://github.com/yassinsolim) sets release scope, reviews changes, manages infrastructure and store credentials, and makes final decisions when consensus is not reached.
- **Contributors:** anyone submitting issues, tests, documentation, design, data-source analysis, or code under the repository contribution terms.

Roles can expand as sustained contributors emerge. Access to production infrastructure, Apple/Expo credentials, security reports, or moderation data is granted separately from repository contribution rights.

## Decisions

- Routine implementation decisions happen in pull-request review.
- Material architecture, privacy, data-source, moderation, or license changes require an issue or architecture decision record before implementation.
- Safety and privacy concerns can block a release regardless of feature completeness.
- The maintainer records decisions and dissent in the relevant issue or pull request.

## Releases

Every change must pass CI. A GitHub release whose tag begins with `ios-v` may trigger an EAS production build and TestFlight submission after release credentials are configured. Public App Store promotion remains a deliberate human decision after TestFlight validation and Apple review.

## Contributions and Licensing

Contributions require a Developer Certificate of Origin sign-off and are accepted under the directory's existing license. See [CONTRIBUTING.md](CONTRIBUTING.md) and [LICENSES/README.md](LICENSES/README.md).

## Changes to Governance

Governance changes use a public pull request and should explain the problem, migration, and effect on existing contributors.
