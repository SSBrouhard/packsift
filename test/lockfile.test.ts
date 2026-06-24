import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { packageNameFromLockPath, parseLockfile, parseLockfileContent, parseLockfileData } from "../src/index.js";

describe("lockfile parsing", () => {
  it("maps package paths to name/version sets", () => {
    const versions = parseLockfileData(
      {
        lockfileVersion: 3,
        packages: {
          "": { name: "root", version: "0.0.0" },
          "node_modules/alpha": { version: "1.0.0", resolved: "https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz" },
          "node_modules/@scope/pkg": { version: "2.0.0", resolved: "https://registry.npmjs.org/@scope%2fpkg/-/pkg-2.0.0.tgz" },
          "node_modules/parent/node_modules/child": { version: "3.0.0", resolved: "https://registry.npmjs.org/child/-/child-3.0.0.tgz" },
          "node_modules/other/node_modules/child": { version: "3.1.0", resolved: "https://registry.npmjs.org/child/-/child-3.1.0.tgz" }
        }
      },
      "fixture-lock"
    );

    expect([...versions.keys()].sort()).toEqual(["@scope/pkg", "alpha", "child"]);
    expect([...versions.get("alpha") ?? []]).toEqual(["1.0.0"]);
    expect([...versions.get("@scope/pkg") ?? []]).toEqual(["2.0.0"]);
    expect([...versions.get("child") ?? []].sort()).toEqual(["3.0.0", "3.1.0"]);
  });

  it("uses the final node_modules segment as the package name", () => {
    expect(packageNameFromLockPath("node_modules/a/node_modules/@scope/name")).toBe("@scope/name");
    expect(packageNameFromLockPath("packages/local")).toBeUndefined();
  });

  it("skips non-registry and aliased package entries", () => {
    const versions = parseLockfileData(
      {
        lockfileVersion: 3,
        packages: {
          "node_modules/alpha": { version: "1.0.0", resolved: "https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz" },
          "node_modules/file-dep": { version: "1.0.0", resolved: "file:../file-dep" },
          "node_modules/git-dep": { version: "1.0.0", resolved: "git+ssh://git@example.test/git-dep.git#abc" },
          "node_modules/http-dep": { version: "1.0.0", resolved: "https://example.test/http-dep-1.0.0.tgz" },
          "node_modules/http-shaped": { version: "1.0.0", resolved: "https://example.test/http-shaped/-/http-shaped-1.0.0.tgz" },
          "node_modules/alias-dep": { name: "real-dep", version: "1.0.0", resolved: "https://registry.npmjs.org/real-dep/-/real-dep-1.0.0.tgz" },
          "node_modules/link-dep": { version: "1.0.0", resolved: "https://registry.npmjs.org/link-dep/-/link-dep-1.0.0.tgz", link: true },
          "node_modules/unknown-dep": { version: "1.0.0" }
        }
      },
      "fixture-lock"
    );

    expect([...versions.keys()]).toEqual(["alpha"]);
  });

  it("requires HTTP tarballs to match the configured registry base", () => {
    const versions = parseLockfileData(
      {
        lockfileVersion: 3,
        packages: {
          "node_modules/alpha": { version: "1.0.0", resolved: "https://registry.example.test/npm/alpha/-/alpha-1.0.0.tgz" },
          "node_modules/@scope/pkg": { version: "2.0.0", resolved: "https://registry.example.test/npm/@scope%2fpkg/-/pkg-2.0.0.tgz" },
          "node_modules/off-host": { version: "1.0.0", resolved: "https://example.test/off-host/-/off-host-1.0.0.tgz" },
          "node_modules/off-base": { version: "1.0.0", resolved: "https://registry.example.test/other/off-base/-/off-base-1.0.0.tgz" },
          "node_modules/default-registry": { version: "1.0.0", resolved: "https://registry.npmjs.org/default-registry/-/default-registry-1.0.0.tgz" }
        }
      },
      "fixture-lock",
      "https://registry.example.test/npm/"
    );

    expect([...versions.keys()].sort()).toEqual(["@scope/pkg", "alpha"]);
  });

  it("rejects legacy or missing package maps clearly", () => {
    expect(() => parseLockfileData({ lockfileVersion: 1, packages: {} }, "old-lock")).toThrow(
      "old-lock is unsupported: expected npm package-lock v2/v3 with a packages map"
    );
    expect(() => parseLockfileData({ lockfileVersion: 3 }, "missing-packages")).toThrow(
      "missing-packages is unsupported: expected npm package-lock v2/v3 with a packages map"
    );
    expect(() => parseLockfileData({ lockfileVersion: 4, packages: {} }, "future-lock")).toThrow(
      "future-lock is unsupported: expected npm package-lock v2/v3 with a packages map"
    );
  });

  it("includes the file path for unreadable JSON", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sift-lockfile-test-"));
    const filePath = path.join(root, "package-lock.json");
    try {
      await writeFile(filePath, "{not-json");
      await expect(parseLockfile(filePath)).rejects.toThrow(`Could not parse lockfile ${filePath}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects npm lockfiles from content and returns a format label", () => {
    const parsed = parseLockfileContent(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "node_modules/alpha": { version: "1.0.0", resolved: "https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz" }
        }
      }),
      "stdin"
    );

    expect(parsed.format).toBe("npm");
    expect(parsed.formatLabel).toBe("npm package-lock v3");
    expect([...parsed.map.keys()]).toEqual(["alpha"]);
  });

  it("rejects unknown lockfile content loudly", () => {
    expect(() => parseLockfileContent("not a lockfile", "mystery.lock")).toThrow("mystery.lock is unsupported: expected npm package-lock, yarn.lock, or pnpm-lock.yaml");
  });
});
