# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Project Notes

- Package name is `@ssbrouhard/sift`; the exposed CLI binary is the bare command `sift`.
- Product scope is npm published tarballs only: no GitHub cloning/API calls, model calls, advisory ingestion, risk scores, verdicts, or recommendations.
- Runtime support starts at Node.js 20.
- Build with `npm run build`; run deterministic fixture tests with `npm test`; run `npm run typecheck` for strict TypeScript checking.
- CI runs on push and pull request with Node.js 20, then typecheck, test, and build.
- The analyzer strips the npm tarball `package/` prefix, hashes raw bytes, drops unchanged files entirely, and only generates full text diffs when `--diff` is requested.
- Evidence-never-verdict enforcement belongs on sift-authored `formatHuman` output only; docs and fixture package/user/registry data may mention doctrine vocabulary without failing the invariant.
