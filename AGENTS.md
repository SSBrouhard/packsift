# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Project Notes

- Package name is `@ssbrouhard/sift`; the exposed CLI binary is the bare command `sift`.
- Product scope is published npm tarballs, with npm/yarn/pnpm lockfiles used only to discover changed and added dependencies for batch analysis: no GitHub cloning/API calls, model calls, risk scores, verdicts, or recommendations in the deterministic core.
- `--advisories` is the explicit opt-in sidecar exception: single-transition, inspect, and analyzed batch entries only, networked OSV.dev-compatible `/v1/query`, no authentication, timestamped, non-deterministic at query time, structured fields by default, optional third-party OSV summary passthrough with `--advisories=summary`, outside `analyze`, and only allowed with custom registries when `--advisory-endpoint` points at a private mirror or `--advisories-allow-public` explicitly permits public OSV.dev.
- Runtime support starts at Node.js 20.
- Keep `@types/node` pinned to the Node.js 20 major line while the runtime floor is Node.js 20.
- The `yaml` runtime dependency is intentionally exact-pinned and used only to parse yarn Berry and pnpm lockfiles; keep it minimal and zero-transitive because sift is itself a supply-chain tool.
- Build with `npm run build`; run deterministic fixture tests with `npm test`; run `npm run typecheck` for strict TypeScript checking.
- CI runs on push and pull request with Node.js 20 and 22, then typecheck, test, and build.
- Dependabot covers npm dependencies and GitHub Actions weekly.
- The analyzer strips the npm tarball `package/` prefix, hashes raw bytes, drops unchanged files entirely, and only generates full text diffs when `--diff` is requested.
- `native-build-config` fires on added/changed `binding.gyp`, `*.gyp`, and `*.gypi` files, surfacing textual GYP command substitutions, interpreter build commands, and whether native source/header files are present.
- `install-path-network` seeds from lifecycle scripts and local file references in added/changed GYP command substitutions/actions, then keeps the existing one-hop in-package import scan.
- Batch mode parses npm package-lock/npm-shrinkwrap v2/v3, yarn.lock v1/Berry, and pnpm-lock.yaml v5.4/v6/v9; it accepts working-tree paths, `<ref>:<path>`, and one stdin side, labels the detected old/new formats in every output, ignores non-registry/link/alias/off-registry entries, analyzes changed single-version transitions and single-version added dependencies, and skips removed or multiple-version packages.
- `sift inspect <pkg@version>` is the baseline-less single-tarball path: fetch one registry tarball, treat every unpacked file as added, run the shared signal engine, include registry metadata facts already present in the fetched package metadata, and query advisories only for that one version when opted in.
- Evidence-never-verdict enforcement belongs on sift-authored human/advisory formatters (`formatHuman`, `formatInspectHuman`, `formatBatchHuman`, `formatAdvisorySidecar`, and `formatInspectAdvisorySidecar`) only; docs, fixture package/user/registry data, and third-party advisory passthrough may mention doctrine vocabulary without failing the invariant.
