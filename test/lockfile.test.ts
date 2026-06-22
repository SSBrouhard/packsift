import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { packageNameFromLockPath, parseLockfile, parseLockfileData } from "../src/index.js";

describe("lockfile parsing", () => {
  it("maps package paths to name/version sets", () => {
    const versions = parseLockfileData(
      {
        lockfileVersion: 3,
        packages: {
          "": { name: "root", version: "0.0.0" },
          "node_modules/alpha": { version: "1.0.0" },
          "node_modules/@scope/pkg": { version: "2.0.0" },
          "node_modules/parent/node_modules/child": { version: "3.0.0" },
          "node_modules/other/node_modules/child": { version: "3.1.0" }
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
});
