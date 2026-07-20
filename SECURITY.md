# Security Policy

## Supported Versions

NavOSS is pre-release software. Security fixes are made on the latest `main` branch and the newest active TestFlight build when one exists. Older commits and local development builds are not supported releases.

## Report a Vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's [private vulnerability reporting](https://github.com/yassinsolim/NavOSS/security/advisories/new). Include the affected component, impact, reproduction steps, and a minimal proof of concept. Remove API tokens, precise personal locations, private addresses, and unrelated user data.

If private reporting is unavailable, contact the maintainer through the private contact method listed on [@yassinsolim's GitHub profile](https://github.com/yassinsolim). A dedicated security alias will be added before public beta.

You can expect acknowledgment within seven days. Timelines for validation and remediation depend on severity and whether a coordinated disclosure is needed.

## Scope

High-priority areas include:

- unintended location collection, retention, or disclosure;
- authentication or authorization bypasses;
- exposed credentials or signing material;
- route/report abuse that can create unsafe guidance;
- dependency or build-pipeline compromise; and
- injection, request forgery, denial of service, or data tampering in hosted services.

The public Photon/FOSSGIS development endpoints and upstream OpenStreetMap data quality are not NavOSS security boundaries, but unsafe handling of their responses can be.

## Safe Harbor

Good-faith research that avoids privacy violations, service disruption, social engineering, and accessing data beyond what is needed to demonstrate an issue is welcome. Ask before testing production infrastructure once it exists.
