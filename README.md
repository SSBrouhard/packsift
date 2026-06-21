# sift

Deterministic npm tarball diff CLI with supply-chain tripwires.

`sift` compares two published versions of the same npm package by downloading
their npm tarballs, hashing the unpacked files, and reporting material
differences plus deterministic supply-chain-relevant signals.

Evidence, never verdict. There are no risk scores or recommendations.

## Usage

```sh
sift <name>@<old> <name>@<new>
sift lodash@4.17.20 lodash@4.17.21
sift @scope/pkg@1.2.3 @scope/pkg@1.2.4
```

Options:

- `--json` emits structured JSON.
- `--diff` includes full text line diffs for changed text files.
- `--registry <url>` selects the npm registry, defaulting to
  `https://registry.npmjs.org`.
- `--keep` preserves extracted tarballs and temp dirs for debugging.

The npm package is `@ssbrouhard/sift`; the CLI command is `sift`.

## Scope

`sift` uses published npm artifacts only. It does not clone GitHub repositories,
call model APIs, ingest advisories, score risk, comment on PRs, or inspect a
consumer project.
