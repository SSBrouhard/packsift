# Contributing

Thanks for helping harden `sift`.
This project is a supply-chain inspection CLI, so changes should keep the tool deterministic, explicit, and evidence-only.

## Local Setup

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Before opening a pull request, run:

```sh
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

For CLI-facing changes, also smoke-test the built command:

```sh
node dist/cli.js --help
```

## Scope Rules

- Keep the deterministic analyzer focused on published npm artifacts.
- Do not add model calls, GitHub repository cloning, risk scores, PR comments, or verdict language to core analysis.
- Keep `--advisories` as a sidecar: opt-in, attributed, structured by default, and outside `analyze`.
- Keep OSV summary text as explicit third-party passthrough, and avoid sending custom-registry package coordinates to public OSV.dev unless the user acknowledges it.
- Preserve source data in JSON output; do not rewrite package names, file paths, registry fields, or advisory identifiers.

## Runtime Contract

`sift` supports Node.js 20 or newer.
CI must test Node 20, and `@types/node` should stay on the Node 20 major line unless the runtime floor is intentionally raised.

## Pull Requests

Keep changes narrow and include tests for behavior changes.
Documentation-only changes do not need new tests, but they should not drift from CLI behavior.

## Community Standards

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Report suspected vulnerabilities and Code of Conduct incidents through the private path described in [SECURITY.md](SECURITY.md).
