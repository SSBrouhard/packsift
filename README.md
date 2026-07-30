# PackSift

Deterministic npm tarball diff CLI with supply-chain tripwires.

PackSift compares published npm package versions by downloading their tarballs,
hashing the unpacked files, and reporting material differences plus
deterministic supply-chain-relevant signals. It can inspect one published
package version, compare one package transition directly, or compare two npm,
yarn, or pnpm lockfiles and run tarball analysis for changed and newly added
registry-backed dependencies.

## Doctrine: Evidence, Never Verdict

PackSift puts the facts next to each other. Its own narration never tells you what
they mean.

The human report lists bytes, hashes, file changes, metadata correlations, and
deterministic signal matches, then stops. PackSift-authored labels avoid merge,
review, hold, urgent, risk-score, and recommendation-style verdicts. Package
names, file paths, registry metadata, and `--json` output still preserve source
data exactly.

The core tarball comparison is deterministic and offline after published npm
artifacts are fetched. The `--advisories` sidecar is the explicit exception:
opt-in, networked, non-deterministic at query time, attributed to OSV.dev or
the configured OSV-compatible endpoint, timestamped, and structured by default.
`--advisories=summary` additionally passes through OSV summary text as
third-party source text.

## Requirements

Node.js 20 or newer.

## Install

Install the CLI globally:

```sh
npm i -g @ssbrouhard/packsift
packsift lodash@4.17.20 lodash@4.17.21
```

Or run it without installing:

```sh
npx -y @ssbrouhard/packsift lodash@4.17.20 lodash@4.17.21
```

Releases will be published from CI with npm provenance; the first published
version will carry a verifiable attestation linking the artifact back to the
GitHub workflow that built it.

To run from source:

```sh
npm ci && npm run build && node dist/cli.js <args>
```

## Usage

```sh
# Compare one package transition.
packsift <name>@<old> <name>@<new>
packsift lodash@4.17.20 lodash@4.17.21
packsift @scope/pkg@1.2.3 @scope/pkg@1.2.4
packsift kysely@0.28.16 kysely@0.28.17 --advisories
packsift kysely@0.28.16 kysely@0.28.17 --advisories=summary

# Inspect one package version.
packsift inspect <name>@<version>
packsift inspect anthropic-toolkit@1.0.0
packsift inspect @aspect-security/argon2@1.0.0 --json
packsift inspect anthropic-toolkit@1.0.0 --advisories

# Compare lockfile transitions.
packsift batch <old-lockfile> <new-lockfile>
packsift batch package-lock.before.json package-lock.json
packsift batch HEAD~1:pnpm-lock.yaml HEAD:pnpm-lock.yaml
git show HEAD~1:yarn.lock | packsift batch - yarn.lock
packsift batch package-lock.before.json package-lock.json --advisories
```

Options:

- `--json` emits structured JSON.
- `--diff` includes full text line diffs for changed text files up to 512 KB
  in transition reports. In batch mode, `--diff` applies to changed
  transitions and requires `--json` unless `--detail` is set.
- `--advisories` adds an opt-in OSV.dev sidecar for inspect mode,
  single-package transitions, and analyzed batch entries. Inspect mode queries
  the inspected npm version once. Transition mode queries old and new npm
  versions. It renders id, aliases, severity, affected ranges, and reference
  URLs.
- `--advisories=summary` adds the OSV `summary` field as a labeled third-party
  passthrough line. The default `--advisories` mode omits summary text in both
  human output and JSON.
- `--advisory-endpoint <url>` sends advisory queries to an OSV-compatible
  endpoint, such as a private mirror. This is the preferred path for custom
  registries because package coordinates do not go to public OSV.dev. Pointing
  this flag at the public OSV.dev endpoint with a custom registry still requires
  `--advisories-allow-public`.
- `--advisories-allow-public` explicitly permits public OSV.dev advisory
  lookups when `--registry` is not `https://registry.npmjs.org`. Without this
  flag or a non-public `--advisory-endpoint`, custom registries are treated as
  private and rejected before any public OSV.dev query.
- `--registry <url>` selects the npm registry, defaulting to
  `https://registry.npmjs.org`.
- `--keep` preserves extracted tarballs and temp dirs for debugging.
- `--concurrency <n>` sets batch fetch/analyze parallelism, defaulting to 4.
- `--detail` expands analyzed batch entries in human output to the same
  per-package report used by single-transition or inspect output.

Inspect mode fetches one npm tarball through the same registry path as
transition mode, strips the tarball `package/` prefix, hashes raw unpacked file
bytes, and runs the deterministic signal engine with no baseline. Every file in
the tarball is treated as added. The report includes lifecycle scripts,
install-path network indicators, native/GYP payload evidence, `bin` entries,
minified or obfuscated source heuristics, unpacked size, and a file inventory
summary. When the registry metadata already fetched for the tarball includes a
publish timestamp, maintainer list, or versions map, inspect output also reports
publish date, maintainer count, and version count. It does not perform
name-similarity or typosquat detection.

Batch mode accepts npm `package-lock.json`/`npm-shrinkwrap.json` v2/v3, yarn
`yarn.lock` v1/Berry, and `pnpm-lock.yaml` v5.4/v6/v9. Each lockfile argument
may be a working-tree path, `<ref>:<path>` read through `git show`, or `-` for
stdin. Only one side may be stdin. Mixed formats are supported because each
parser lowers to the same name/version map; human and JSON output always label
the detected old and new formats, such as `old: npm package-lock v3` and
`new: pnpm-lock.yaml v9.0`.

Batch mode only considers registry-backed package entries. Linked, aliased,
file, git, off-registry, and unresolved entries are ignored before transition
classification. Packages are analyzed when both lockfiles contain exactly one
version and that version changed. Added-only packages with exactly one resolved
version are analyzed with the same single-tarball path as `packsift inspect` and
labeled `added (no prior version to compare)`. Removed-only and
multiple-version packages are listed as skipped.

The npm package is `@ssbrouhard/packsift`; the canonical CLI command is
`packsift`. The legacy `sift` command remains available as a temporary
compatibility alias for one release.

The supported interface is the CLI. The package build also contains TypeScript
modules used by the CLI, but the package does not expose a root library entry.

## Output

PackSift strips the tarball `package/` prefix, hashes raw unpacked file bytes, and
omits unchanged files from the report. Changed text files show line counts by
default; `--diff` adds unified diffs. Binary, non-text, or large changed files
show size-only changes.

Batch human output starts with the detected old/new lockfile formats, then has
analyzed, skipped, and error sections. Transition entries summarize changed file
counts plus signal and integrity evidence. Added entries summarize file count,
signals, integrity evidence, and unpacked size. With `--advisories`, each
analyzed entry also gets a compact advisory count line; JSON nests the full
`advisorySidecar` under each analyzed transition or added entry. Per-package
errors do not stop the rest of the batch, but they set the process exit code to
1. Use `packsift batch --json` for structured per-package reports, or `packsift batch
--detail` for expanded human reports.

With `--advisories`, inspect and single-transition output add an `Advisory
sidecar` block after the files block. Empty OSV results render `none returned`.
OSV failures are non-fatal: the tarball report still prints, and the affected
version says `advisories unavailable: <reason>`. JSON includes
`advisorySidecar` only when the flag is set. Inspect sidecars record `enabled`,
`source`, `fetchedAt`, and `version`; transition sidecars record `enabled`,
`source`, `fetchedAt`, `oldVersion`, and `newVersion`. Each version records
`version`, `vulns`, and optional `unavailable`. Summary mode adds `summary`
only when OSV provided it.

Integrity and shasum mismatches are reported as warnings instead of stopping the
comparison.

Signals are deterministic tripwires:

- Lifecycle script changes for `preinstall`, `install`, `postinstall`,
  `prepare`, and `prepublishOnly`.
- Maintainer or publisher changes from npm registry metadata.
- Added or changed native executable payloads, including `.node`, `.wasm`, ELF,
  Mach-O, and Windows PE files.
- New or newly minified JavaScript or TypeScript source by line-length
  heuristic.
- Added or changed `binding.gyp`, `*.gyp`, or `*.gypi` files, with GYP
  command substitutions, interpreter build commands, and native source presence.
- Install-path network-capable code found in lifecycle commands or local GYP
  command-substitution/build-command targets, plus one-hop local
  `require`/`import` references.
- New `bin` entries.
- Unpacked size growth over 2x or over 1 MB.
- Dependency-field changes in `dependencies`, `optionalDependencies`,
  `peerDependencies`, and `devDependencies`.
- Package license field changes and changed license files.

## Scope

PackSift uses published npm artifacts only, with lockfiles used only to discover
package transitions and added dependencies for batch analysis. The deterministic
core does not clone GitHub repositories, call model APIs, ingest advisories into
its analysis, score risk, comment on PRs, or inspect consumer project source.

`--advisories` is a fenced sidecar exception, not part of the analyzer. It calls
OSV.dev without authentication for requested npm versions only when the registry
is exactly `https://registry.npmjs.org`, unless the user supplies a private
OSV-compatible endpoint or explicitly acknowledges public OSV.dev use with a
custom registry. It labels each sidecar with OSV.dev or the configured
OSV-compatible endpoint, never maps files to advisories, and never turns
advisory data into a verdict.
