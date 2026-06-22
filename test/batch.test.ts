import { describe, expect, it } from "vitest";
import { analyzeBatch, classifyTransitions, formatBatchHuman } from "../src/index.js";
import { applyBatchExitCode, parseArgs, parseBatchArgs } from "../src/cli.js";
import { FetchResult } from "../src/registry.js";
import { ClassifiedTransitions, PackageManifest, Report } from "../src/types.js";

describe("batch transition classification", () => {
  it("classifies only single-version differing transitions for analysis", () => {
    const oldVersions = mapOf({
      alpha: ["1.0.0"],
      beta: ["1.0.0"],
      gamma: ["1.0.0"],
      multi: ["1.0.0", "1.1.0"]
    });
    const newVersions = mapOf({
      alpha: ["1.0.1"],
      beta: ["1.0.0"],
      delta: ["1.0.0"],
      multi: ["2.0.0"]
    });

    expect(classifyTransitions(oldVersions, newVersions)).toEqual({
      analyzed: [{ name: "alpha", oldVersion: "1.0.0", newVersion: "1.0.1" }],
      skipped: [
        { name: "delta", reason: "added" },
        { name: "gamma", reason: "removed" },
        { name: "multi", reason: "multiple-versions" }
      ]
    });
  });

  it("sorts analyzed and skipped entries alphabetically", () => {
    const classified = classifyTransitions(mapOf({ zebra: ["1"], alpha: ["1"], removed: ["1"] }), mapOf({ zebra: ["2"], alpha: ["2"], added: ["1"] }));

    expect(classified.analyzed.map((entry) => entry.name)).toEqual(["alpha", "zebra"]);
    expect(classified.skipped.map((entry) => entry.name)).toEqual(["added", "removed"]);
  });
});

describe("batch orchestration", () => {
  it("runs transitions with bounded concurrency and stable output order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const classified: ClassifiedTransitions = {
      analyzed: [
        { name: "zebra", oldVersion: "1.0.0", newVersion: "1.0.1" },
        { name: "alpha", oldVersion: "1.0.0", newVersion: "1.0.1" },
        { name: "middle", oldVersion: "1.0.0", newVersion: "1.0.1" }
      ],
      skipped: [{ name: "added-only", reason: "added" }]
    };

    const report = await analyzeBatch(classified, { registry: "https://registry.test", keep: false, concurrency: 2 }, {
      fetchArtifacts: async (oldSpec, newSpec, options) => {
        expect(options.registry).toBe("https://registry.test");
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(5);
        inFlight -= 1;
        return fetchResult(oldSpec.name, oldSpec.version, newSpec.version);
      },
      analyze: async (input, options) => {
        expect(options.includeDiffs).toBeUndefined();
        return reportFor(input.packageName, input.oldVersion, input.newVersion);
      }
    });

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(report.analyzed.map((entry) => entry.name)).toEqual(["alpha", "middle", "zebra"]);
    expect(report.skipped).toEqual([{ name: "added-only", reason: "added" }]);
    expect(report.errors).toEqual([]);
  });

  it("turns per-package failures into sorted error entries", async () => {
    const report = await analyzeBatch(
      {
        analyzed: [
          { name: "zebra", oldVersion: "1.0.0", newVersion: "1.0.1" },
          { name: "alpha", oldVersion: "1.0.0", newVersion: "1.0.1" }
        ],
        skipped: []
      },
      { registry: "https://registry.test", keep: false, concurrency: 4 },
      {
        fetchArtifacts: async (oldSpec, newSpec) => {
          if (oldSpec.name === "zebra") throw new Error("tarball fetch failed");
          return fetchResult(oldSpec.name, oldSpec.version, newSpec.version);
        },
        analyze: async (input) => reportFor(input.packageName, input.oldVersion, input.newVersion)
      }
    );

    expect(report.analyzed.map((entry) => entry.name)).toEqual(["alpha"]);
    expect(report.errors).toEqual([{ name: "zebra", message: "tarball fetch failed" }]);
  });

  it("validates concurrency before running work", async () => {
    await expect(
      analyzeBatch({ analyzed: [{ name: "alpha", oldVersion: "1", newVersion: "2" }], skipped: [] }, { registry: "https://registry.test", keep: false, concurrency: 0 })
    ).rejects.toThrow("--concurrency must be a positive integer");
  });
});

describe("batch formatting and CLI parsing", () => {
  it("renders compact human output in analyzed, skipped, error order", () => {
    const output = formatBatchHuman({
      analyzed: [
        { name: "alpha", report: { ...reportFor("alpha", "1.0.0", "1.0.1"), signals: [{ id: "new-bin", title: "New bin entries", details: { added: { alpha: "cli.js" } } }] } },
        {
          name: "beta",
          report: {
            ...reportFor("beta", "2.0.0", "2.0.1"),
            integrityWarnings: [
              { version: "2.0.1", kind: "integrity", expected: "sha512-expected", actual: "sha512-actual" },
              { version: "2.0.1", kind: "shasum", expected: "expected", actual: "actual" }
            ]
          }
        },
        { name: "delta", report: reportFor("delta", "3.0.0", "3.0.1") }
      ],
      skipped: [{ name: "gamma", reason: "multiple-versions" }],
      errors: [{ name: "zeta", message: "HTTP 500" }]
    });

    expect(output).toContain("-- Analyzed");
    expect(output).toContain("alpha  1.0.0 -> 1.0.1   1 changed files; signals: new-bin");
    expect(output).toContain("beta  2.0.0 -> 2.0.1   1 changed files; integrity/shasum mismatches: 2");
    expect(output).toContain("delta  3.0.0 -> 3.0.1   1 changed files; signals: no signals");
    expect(output).toContain("gamma  (multiple versions)");
    expect(output).toContain("zeta  HTTP 500");
    expect(output.indexOf("-- Analyzed")).toBeLessThan(output.indexOf("-- Skipped"));
    expect(output.indexOf("-- Skipped")).toBeLessThan(output.indexOf("-- Errors"));
  });

  it("parses batch args without changing single-transition parsing", () => {
    expect(parseBatchArgs(["old.json", "new.json"])).toMatchObject({
      oldLockfile: "old.json",
      newLockfile: "new.json",
      concurrency: 4,
      registry: "https://registry.npmjs.org"
    });
    expect(parseBatchArgs(["--json", "--diff", "--keep", "--registry", "https://registry.test", "--concurrency", "8", "old.json", "new.json"])).toMatchObject({
      json: true,
      diff: true,
      keep: true,
      registry: "https://registry.test",
      concurrency: 8
    });
    expect(parseArgs(["left@1.0.0", "left@1.0.1"]).positionals).toEqual(["left@1.0.0", "left@1.0.1"]);
  });

  it("rejects bad batch arity and concurrency", () => {
    expect(() => parseBatchArgs(["old.json"])).toThrow("Expected exactly two lockfile paths");
    expect(() => parseBatchArgs(["--concurrency", "0", "old.json", "new.json"])).toThrow("--concurrency must be a positive integer");
    expect(() => parseBatchArgs(["--concurrency", "1.5", "old.json", "new.json"])).toThrow("--concurrency must be a positive integer");
    expect(() => parseBatchArgs(["--concurrency", "abc", "old.json", "new.json"])).toThrow("--concurrency must be a positive integer");
  });

  it("rejects batch diffs unless JSON can expose them", () => {
    expect(() => parseBatchArgs(["--diff", "old.json", "new.json"])).toThrow("sift batch --diff requires --json");
    expect(parseBatchArgs(["--json", "--diff", "old.json", "new.json"])).toMatchObject({ json: true, diff: true });
  });

  it("sets a failing exit code for partial batch failures", () => {
    const originalExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      applyBatchExitCode({ errors: [] });
      expect(process.exitCode).toBeUndefined();
      applyBatchExitCode({ errors: [{ name: "zeta", message: "HTTP 500" }] });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });
});

function mapOf(input: Record<string, string[]>): Map<string, Set<string>> {
  return new Map(Object.entries(input).map(([name, versions]) => [name, new Set(versions)]));
}

function fetchResult(name: string, oldVersion: string, newVersion: string): FetchResult {
  const oldManifest: PackageManifest = { name, version: oldVersion };
  const newManifest: PackageManifest = { name, version: newVersion };
  return {
    oldArtifacts: { spec: { raw: `${name}@${oldVersion}`, name, version: oldVersion }, registryManifest: oldManifest, tarballPath: "old.tgz", extractDir: "old", integrity: {} },
    newArtifacts: { spec: { raw: `${name}@${newVersion}`, name, version: newVersion }, registryManifest: newManifest, tarballPath: "new.tgz", extractDir: "new", integrity: {} },
    integrityWarnings: [],
    cleanup: async () => undefined
  };
}

function reportFor(name: string, oldVersion: string, newVersion: string): Report {
  return {
    packageName: name,
    oldVersion,
    newVersion,
    integrityWarnings: [],
    signals: [],
    files: {
      summary: { added: 1, removed: 0, changed: 0 },
      entries: [{ path: "index.js", status: "added", newSize: 10 }]
    },
    sizeDelta: {
      oldBytes: 0,
      newBytes: 10,
      fired: false,
      threshold: "> 2x or > +1 MB"
    }
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
