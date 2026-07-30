import { describe, expect, it } from "vitest";
import { analyzeBatch, classifyTransitions, formatBatchHuman } from "../src/index.js";
import { applyBatchExitCode, batchHelpText, helpText, parseArgs, parseBatchArgs, resolveLockfileArgument, runBatch } from "../src/cli.js";
import { FetchPackageResult, FetchResult } from "../src/registry.js";
import { Advisory, ClassifiedTransitions, InspectReport, PackageManifest, Report } from "../src/types.js";

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
      analyzed: [{ kind: "transition", name: "alpha", oldVersion: "1.0.0", newVersion: "1.0.1" }],
      added: [{ kind: "added", name: "delta", version: "1.0.0" }],
      skipped: [
        { name: "gamma", reason: "removed" },
        { name: "multi", reason: "multiple-versions" }
      ]
    });
  });

  it("sorts analyzed and skipped entries alphabetically", () => {
    const classified = classifyTransitions(mapOf({ zebra: ["1"], alpha: ["1"], removed: ["1"] }), mapOf({ zebra: ["2"], alpha: ["2"], added: ["1"] }));

    expect(classified.analyzed.map((entry) => entry.name)).toEqual(["alpha", "zebra"]);
    expect(classified.added.map((entry) => entry.name)).toEqual(["added"]);
    expect(classified.skipped.map((entry) => entry.name)).toEqual(["removed"]);
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

  it("runs added dependencies through single-package inspection", async () => {
    const report = await analyzeBatch(
      {
        analyzed: [],
        added: [
          { kind: "added", name: "zebra", version: "1.0.0" },
          { kind: "added", name: "alpha", version: "2.0.0" }
        ],
        skipped: [{ name: "removed-only", reason: "removed" }]
      },
      { registry: "https://registry.test", keep: false, concurrency: 2 },
      {
        fetchPackage: async (spec, options) => {
          expect(options.registry).toBe("https://registry.test");
          return fetchPackageResult(spec.name, spec.version);
        },
        inspectPackage: async (input) => inspectReportFor(input.packageName, input.version)
      }
    );

    expect(report.added?.map((entry) => `${entry.name}@${entry.report.version}`)).toEqual(["alpha@2.0.0", "zebra@1.0.0"]);
    expect(report.skipped).toEqual([{ name: "removed-only", reason: "removed" }]);
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

  it("attaches per-package advisory sidecars with bounded concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const advisoryCalls: string[] = [];
    const report = await analyzeBatch(
      {
        analyzed: [
          { name: "zebra", oldVersion: "1.0.0", newVersion: "1.0.1" },
          { name: "alpha", oldVersion: "2.0.0", newVersion: "2.0.1" }
        ],
        skipped: [{ name: "added-only", reason: "added" }]
      },
      {
        registry: "https://registry.test",
        keep: false,
        concurrency: 1,
        advisories: {
          fetchAdvisories: async (name, version) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            advisoryCalls.push(`${name}@${version}`);
            await delay(5);
            inFlight -= 1;
            return [{ id: `ADV-${name}-${version}`, aliases: [], severity: "LOW", affectedRanges: [], references: [] }];
          },
          now: () => new Date("2026-06-23T12:00:00.000Z"),
          source: "OSV.dev"
        }
      },
      {
        fetchArtifacts: async (oldSpec, newSpec) => fetchResult(oldSpec.name, oldSpec.version, newSpec.version),
        analyze: async (input) => reportFor(input.packageName, input.oldVersion, input.newVersion)
      }
    );

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(advisoryCalls).toEqual(["zebra@1.0.0", "zebra@1.0.1", "alpha@2.0.0", "alpha@2.0.1"]);
    expect(report.analyzed.map((entry) => entry.name)).toEqual(["alpha", "zebra"]);
    expect(report.analyzed.every((entry) => entry.advisorySidecar?.fetchedAt === "2026-06-23T12:00:00.000Z")).toBe(true);
    expect(report.skipped[0]).not.toHaveProperty("advisorySidecar");
  });

  it("attaches single-version advisory sidecars to added dependencies", async () => {
    const advisoryCalls: string[] = [];
    const report = await analyzeBatch(
      {
        analyzed: [],
        added: [{ kind: "added", name: "alpha", version: "1.0.0" }],
        skipped: []
      },
      {
        registry: "https://registry.test",
        keep: false,
        advisories: {
          fetchAdvisories: async (name, version) => {
            advisoryCalls.push(`${name}@${version}`);
            return [{ id: "ADV-1", aliases: [], severity: "LOW", affectedRanges: [], references: [] }];
          },
          now: () => new Date("2026-06-23T12:00:00.000Z"),
          source: "OSV.dev"
        }
      },
      {
        fetchPackage: async (spec) => fetchPackageResult(spec.name, spec.version),
        inspectPackage: async (input) => inspectReportFor(input.packageName, input.version)
      }
    );

    expect(advisoryCalls).toEqual(["alpha@1.0.0"]);
    expect(report.added?.[0].advisorySidecar).toMatchObject({
      fetchedAt: "2026-06-23T12:00:00.000Z",
      version: { version: "1.0.0", vulns: [{ id: "ADV-1" }] }
    });
  });

  it("keeps batch analysis when one package advisory lookup fails", async () => {
    const report = await analyzeBatch(
      {
        analyzed: [
          { name: "alpha", oldVersion: "1.0.0", newVersion: "1.0.1" },
          { name: "beta", oldVersion: "2.0.0", newVersion: "2.0.1" }
        ],
        skipped: []
      },
      {
        registry: "https://registry.test",
        keep: false,
        concurrency: 2,
        advisories: {
          fetchAdvisories: async (name, version) => {
            if (name === "alpha" && version === "1.0.0") throw new Error("OSV.dev request failed: HTTP 503");
            return [];
          },
          now: () => new Date("2026-06-23T12:00:00.000Z"),
          source: "OSV.dev"
        }
      },
      {
        fetchArtifacts: async (oldSpec, newSpec) => fetchResult(oldSpec.name, oldSpec.version, newSpec.version),
        analyze: async (input) => reportFor(input.packageName, input.oldVersion, input.newVersion)
      }
    );

    expect(report.errors).toEqual([]);
    expect(report.analyzed.find((entry) => entry.name === "alpha")?.advisorySidecar?.oldVersion).toMatchObject({
      version: "1.0.0",
      vulns: [],
      unavailable: "OSV.dev request failed: HTTP 503"
    });
    expect(report.analyzed.find((entry) => entry.name === "beta")?.advisorySidecar?.oldVersion).toMatchObject({ version: "2.0.0", vulns: [] });
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
        { name: "delta", report: reportFor("delta", "3.0.0", "3.0.1"), advisorySidecar: sidecar("3.0.0", "3.0.1", [{ id: "ADV-1", aliases: [], severity: "LOW", affectedRanges: [], references: [] }], []) }
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
    expect(output).toContain("    advisories: 1 for old / none for new");
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
    expect(output).toContain("    packsift  alpha@1.0.0 -> 1.0.1");
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
    expect(helpText()).toContain("packsift <name>@<old> <name>@<new> [options]");
    expect(helpText()).toContain("packsift batch <old-lockfile> <new-lockfile> [options]");
    expect(batchHelpText()).toContain("--detail");
    expect(batchHelpText()).toContain("--advisories");
    expect(batchHelpText()).toContain("--advisory-endpoint");
  });

  it("rejects bad batch arity and concurrency", () => {
    expect(() => parseBatchArgs(["old.json"])).toThrow("Expected exactly two lockfile inputs");
    expect(() => parseBatchArgs(["-", "-"])).toThrow("stdin for only one lockfile");
    expect(() => parseBatchArgs(["--concurrency", "0", "old.json", "new.json"])).toThrow("--concurrency must be a positive integer");
    expect(() => parseBatchArgs(["--concurrency", "1.5", "old.json", "new.json"])).toThrow("--concurrency must be a positive integer");
    expect(() => parseBatchArgs(["--concurrency", "abc", "old.json", "new.json"])).toThrow("--concurrency must be a positive integer");
  });

  it("parses advisory sidecars in batch mode", () => {
    expect(parseBatchArgs(["old.json", "new.json", "--advisories"])).toMatchObject({ advisories: "structured" });
    expect(parseBatchArgs(["old.json", "new.json", "--advisories=summary"])).toMatchObject({ advisories: "summary" });
    expect(parseBatchArgs(["old.json", "new.json", "--advisory-endpoint", "https://osv.test/v1/query"])).toMatchObject({ advisoryEndpoint: "https://osv.test/v1/query" });
    expect(() => parseBatchArgs(["old.json", "new.json", "--advisories=details"])).toThrow("Only --advisories=summary is supported");
  });

  it("rejects batch diffs unless JSON can expose them", () => {
    expect(() => parseBatchArgs(["--diff", "old.json", "new.json"])).toThrow("packsift batch --diff requires --json unless --detail is set");
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

  it("runs batch advisory sidecars through CLI JSON output", async () => {
    const written: string[] = [];
    await runBatch(
      parseBatchArgs(["--json", "--advisories=summary", "-", "HEAD:package-lock.json"]),
      {
        readStdin: async () => JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "node_modules/alpha": { version: "1.0.0", resolved: "https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz" }
          }
        }),
        runGitShow: async () => JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "node_modules/alpha": { version: "1.0.1", resolved: "https://registry.npmjs.org/alpha/-/alpha-1.0.1.tgz" }
          }
        }),
        fetchArtifacts: async (oldSpec, newSpec) => fetchResult(oldSpec.name, oldSpec.version, newSpec.version),
        analyze: async (input) => reportFor(input.packageName, input.oldVersion, input.newVersion),
        fetchAdvisories: async (_name, _version, options) => [options?.includeSummary ? { id: "ADV-1", aliases: [], summary: "third-party summary text", severity: "LOW", affectedRanges: [], references: [] } : { id: "ADV-1", aliases: [], severity: "LOW", affectedRanges: [], references: [] }],
        now: () => new Date("2026-06-23T12:00:00.000Z"),
        write: (text) => written.push(text)
      }
    );

    const parsed = JSON.parse(written.join("")) as { analyzed: { advisorySidecar?: { oldVersion: { vulns: Advisory[] } } }[] };
    expect(parsed.analyzed[0].advisorySidecar?.oldVersion.vulns[0].summary).toBe("third-party summary text");
  });

  it("applies the custom-registry advisory gate in batch mode", async () => {
    await expect(
      runBatch(parseBatchArgs(["--advisories", "--registry", "https://npm.mycorp.internal", "-", "new.json"]), {
        readStdin: async () => "{}",
        write: () => undefined
      })
    ).rejects.toThrow("--advisories with a custom registry requires --advisory-endpoint <url> or --advisories-allow-public");

    await expect(
      runBatch(parseBatchArgs(["--advisories", "--registry", "https://npm.mycorp.internal", "--advisory-endpoint", "https://api.osv.dev/v1/query?private=leak", "-", "new.json"]), {
        readStdin: async () => "{}",
        write: () => undefined
      })
    ).rejects.toThrow("--advisories with a custom registry requires --advisory-endpoint <url> or --advisories-allow-public");
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

function fetchPackageResult(name: string, version: string): FetchPackageResult {
  const manifest: PackageManifest = { name, version };
  return {
    artifacts: { spec: { raw: `${name}@${version}`, name, version }, registryManifest: manifest, tarballPath: "new.tgz", extractDir: "new", integrity: {} },
    integrityWarnings: [],
    metadata: { publishedAt: "2026-06-01T00:00:00.000Z", maintainerCount: 1, versionCount: 1 },
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

function inspectReportFor(name: string, version: string): InspectReport {
  return {
    mode: "inspect",
    packageName: name,
    version,
    integrityWarnings: [],
    signals: [],
    files: {
      summary: { added: 1, removed: 0, changed: 0 },
      entries: [{ path: "index.js", status: "added", newSize: 10 }]
    },
    size: { bytes: 10 },
    metadata: { publishedAt: "2026-06-01T00:00:00.000Z", maintainerCount: 1, versionCount: 1 }
  };
}

function sidecar(oldVersion: string, newVersion: string, oldVulns: Advisory[], newVulns: Advisory[]) {
  return {
    enabled: true as const,
    source: "OSV.dev" as const,
    fetchedAt: "2026-06-23T12:00:00.000Z",
    oldVersion: { version: oldVersion, vulns: oldVulns },
    newVersion: { version: newVersion, vulns: newVulns }
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
