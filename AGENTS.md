# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Project Notes

- Package name is `@ssbrouhard/sift`; the exposed CLI binary is the bare command `sift`.
- Product scope is published npm tarballs, with npm/yarn/pnpm lockfiles used only to discover batch transitions: no GitHub cloning/API calls, model calls, risk scores, verdicts, or recommendations in the deterministic core.
- `--advisories` is the explicit opt-in sidecar exception: single-transition only, networked OSV.dev `/v1/query`, no authentication, timestamped, non-deterministic at query time, structured fields only, outside `analyze`, and only allowed when `--registry` is exactly `https://registry.npmjs.org`; custom registries are treated as private and rejected before OSV.dev is queried.
- Runtime support starts at Node.js 20.
- Keep `@types/node` pinned to the Node.js 20 major line while the runtime floor is Node.js 20.
- The `yaml` runtime dependency is intentionally exact-pinned and used only to parse yarn Berry and pnpm lockfiles; keep it minimal and zero-transitive because sift is itself a supply-chain tool.
- Build with `npm run build`; run deterministic fixture tests with `npm test`; run `npm run typecheck` for strict TypeScript checking.
- CI runs on push and pull request with Node.js 20 and 22, then typecheck, test, and build.
- Dependabot covers npm dependencies and GitHub Actions weekly.
- The analyzer strips the npm tarball `package/` prefix, hashes raw bytes, drops unchanged files entirely, and only generates full text diffs when `--diff` is requested.
- Batch mode parses npm package-lock v2/v3, yarn.lock v1/Berry, and pnpm-lock.yaml v5.4/v6/v9; it accepts working-tree paths, `<ref>:<path>`, and one stdin side, labels the detected old/new formats in every output, ignores non-registry/link/alias/off-registry entries, analyzes changed single-version transitions, and skips added, removed, or multiple-version packages.
- Evidence-never-verdict enforcement belongs on sift-authored `formatHuman`, `formatBatchHuman`, and `formatAdvisorySidecar` output only; docs and fixture package/user/registry data may mention doctrine vocabulary without failing the invariant.
