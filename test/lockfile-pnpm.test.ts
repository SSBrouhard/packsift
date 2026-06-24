import { describe, expect, it } from "vitest";
import { parseLockfileContent } from "../src/index.js";

describe("pnpm-lock.yaml parsing", () => {
  it("parses registry packages including scoped and peer-suffixed keys", () => {
    const parsed = parseLockfileContent(`lockfileVersion: '9.0'

packages:
  alpha@1.0.0:
    resolution:
      integrity: sha512-alpha
  '@scope/pkg@2.0.0':
    resolution:
      tarball: https://registry.npmjs.org/@scope%2fpkg/-/pkg-2.0.0.tgz
      integrity: sha512-scope
  child@3.0.0(peer@1.0.0):
    resolution:
      integrity: sha512-child
`, "pnpm-lock.yaml");

    expect(parsed.formatLabel).toBe("pnpm-lock.yaml v9.0");
    expect([...parsed.map.keys()].sort()).toEqual(["@scope/pkg", "alpha", "child"]);
    expect([...parsed.map.get("child") ?? []]).toEqual(["3.0.0"]);
  });

  it("filters pnpm link, file, git, and off-registry tarballs", () => {
    const parsed = parseLockfileContent(`lockfileVersion: 6.0

packages:
  alpha@1.0.0:
    resolution:
      integrity: sha512-alpha
  link-dep@1.0.0:
    resolution:
      tarball: link:../link-dep
  file-dep@1.0.0:
    resolution:
      tarball: file:../file-dep
  git-dep@1.0.0:
    resolution:
      tarball: git+ssh://example.test/git-dep.git
  off-host@1.0.0:
    resolution:
      tarball: https://example.test/off-host/-/off-host-1.0.0.tgz
`, "pnpm-lock.yaml");

    expect([...parsed.map.keys()]).toEqual(["alpha"]);
  });

  it("filters pnpm alias-only package targets unless also directly depended on", () => {
    const parsed = parseLockfileContent(`lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      alias-left:
        specifier: npm:left-pad@^1.3.0
        version: left-pad@1.3.0
      direct-left:
        specifier: npm:left-pad@^1.3.0
        version: left-pad@1.3.0
      alpha:
        specifier: ^1.0.0
        version: 1.0.0

packages:
  left-pad@1.3.0:
    resolution:
      integrity: sha512-left
  alpha@1.0.0:
    resolution:
      integrity: sha512-alpha
`, "pnpm-lock.yaml");

    expect([...parsed.map.keys()]).toEqual(["alpha"]);
  });

  it("keeps pnpm alias targets when the same package/version is directly depended on", () => {
    const parsed = parseLockfileContent(`lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      alias-left:
        specifier: npm:left-pad@^1.3.0
        version: left-pad@1.3.0
      left-pad:
        specifier: ^1.3.0
        version: 1.3.0

packages:
  left-pad@1.3.0:
    resolution:
      integrity: sha512-left
`, "pnpm-lock.yaml");

    expect([...parsed.map.keys()]).toEqual(["left-pad"]);
  });

  it("captures multiple pnpm versions of one package", () => {
    const parsed = parseLockfileContent(`lockfileVersion: 5.4

packages:
  /alpha@1.0.0:
    resolution:
      integrity: sha512-alpha1
  /alpha@1.1.0:
    resolution:
      integrity: sha512-alpha2
`, "pnpm-lock.yaml");

    expect([...parsed.map.get("alpha") ?? []].sort()).toEqual(["1.0.0", "1.1.0"]);
  });

  it("rejects unsupported pnpm lockfile versions and malformed YAML", () => {
    expect(() => parseLockfileContent("lockfileVersion: 99.0\npackages: {}\n", "pnpm-lock.yaml")).toThrow("expected pnpm-lock.yaml v5.4, v6.0, or v9.0");
    expect(() => parseLockfileContent("lockfileVersion: '9.0'\npackages:\n  bad: [", "pnpm-lock.yaml")).toThrow("is not valid pnpm-lock.yaml");
  });
});
