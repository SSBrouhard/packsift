# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- Add contributor guidance for local verification, scope boundaries, and the Node runtime contract.
- Add Dependabot coverage for npm dependencies and GitHub Actions.
- Align Node type definitions with the Node 20 runtime floor.
- Extend batch analysis to yarn.lock and pnpm-lock.yaml transitions, git-ref/stdin inputs, source format labels, and detailed human output.
- Extend advisory sidecars to analyzed batch entries, summary passthrough, and OSV-compatible private endpoints.
- Add native GYP build configuration and GYP-seeded install-path network tripwires.

## 0.1.0

- Initial public CLI for deterministic npm tarball comparison.
- Added supply-chain tripwires for lifecycle scripts, maintainer changes, native payloads, minified source, install-path network code, binary entries, unpacked size growth, dependency-field changes, and license changes.
- Added package-lock batch analysis.
- Added opt-in OSV.dev advisory sidecar for single-package transitions.
