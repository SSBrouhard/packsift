# sift

Deterministic npm tarball diff CLI with supply-chain tripwires.

`sift` compares published npm package versions by downloading their tarballs,
hashing the unpacked files, and reporting material differences plus
deterministic supply-chain-relevant signals. It can compare one package
transition directly, or compare two npm, yarn, or pnpm lockfiles and run the
same tarball analysis for changed registry-backed dependencies.

## Doctrine: Evidence, Never Verdict

sift puts the facts next to each other. Its own narration never tells you what
they mean.

The human report lists bytes, hashes, file changes, metadata correlations, and
deterministic signal matches, then stops. Sift-authored labels avoid merge,
review, hold, urgent, risk-score, and recommendation-style verdicts. Package
names, file paths, registry metadata, and `--json` output still preserve source
data exactly.

The core tarball comparison is deterministic and offline after published npm
artifacts are fetched. The `--advisories` sidecar is the explicit exception:
opt-in, networked, non-deterministic at query time, attributed to OSV.dev,
timestamped, and limited to structured advisory fields.

## Requirements

Node.js 20 or newer.

## Usage

```sh
# Compare one package transition.
sift <name>@<old> <name>@<new>
sift lodash@4.17.20 lodash@4.17.21
sift @scope/pkg@1.2.3 @scope/pkg@1.2.4
sift kysely@0.28.16 kysely@0.28.17 --advisories

# Compare lockfile transitions.
sift batch <old-lockfile> <new-lockfile>
sift batch package-lock.before.json package-lock.json
sift batch HEAD~1:pnpm-lock.yaml HEAD:pnpm-lock.yaml
git show HEAD~1:yarn.lock | sift batch - yarn.lock
```

Options:

- `--json` emits structured JSON.
- `--diff` includes full text line diffs for changed text files up to 512 KB.
  In batch mode, `--diff` requires `--json` unless `--detail` is set.
- `--advisories` adds an opt-in OSV.dev sidecar for single-package transitions.
  It queries old and new npm versions, then renders only id, aliases, severity,
  affected ranges, and reference URLs. It is only accepted when `--registry` is
  exactly `https://registry.npmjs.org`; custom registries are treated as private
  and rejected before any OSV.dev query. It is not supported in batch mode.
- `--registry <url>` selects the npm registry, defaulting to
  `https://registry.npmjs.org`.
- `--keep` preserves extracted tarballs and temp dirs for debugging.
- `--concurrency <n>` sets batch fetch/analyze parallelism, defaulting to 4.
- `--detail` expands analyzed batch entries in human output to the same
  per-package report used by single-transition output.

Batch mode accepts npm `package-lock.json` v2/v3, yarn `yarn.lock` v1/Berry,
and `pnpm-lock.yaml` v5.4/v6/v9. Each lockfile argument may be a working-tree
path, `<ref>:<path>` read through `git show`, or `-` for stdin. Only one side
may be stdin. Mixed formats are supported because each parser lowers to the same
name/version map; human and JSON output always label the detected old and new
formats, such as `old: npm package-lock v3` and `new: pnpm-lock.yaml v9.0`.

Batch mode only considers registry-backed package entries. Linked, aliased,
file, git, off-registry, and unresolved entries are ignored before transition
classification. Packages are analyzed when both lockfiles contain exactly one
version and that version changed. Added-only, removed-only, and multiple-version
packages are listed as skipped.

The npm package is `@ssbrouhard/sift`; the CLI command is `sift`.

The supported interface is the CLI. The package build also contains TypeScript
modules used by the CLI, but the package does not expose a root library entry.

## Output

`sift` strips the tarball `package/` prefix, hashes raw unpacked file bytes, and
omits unchanged files from the report. Changed text files show line counts by
default; `--diff` adds unified diffs. Binary, non-text, or large changed files
show size-only changes.

Batch human output starts with the detected old/new lockfile formats, then has
analyzed, skipped, and error sections. Analyzed entries summarize changed file
counts plus signal and integrity evidence. Per-package errors do not stop the
rest of the batch, but they set the process exit code to 1. Use
`sift batch --json` for structured per-package reports, or `sift batch --detail`
for expanded human reports.

With `--advisories`, single-transition output adds an `Advisory sidecar` block
after the files block. Empty OSV results render `none returned`. OSV failures
are non-fatal: the tarball report still prints, and the affected version says
`advisories unavailable: <reason>`. JSON includes `advisorySidecar` only when
the flag is set. The sidecar records `enabled`, `source`, `fetchedAt`,
`oldVersion`, and `newVersion`; each version records `version`, `vulns`, and
optional `unavailable`.

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
- Install-path network-capable code found in lifecycle commands and one-hop
  local `require`/`import` references.
- New `bin` entries.
- Unpacked size growth over 2x or over 1 MB.
- Dependency-field changes in `dependencies`, `optionalDependencies`,
  `peerDependencies`, and `devDependencies`.
- Package license field changes and changed license files.

## Scope

`sift` uses published npm artifacts only, with lockfiles used only to discover
package transitions for batch analysis. The deterministic core does not clone
GitHub repositories, call model APIs, ingest advisories into its analysis, score
risk, comment on PRs, or inspect consumer project source.

`--advisories` is a fenced sidecar exception, not part of the analyzer. It calls
OSV.dev without authentication for the two requested npm versions only when the
registry is exactly `https://registry.npmjs.org`, renders structured source
fields alongside the tarball report, and never maps files to advisories or turns
advisory data into a verdict.
