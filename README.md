# sift

Deterministic npm tarball diff CLI with supply-chain tripwires.

`sift` compares two published versions of the same npm package by downloading
their npm tarballs, hashing the unpacked files, and reporting material
differences plus deterministic supply-chain-relevant signals.

## Doctrine: Evidence, Never Verdict

sift puts the facts next to each other. It never tells you what they mean.

`sift` reports bytes, hashes, file changes, metadata correlations, and
deterministic signal matches, then stops. It does not output merge, review, hold,
urgent, risk-score, or recommendation-style verdicts.

## Requirements

Node.js 20 or newer.

## Usage

```sh
sift <name>@<old> <name>@<new>
sift lodash@4.17.20 lodash@4.17.21
sift @scope/pkg@1.2.3 @scope/pkg@1.2.4
```

Options:

- `--json` emits structured JSON.
- `--diff` includes full text line diffs for changed text files up to 512 KB.
- `--registry <url>` selects the npm registry, defaulting to
  `https://registry.npmjs.org`.
- `--keep` preserves extracted tarballs and temp dirs for debugging.

The npm package is `@ssbrouhard/sift`; the CLI command is `sift`.

The supported interface is the CLI. The package build also contains TypeScript
modules used by the CLI, but the package does not expose a root library entry.

## Output

`sift` strips the tarball `package/` prefix, hashes raw unpacked file bytes, and
omits unchanged files from the report. Changed text files show line counts by
default; `--diff` adds unified diffs. Binary, non-text, or large changed files
show size-only changes.

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

`sift` uses published npm artifacts only. It does not clone GitHub repositories,
call model APIs, ingest advisories, score risk, comment on PRs, or inspect a
consumer project.
