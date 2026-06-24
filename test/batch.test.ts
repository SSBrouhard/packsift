import { describe, expect, it } from "vitest";
import { analyzeBatch, classifyTransitions, formatBatchHuman } from "../src/index.js";
import { applyBatchExitCode, batchHelpText, helpText, parseArgs, parseBatchArgs, resolveLockfileArgument, runBatch } from "../src/cli.js";
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
      sources: { old: "npm package-lock v3", new: "pnpm-lock.yaml v9.0" },
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
    expect(output).toContain("old: npm package-lock v3");
    expect(output).toContain("new: pnpm-lock.yaml v9.0");
    expect(output).toContain("alpha  1.0.0 -> 1.0.1   1 changed files; signals: new-bin");
    expect(output).toContain("beta  2.0.0 -> 2.0.1   1 changed files; integrity/shasum mismatches: 2");
    expect(output).toContain("delta  3.0.0 -> 3.0.1   1 changed files; signals: no signals");
    expect(output).toContain("gamma  (multiple versions)");
    expect(output).toContain("zeta  HTTP 500");
    expect(output.indexOf("-- Analyzed")).toBeLessThan(output.indexOf("-- Skipped"));
    expect(output.indexOf("-- Skipped")).toBeLessThan(output.indexOf("-- Errors"));
  });

  it("expands analyzed entries with --detail using the single-package formatter", () => {
    const output = formatBatchHuman(
      {
        sources: { old: "npm package-lock v3", new: "npm package-lock v3" },
        analyzed: [{ name: "alpha", report: reportFor("alpha", "1.0.0", "1.0.1") }],
        skipped: [],
        errors: []
      },
      { detail: true }
    );

    expect(output).toContain("alpha  1.0.0 -> 1.0.1   1 changed files; signals: no signals");
    expect(output).toContain("    sift  alpha@1.0.0 -> 1.0.1");
    expect(output).toContain("    -- Files");
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
    expect(parseBatchArgs(["--detail", "--diff", "old.json", "new.json"])).toMatchObject({
      detail: true,
      diff: true
    });
    expect(parseArgs(["left@1.0.0", "left@1.0.1"]).positionals).toEqual(["left@1.0.0", "left@1.0.1"]);
  });

  it("documents top-level and batch help", () => {
    expect(helpText()).toContain("sift <name>@<old> <name>@<new> [options]");
    expect(helpText()).toContain("sift batch <old-lockfile> <new-lockfile> [options]");
    expect(batchHelpText()).toContain("--detail");
    expect(batchHelpText()).toContain("Unsupported in batch mode:");
    expect(batchHelpText()).toContain("--advisories");
  });

  it("rejects bad batch arity and concurrency", () => {
    expect(() => parseBatchArgs(["old.json"])).toThrow("Expected exactly two lockfile inputs");
    expect(() => parseBatchArgs(["-", "-"])).toThrow("stdin for only one lockfile");
    expect(() => parseBatchArgs(["--concurrency", "0", "old.json", "new.json"])).toThrow("--concurrency must be a positive integer");
    expect(() => parseBatchArgs(["--concurrency", "1.5", "old.json", "new.json"])).toThrow("--concurrency must be a positive integer");
    expect(() => parseBatchArgs(["--concurrency", "abc", "old.json", "new.json"])).toThrow("--concurrency must be a positive integer");
  });

  it("rejects advisory sidecars in batch mode for v0", () => {
    expect(() => parseBatchArgs(["old.json", "new.json", "--advisories"])).toThrow("sift batch --advisories is not supported in v0");
    expect(() => parseBatchArgs(["old.json", "new.json", "--advisories=summary"])).toThrow("--advisories values are not supported in v0");
  });

  it("rejects batch diffs unless JSON can expose them", () => {
    expect(() => parseBatchArgs(["--diff", "old.json", "new.json"])).toThrow("sift batch --diff requires --json unless --detail is set");
    expect(parseBatchArgs(["--json", "--diff", "old.json", "new.json"])).toMatchObject({ json: true, diff: true });
  });

  it("resolves stdin and git-ref lockfile inputs", async () => {
    await expect(resolveLockfileArgument("-", { readStdin: async () => "stdin-content" })).resolves.toEqual({ content: "stdin-content", label: "stdin" });
    await expect(
      resolveLockfileArgument("HEAD:locks/pnpm-lock.yaml", {
        runGitShow: async (ref, filePath) => {
          expect(ref).toBe("HEAD");
          expect(filePath).toBe("locks/pnpm-lock.yaml");
          return "git-content";
        }
      })
    ).resolves.toEqual({ content: "git-content", label: "pnpm-lock.yaml" });
    await expect(resolveLockfileArgument("HEAD:missing.json", { runGitShow: async () => { throw new Error("fatal: path not found"); } })).rejects.toThrow(
      "Could not read lockfile HEAD:missing.json: fatal: path not found"
    );
  });

  it("runs mixed-format batches and writes format labels to JSON", async () => {
    const written: string[] = [];
    await runBatch(
      parseBatchArgs(["--json", "-", "HEAD:pnpm-lock.yaml"]),
      {
        readStdin: async () => JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "node_modules/alpha": { version: "1.0.0", resolved: "https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz" }
          }
        }),
        runGitShow: async () => `lockfileVersion: '9.0'
packages:
  alpha@1.0.0:
    resolution:
      integrity: sha512-alpha
`,
        write: (text) => written.push(text)
      }
    );

    const parsed = JSON.parse(written.join("")) as { sources: { old: string; new: string }; analyzed: unknown[]; skipped: unknown[]; errors: unknown[] };
    expect(parsed.sources).toEqual({ old: "npm package-lock v3", new: "pnpm-lock.yaml v9.0" });
    expect(parsed.analyzed).toEqual([]);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.errors).toEqual([]);
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
