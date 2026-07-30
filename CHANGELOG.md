# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

## 0.2.0 - 2026-07-30

- Add `packsift pack-check [dir-or-tgz]` for pre-publish comparison of an `npm pack` artifact with an explicit published version or the registry's latest version.
- Reuse the transition evidence engine for local lifecycle scripts, files, bins, native payloads, and signals while limiting registry integrity and metadata evidence to the published baseline.
- Reject advisory sidecars for local comparisons because the unpublished side is not a registry coordinate.

## 0.1.1 - 2026-07-30

- Publish the source repository at `https://github.com/SSBrouhard/packsift` and correct npm package metadata for the renamed public project.
- Remove the one-release `sift` CLI compatibility alias; `packsift` is now the only installed command.
- Make tag-triggered publishing idempotent by skipping versions already present on npm while preserving provenance publishing for new versions.

## 0.1.0

- Rename the npm package to `@ssbrouhard/packsift` and make `packsift` the canonical CLI command, while retaining `sift` as a temporary compatibility alias for one release.
- Add `packsift inspect <pkg@version>` for deterministic single-tarball evidence reports, including package metadata facts already present in registry metadata and opt-in single-version advisory sidecars.
- Analyze added batch dependencies through the inspect path and label them as `added (no prior version to compare)` while keeping removed dependencies skipped.
- Initial public CLI for deterministic npm tarball comparison.
- Added supply-chain tripwires for lifecycle scripts, maintainer changes, native payloads, minified source, install-path network code, binary entries, unpacked size growth, dependency-field changes, license changes, native GYP build configuration, and GYP-seeded install-path network evidence.
- Added package-lock batch analysis.
- Added opt-in OSV.dev advisory sidecar for single-package transitions.
- Add contributor guidance for local verification, scope boundaries, and the Node runtime contract.
- Add Contributor Covenant Code of Conduct, issue templates, and security-report routing.
- Move copyright attribution to NOTICE and keep LICENSE as canonical Apache-2.0 text.
- Add Dependabot coverage for npm dependencies and GitHub Actions.
- Bump tar to 7.5.19.
- Align Node type definitions with the Node 20 runtime floor.
- Extend batch analysis to yarn.lock and pnpm-lock.yaml transitions, git-ref/stdin inputs, source format labels, and detailed human output.
- Extend advisory sidecars to analyzed batch entries, summary passthrough, and OSV-compatible private endpoints.
