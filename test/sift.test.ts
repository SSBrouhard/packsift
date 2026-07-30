import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { describe, expect, it } from "vitest";
import { analyze, formatHuman, formatInspectHuman, inspectPackage, parsePackageSpec, verifyBytes } from "../src/index.js";
import { inspectHelpText, parseArgs, runInspect, runSingleTransition } from "../src/cli.js";
import { FetchPackageResult, fetchArtifacts } from "../src/registry.js";
import { Advisory, InspectReport, PackageManifest, Report } from "../src/types.js";

describe("package specs", () => {
  it("parses scoped package specs from the final @", () => {
    expect(parsePackageSpec("@scope/pkg@1.2.3")).toEqual({
      raw: "@scope/pkg@1.2.3",
      name: "@scope/pkg",
      version: "1.2.3"
    });
  });

  it("mismatched package names error clearly", async () => {
    await expect(run({ oldManifest: { name: "left" }, newManifest: { name: "right" }, packageName: "left" })).resolves.toMatchObject({
      packageName: "left"
    });
    expect(() => {
      const oldSpec = parsePackageSpec("left@1.0.0");
      const newSpec = parsePackageSpec("right@1.0.0");
      if (oldSpec.name !== newSpec.name) throw new Error(`Package names differ: ${oldSpec.name} vs ${newSpec.name}`);
    }).toThrow("Package names differ: left vs right");
  });
});

describe("reports", () => {
  it("clean patch bump prints no notable supply-chain signals", async () => {
    const report = await run({
      oldFiles: { "package.json": JSON.stringify({ name: "pkg", version: "1.0.0" }), "index.js": "module.exports = 1;\n" },
      newFiles: { "package.json": JSON.stringify({ name: "pkg", version: "1.0.1" }), "index.js": "module.exports = 2;\n" }
    });
    const output = formatHuman(report, false);
    expect(output).toContain("No notable supply-chain signals.");
    expect(output).toContain("C  index.js");
  });

  it("identical files never appear in output", async () => {
    const manifest = { name: "pkg", version: "1.0.0" };
    const report = await run({
      oldManifest: manifest,
      newManifest: manifest,
      oldFiles: { "same.js": "const same = true;\n", "changed.js": "old\n" },
      newFiles: { "same.js": "const same = true;\n", "changed.js": "new\n" }
    });
    expect(report.files.entries.map((entry) => entry.path)).toEqual(["changed.js"]);
    expect(formatHuman(report, false)).not.toContain("same.js");
  });

  it("added lifecycle script fires the lifecycle signal", async () => {
    const report = await run({
      oldManifest: { scripts: {} },
      newManifest: { scripts: { install: "node install.js" } }
    });
    expect(signalIds(report)).toContain("lifecycle-scripts");
  });

  it("maintainer or publisher change fires the maintainer/publisher signal", async () => {
    const report = await run({
      oldRegistryManifest: { _npmUser: { name: "old" }, maintainers: [{ name: "old" }] },
      newRegistryManifest: { _npmUser: { name: "new" }, maintainers: [{ name: "old" }, { name: "new" }] }
    });
    expect(signalIds(report)).toContain("maintainer-publisher");
  });

  it("new .node or native binary payload fires executable payload signal", async () => {
    const report = await run({
      newFiles: { "binding.node": Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]) }
    });
    expect(signalIds(report)).toContain("executable-payloads");
  });

  it("newly minified source fires the minified/obfuscated heuristic", async () => {
    const longLine = `const x="${"a".repeat(2500)}";`;
    const report = await run({
      oldFiles: { "dist/app.js": "export const x = 1;\n" },
      newFiles: { "dist/app.js": longLine }
    });
    expect(signalIds(report)).toContain("minified-source");
    expect(report.files.entries.find((entry) => entry.path === "dist/app.js")?.minifiedHeuristic).toBe(true);
  });

  it("already minified changed source does not fire newly minified heuristic", async () => {
    const oldLine = `const x="${"a".repeat(2500)}";`;
    const newLine = `const x="${"b".repeat(2500)}";`;
    const report = await run({
      oldFiles: { "dist/app.js": oldLine },
      newFiles: { "dist/app.js": newLine }
    });
    expect(signalIds(report)).not.toContain("minified-source");
  });

  it("install-path network-capable code fires the heuristic", async () => {
    const report = await run({
      newManifest: { scripts: { postinstall: "node install.js" } },
      newFiles: { "install.js": "const dns = require('dns'); fetch('https://example.com');\n" }
    });
    expect(signalIds(report)).toContain("install-path-network");
  });

  it("install-path scans extensionless local imports from script directories", async () => {
    const report = await run({
      newManifest: { scripts: { postinstall: "node scripts/install.js" } },
      newFiles: {
        "scripts/install.js": "require('./net');\n",
        "scripts/net.js": "const dns = require('dns');\n"
      }
    });
    expect(signalIds(report)).toContain("install-path-network");
  });

  it("install-path ignores refs that escape the package root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sift-escape-test-"));
    const oldDir = path.join(root, "old");
    const newDir = path.join(root, "new");
    const oldManifest = { name: "pkg", version: "1.0.0" };
    const newManifest = { name: "pkg", version: "1.0.1", scripts: { postinstall: "node ../outside.js" } };
    await materialize(oldDir, { "package.json": `${JSON.stringify(oldManifest)}\n` });
    await materialize(newDir, { "package.json": `${JSON.stringify(newManifest)}\n` });
    await writeFile(path.join(root, "outside.js"), "const dns = require('dns');\n");
    try {
      const report = await analyze(
        {
          packageName: "pkg",
          oldVersion: "1.0.0",
          newVersion: "1.0.1",
          oldDir,
          newDir,
          oldRegistryManifest: oldManifest,
          newRegistryManifest: newManifest
        },
        { includeDiffs: false }
      );
      expect(signalIds(report)).not.toContain("install-path-network");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("added binding.gyp with command substitution fires native build config", async () => {
    const report = await run({
      newFiles: {
        "binding.gyp": "{ 'targets': [{ 'target_name': 'x', 'variables': { 'out': '<!(node index.js)' } }] }\n",
        "index.js": "console.log('build');\n"
      }
    });
    const signal = findSignal(report, "native-build-config");

    expect(signal).toBeDefined();
    expect(signal?.details).toMatchObject({
      files: ["binding.gyp"],
      commandSubstitutions: [{ file: "binding.gyp", expression: "<!(node index.js)" }],
      nativeSourcesPresent: false
    });
  });

  it("captures gyp list expansion command substitutions", async () => {
    const report = await run({
      newFiles: {
        "binding.gyp": "{ 'sources': [ '<!@(node scripts/sources.js)' ] }\n",
        "scripts/sources.js": "console.log('src.cc');\n"
      }
    });
    const signal = findSignal(report, "native-build-config");

    expect(signal?.details).toMatchObject({
      commandSubstitutions: [{ file: "binding.gyp", expression: "<!@(node scripts/sources.js)" }]
    });
  });

  it("captures gyp command substitutions with quoted inner calls", async () => {
    const report = await run({
      newFiles: {
        "binding.gyp": `{ 'include_dirs': [ '<!(node -p "require('node-addon-api').include")' ] }\n`
      }
    });
    const signal = findSignal(report, "native-build-config");

    expect(signal?.details).toMatchObject({
      commandSubstitutions: [{ file: "binding.gyp", expression: `<!(node -p "require('node-addon-api').include")` }]
    });
  });

  it("captures gyp command substitutions with balanced nested calls", async () => {
    const report = await run({
      newFiles: {
        "binding.gyp": "{ 'variables': { 'out': '<!(node scripts/gen.js --expr call(foo))' } }\n"
      }
    });
    const signal = findSignal(report, "native-build-config");

    expect(signal?.details).toMatchObject({
      commandSubstitutions: [{ file: "binding.gyp", expression: "<!(node scripts/gen.js --expr call(foo))" }]
    });
  });

  it("changed gyp files fire while unchanged gyp files do not", async () => {
    const unchanged = "{ 'targets': [] }\n";
    const report = await run({
      oldFiles: {
        "binding.gyp": unchanged,
        "addon.gyp": "{ 'targets': [] }\n"
      },
      newFiles: {
        "binding.gyp": unchanged,
        "addon.gyp": "{ 'targets': [{ 'target_name': 'addon' }] }\n"
      }
    });
    const signal = findSignal(report, "native-build-config");

    expect(signal?.details).toMatchObject({ files: ["addon.gyp"] });
    expect(JSON.stringify(signal?.details)).not.toContain("binding.gyp");
  });

  it("binding.gyp with no substitution still fires and records build command arrays", async () => {
    const report = await run({
      newFiles: {
        "binding.gyp": "{ 'actions': [{ 'action': ['python3', 'configure.py'] }] }\n",
        "configure.py": "print('configure')\n"
      }
    });
    const signal = findSignal(report, "native-build-config");

    expect(signal?.details).toMatchObject({
      files: ["binding.gyp"],
      commandSubstitutions: [],
      commands: [{ file: "binding.gyp", command: "python3 configure.py" }],
      nativeSourcesPresent: false
    });
  });

  it("detects .gyp and .gypi files", async () => {
    const report = await run({
      newFiles: {
        "addon.gyp": "{ 'targets': [] }\n",
        "config/common.gypi": "{ 'variables': {} }\n"
      }
    });

    expect(findSignal(report, "native-build-config")?.details).toMatchObject({
      files: ["addon.gyp", "config/common.gypi"]
    });
  });

  it("records native source presence for gyp packages", async () => {
    const report = await run({
      newFiles: {
        "binding.gyp": "{ 'targets': [{ 'sources': ['src/addon.cc'] }] }\n",
        "src/addon.cc": "int main() { return 0; }\n"
      }
    });

    expect(findSignal(report, "native-build-config")?.details).toMatchObject({ nativeSourcesPresent: true });
  });

  it("gyp-seeded install path finds network terms without lifecycle scripts", async () => {
    const report = await run({
      newFiles: {
        "binding.gyp": "{ 'targets': [{ 'variables': { 'out': '<!(node index.js)' } }] }\n",
        "index.js": "const dns = require('dns'); fetch('https://example.com');\n"
      }
    });
    const signal = findSignal(report, "install-path-network");

    expect(signal).toBeDefined();
    expect(signal?.details).toMatchObject({
      hits: [{ source: "binding.gyp -> index.js", terms: ["http", "https", "fetch", "dns"] }]
    });
  });

  it("gyp-seeded install path scans one-hop local imports", async () => {
    const report = await run({
      newFiles: {
        "binding.gyp": "{ 'targets': [{ 'variables': { 'out': '<!(node index.js)' } }] }\n",
        "index.js": "require('./helper');\n",
        "helper.js": "const dns = require('dns');\n"
      }
    });
    const signal = findSignal(report, "install-path-network");

    expect(signal?.details).toMatchObject({
      hits: [{ source: "binding.gyp -> index.js -> helper.js", terms: ["dns"] }]
    });
  });

  it("gyp-seeded install path ignores refs that escape the package root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sift-gyp-escape-test-"));
    const oldDir = path.join(root, "old");
    const newDir = path.join(root, "new");
    const oldManifest = { name: "pkg", version: "1.0.0" };
    const newManifest = { name: "pkg", version: "1.0.1" };
    await materialize(oldDir, { "package.json": `${JSON.stringify(oldManifest)}\n` });
    await materialize(newDir, {
      "package.json": `${JSON.stringify(newManifest)}\n`,
      "binding.gyp": "{ 'variables': { 'out': '<!(node ../outside.js)' } }\n"
    });
    await writeFile(path.join(root, "outside.js"), "const dns = require('dns');\n");
    try {
      const report = await analyze(
        {
          packageName: "pkg",
          oldVersion: "1.0.0",
          newVersion: "1.0.1",
          oldDir,
          newDir,
          oldRegistryManifest: oldManifest,
          newRegistryManifest: newManifest
        },
        { includeDiffs: false }
      );
      expect(signalIds(report)).toContain("native-build-config");
      expect(signalIds(report)).not.toContain("install-path-network");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("JSON includes native build config signal details", async () => {
    const report = await run({
      newFiles: {
        "binding.gyp": "{ 'targets': [{ 'variables': { 'out': '<!(node index.js)' } }] }\n",
        "index.js": "console.log('build');\n"
      }
    });
    const json = JSON.parse(JSON.stringify(report)) as Report;

    expect(json.signals.find((signal) => signal.id === "native-build-config")).toMatchObject({
      title: "Native build configuration",
      details: {
        files: ["binding.gyp"],
        commandSubstitutions: [{ file: "binding.gyp", expression: "<!(node index.js)" }],
        nativeSourcesPresent: false
      }
    });
  });

  it("new bin entry fires", async () => {
    const report = await run({
      oldManifest: { name: "pkg", bin: {} },
      newManifest: { name: "pkg", bin: { sift: "cli.js" } }
    });
    expect(signalIds(report)).toContain("new-bin");
  });

  it("large size delta fires with threshold label", async () => {
    const report = await run({
      oldFiles: { "small.txt": "a" },
      newFiles: { "small.txt": "a", "large.txt": "x".repeat(1024 * 1024 + 2) }
    });
    expect(signalIds(report)).toContain("size-delta");
    expect(report.sizeDelta.threshold).toBe("> 2x or > +1 MB");
  });

  it("dependency field changes fire", async () => {
    const report = await run({
      oldManifest: { dependencies: { left: "1.0.0" }, devDependencies: { dev: "1.0.0" } },
      newManifest: { dependencies: { left: "2.0.0", right: "1.0.0" }, devDependencies: { dev: "1.0.1" } }
    });
    expect(signalIds(report)).toContain("dependency-fields");
  });

  it("license field or LICENSE file change fires", async () => {
    const report = await run({
      oldManifest: { license: "MIT" },
      newManifest: { license: "Apache-2.0" },
      oldFiles: { LICENSE: "old\n" },
      newFiles: { LICENSE: "new\n" }
    });
    expect(signalIds(report)).toContain("license");
  });

  it("integrity/shasum mismatch is represented and does not hard-fail", () => {
    const bytes = Buffer.from("real tarball");
    const warnings = verifyBytes("1.0.0", bytes, { integrity: "sha512-bad", shasum: "bad" });
    expect(warnings.map((warning) => warning.kind)).toEqual(["integrity", "shasum"]);
  });

  it("cleans artifact temp root when a later fetch fails", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "sift-fetch-test-"));
    const originalTmpdir = process.env.TMPDIR;
    const originalFetch = globalThis.fetch;
    const oldTarball = await packageTarball(sandbox, "old.tgz");
    process.env.TMPDIR = `${sandbox}${path.sep}`;
    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url === "https://registry.test/pkg") {
        return new Response(
          JSON.stringify({
            versions: {
              "1.0.0": { name: "pkg", version: "1.0.0", dist: { tarball: "https://registry.test/old.tgz" } },
              "1.0.1": { name: "pkg", version: "1.0.1", dist: { tarball: "https://registry.test/new.tgz" } }
            }
          })
        );
      }
      if (url === "https://registry.test/old.tgz") return new Response(new Uint8Array(oldTarball));
      if (url === "https://registry.test/new.tgz") throw new Error("new fetch failed");
      return new Response(null, { status: 404 });
    };
    globalThis.fetch = mockFetch;
    try {
      await expect(
        fetchArtifacts(
          { raw: "pkg@1.0.0", name: "pkg", version: "1.0.0" },
          { raw: "pkg@1.0.1", name: "pkg", version: "1.0.1" },
          { registry: "https://registry.test", keep: false }
        )
      ).rejects.toThrow("new fetch failed");
      expect((await readdir(sandbox)).filter((entry) => entry.startsWith("sift-"))).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTmpdir;
      }
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("--json emits structured equivalent data", async () => {
    const report = await run({ newFiles: { "added.js": "new\n" } });
    const json = JSON.parse(JSON.stringify(report)) as Report;
    expect(json.packageName).toBe("pkg");
    expect(json.files.summary.added).toBe(1);
    expect(json.files.entries[0].path).toBe("added.js");
  });

  it("--diff prints full text diffs while default remains compact", async () => {
    const report = await run({
      includeDiffs: true,
      oldFiles: { "index.js": "const value = 1;\n" },
      newFiles: { "index.js": "const value = 2;\n" }
    });
    expect(formatHuman(report, false)).not.toContain("-- Diffs");
    expect(formatHuman(report, true)).toContain("-- Diffs");
    expect(formatHuman(report, true)).toContain("-const value = 1;");
    expect(formatHuman(report, true)).toContain("+const value = 2;");
  });
});

describe("inspect reports", () => {
  it("reuses the signal engine for a single package without a baseline", async () => {
    const report = await runInspectFixture({
      manifest: {
        name: "fresh-pkg",
        version: "1.0.0",
        scripts: { preinstall: "node install.js" },
        bin: { fresh: "cli.js" },
        dependencies: { leftpad: "^1.0.0" }
      },
      registryManifest: {
        name: "fresh-pkg",
        version: "1.0.0",
        maintainers: [{ name: "maintainer" }],
        _npmUser: { name: "publisher" },
        dist: { unpackedSize: 4096 }
      },
      files: {
        "install.js": "const beacon = 'https://beacon.example/upload'; require('./payload');\n",
        "payload.js": "module.exports = require('dns');\n",
        "cli.js": "#!/usr/bin/env node\nconsole.log('cli');\n",
        "binding.gyp": JSON.stringify({ targets: [{ target_name: "addon", actions: [["node", "build.js"]] }] }),
        "build.js": "console.log('build');\n",
        "packed.js": `const x="${"a".repeat(2500)}";`
      }
    });

    expect(signalIds(report)).toEqual(expect.arrayContaining([
      "lifecycle-scripts",
      "maintainer-publisher",
      "minified-source",
      "native-build-config",
      "install-path-network",
      "new-bin",
      "dependency-fields"
    ]));
    expect(report.files.summary.added).toBe(7);
    expect(report.size).toEqual({ bytes: expect.any(Number), unpackedSize: 4096 });
  });

  it("formats inspect human output with metadata, size, inventory, and advisory sidecar", async () => {
    const report = await runInspectFixture({
      manifest: { name: "fresh-pkg", version: "1.0.0", scripts: { postinstall: "node install.js" } },
      registryManifest: { name: "fresh-pkg", version: "1.0.0", dist: { unpackedSize: 100 } },
      metadata: { publishedAt: "2026-06-15T00:00:00.000Z", maintainerCount: 2, versionCount: 1 },
      files: { "install.js": "console.log('install');\n" }
    });

    const output = formatInspectHuman(report, {
      enabled: true,
      source: "OSV.dev",
      fetchedAt: "2026-06-23T12:00:00.000Z",
      version: { version: "1.0.0", vulns: [] }
    });

    expect(output).toContain("packsift inspect  fresh-pkg@1.0.0");
    expect(output).toContain("published: 2026-06-15T00:00:00.000Z");
    expect(output).toContain("maintainers: 2");
    expect(output).toContain("versions: 1");
    expect(output).toContain("unpacked bytes:");
    expect(output).toContain("A  install.js");
    expect(output).toContain("version 1.0.0");
  });

  it("runs inspect CLI JSON and queries advisories for the inspected version only", async () => {
    const written: string[] = [];
    const advisoryCalls: string[] = [];
    await runInspect(parseArgs(["pkg@1.0.0", "--json", "--advisories=summary"]), {
      fetchPackage: async (spec) => fetchPackageResult(spec.name, spec.version),
      inspectPackage: async (input) => inspectReportFor(input.packageName, input.version),
      fetchAdvisories: async (name, version, options) => {
        advisoryCalls.push(`${name}@${version}`);
        return [{ id: "ADV-1", aliases: [], summary: options?.includeSummary ? "third-party summary" : undefined, severity: "LOW", affectedRanges: [], references: [] }];
      },
      now: () => new Date("2026-06-23T12:00:00.000Z"),
      write: (text) => written.push(text)
    });

    const parsed = JSON.parse(written.join("")) as InspectReport & { advisorySidecar: { version: { vulns: Advisory[] } } };
    expect(parsed.mode).toBe("inspect");
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.advisorySidecar.version.vulns[0].summary).toBe("third-party summary");
    expect(advisoryCalls).toEqual(["pkg@1.0.0"]);
  });

  it("keeps inspect human output byte-identical across runs", async () => {
    const fixture = {
      manifest: { name: "pkg", version: "1.0.0", scripts: { install: "node install.js" } },
      files: { "install.js": "console.log('install');\n" }
    };

    const first = formatInspectHuman(await runInspectFixture(fixture));
    const second = formatInspectHuman(await runInspectFixture(fixture));
    expect(second).toBe(first);
  });

  it("documents inspect help", () => {
    expect(inspectHelpText()).toContain("packsift inspect <name>@<version> [options]");
    expect(inspectHelpText()).toContain("--advisories");
  });
});

describe("advisory sidecar rendering and CLI orchestration", () => {
  it("renders old advisory plus empty new version in the target human shape", async () => {
    const report = await run();
    const output = formatHuman(report, false, {
      enabled: true,
      source: "OSV.dev",
      fetchedAt: "2026-06-23T12:00:00.000Z",
      oldVersion: { version: "0.28.16", vulns: [sampleAdvisory] },
      newVersion: { version: "0.28.17", vulns: [] }
    });

    expect(output).toContain("-- Files --------------------------------\n");
    expect(output).toContain("-- Advisory sidecar: OSV.dev fetched 2026-06-23T12:00:00.000Z --");
    expect(output).toContain("  old version 0.28.16\n    GHSA-pv5w-4p9q-p3v2");
    expect(output).toContain("      aliases: CVE-2026-44635");
    expect(output).toContain("      severity: HIGH");
    expect(output).toContain("      affected ranges: >=0.26.0 <0.28.17");
    expect(output).toContain("      references:\n        - https://github.com/kysely-org/kysely/security/advisories/GHSA-pv5w-4p9q-p3v2");
    expect(output).toContain("  new version 0.28.17\n    none returned");
  });

  it("renders OSV summary as attributed third-party passthrough when present", async () => {
    const report = await run();
    const output = formatHuman(report, false, {
      enabled: true,
      source: "OSV.dev",
      fetchedAt: "2026-06-23T12:00:00.000Z",
      oldVersion: { version: "0.28.16", vulns: [{ ...sampleAdvisory, summary: "Third-party package advisory text." }] },
      newVersion: { version: "0.28.17", vulns: [] }
    });

    expect(output).toContain("      summary (OSV): Third-party package advisory text.");
  });

  it("renders empty and unavailable advisory versions without safety wording", async () => {
    const report = await run();
    const bothEmpty = formatHuman(report, false, {
      enabled: true,
      source: "OSV.dev",
      fetchedAt: "2026-06-23T12:00:00.000Z",
      oldVersion: { version: "1.0.0", vulns: [] },
      newVersion: { version: "1.0.1", vulns: [] }
    });
    expect(bothEmpty.match(/none returned/g)).toHaveLength(2);
    expect(bothEmpty).not.toMatch(/\b(safe|clear|clean)\b/i);

    const partialFailure = formatHuman(report, false, {
      enabled: true,
      source: "OSV.dev",
      fetchedAt: "2026-06-23T12:00:00.000Z",
      oldVersion: { version: "1.0.0", vulns: [], unavailable: "OSV.dev request failed: HTTP 503" },
      newVersion: { version: "1.0.1", vulns: [sampleAdvisory] }
    });
    expect(partialFailure).toContain("advisories unavailable: OSV.dev request failed: HTTP 503");
    expect(partialFailure).toContain("new version 1.0.1\n    GHSA-pv5w-4p9q-p3v2");
  });

  it("parses bare and summary advisory modes", () => {
    expect(parseArgs(["pkg@1.0.0", "pkg@1.0.1", "--advisories"])).toMatchObject({ advisories: "structured" });
    expect(parseArgs(["pkg@1.0.0", "pkg@1.0.1", "--advisories=summary"])).toMatchObject({ advisories: "summary" });
    expect(() => parseArgs(["pkg@1.0.0", "pkg@1.0.1", "--advisories=details"])).toThrow("Only --advisories=summary is supported");
    expect(() => parseArgs(["pkg@1.0.0", "pkg@1.0.1", "--advisory-endpoint"])).toThrow("--advisory-endpoint requires a URL");
    expect(() => parseArgs(["pkg@1.0.0", "pkg@1.0.1", "--advisory-endpoint", "not-a-url"])).toThrow("--advisory-endpoint requires a valid URL");
  });

  it("fetches both advisory versions only when requested", async () => {
    const calls: string[] = [];
    const output: string[] = [];
    await runSingleTransition(parseArgs(["pkg@1.0.0", "pkg@1.0.1", "--advisories"]), {
      fetchArtifacts: async () => fetchResult("pkg", "1.0.0", "1.0.1"),
      analyze: async () => reportFor("pkg", "1.0.0", "1.0.1"),
      fetchAdvisories: async (_name, version) => {
        calls.push(version);
        return version === "1.0.0" ? [sampleAdvisory] : [];
      },
      now: () => new Date("2026-06-23T12:00:00.000Z"),
      write: (text) => output.push(text)
    });

    expect(calls).toEqual(["1.0.0", "1.0.1"]);
    expect(output.join("")).toContain("-- Advisory sidecar: OSV.dev fetched 2026-06-23T12:00:00.000Z --");

    calls.length = 0;
    output.length = 0;
    await runSingleTransition(parseArgs(["pkg@1.0.0", "pkg@1.0.1"]), {
      fetchArtifacts: async () => fetchResult("pkg", "1.0.0", "1.0.1"),
      analyze: async () => reportFor("pkg", "1.0.0", "1.0.1"),
      fetchAdvisories: async (_name, version) => {
        calls.push(version);
        return [];
      },
      write: (text) => output.push(text)
    });
    expect(calls).toEqual([]);
    expect(output.join("")).not.toContain("Advisory sidecar");
  });

  it("rejects advisories with a custom registry before advisory fetching", async () => {
    let artifactCalls = 0;
    let advisoryCalls = 0;

    await expect(
      runSingleTransition(parseArgs(["pkg@1.0.0", "pkg@1.0.1", "--advisories", "--registry", "https://npm.mycorp.internal"]), {
        fetchArtifacts: async () => {
          artifactCalls += 1;
          return fetchResult("pkg", "1.0.0", "1.0.1");
        },
        analyze: async () => reportFor("pkg", "1.0.0", "1.0.1"),
        fetchAdvisories: async () => {
          advisoryCalls += 1;
          return [];
        }
      })
    ).rejects.toThrow("--advisories with a custom registry requires --advisory-endpoint <url> or --advisories-allow-public");
    expect(artifactCalls).toBe(0);
    expect(advisoryCalls).toBe(0);
  });

  it("uses a private advisory endpoint for custom registries", async () => {
    const requestedEndpoints: (string | undefined)[] = [];
    const output: string[] = [];
    const jsonOutput: string[] = [];

    await runSingleTransition(parseArgs(["pkg@1.0.0", "pkg@1.0.1", "--advisories", "--registry", "https://npm.mycorp.internal", "--advisory-endpoint", "https://osv.mycorp.internal/v1/query"]), {
      fetchArtifacts: async () => fetchResult("pkg", "1.0.0", "1.0.1"),
      analyze: async () => reportFor("pkg", "1.0.0", "1.0.1"),
      fetchAdvisories: async (_name, _version, options) => {
        requestedEndpoints.push(options?.endpoint);
        return [];
      },
      now: () => new Date("2026-06-23T12:00:00.000Z"),
      write: (text) => output.push(text)
    });

    expect(requestedEndpoints).toEqual(["https://osv.mycorp.internal/v1/query", "https://osv.mycorp.internal/v1/query"]);
    expect(output.join("")).toContain("-- Advisory sidecar: OSV-compatible endpoint: https://osv.mycorp.internal/v1/query fetched 2026-06-23T12:00:00.000Z --");

    await runSingleTransition(parseArgs(["pkg@1.0.0", "pkg@1.0.1", "--json", "--advisories", "--registry", "https://npm.mycorp.internal", "--advisory-endpoint", "https://osv.mycorp.internal/v1/query"]), {
      fetchArtifacts: async () => fetchResult("pkg", "1.0.0", "1.0.1"),
      analyze: async () => reportFor("pkg", "1.0.0", "1.0.1"),
      fetchAdvisories: async () => [],
      now: () => new Date("2026-06-23T12:00:00.000Z"),
      write: (text) => jsonOutput.push(text)
    });

    expect(JSON.parse(jsonOutput.join("")).advisorySidecar.source).toBe("OSV-compatible endpoint: https://osv.mycorp.internal/v1/query");
  });

  it("redacts private advisory endpoint secrets from output", async () => {
    const endpoint = "https://user:token@osv.mycorp.internal/v1/query?api_key=secret#frag";
    const output: string[] = [];
    const jsonOutput: string[] = [];

    await runSingleTransition(parseArgs(["pkg@1.0.0", "pkg@1.0.1", "--advisories", "--registry", "https://npm.mycorp.internal", "--advisory-endpoint", endpoint]), {
      fetchArtifacts: async () => fetchResult("pkg", "1.0.0", "1.0.1"),
      analyze: async () => reportFor("pkg", "1.0.0", "1.0.1"),
      fetchAdvisories: async () => [],
      now: () => new Date("2026-06-23T12:00:00.000Z"),
      write: (text) => output.push(text)
    });

    expect(output.join("")).toContain("-- Advisory sidecar: OSV-compatible endpoint: https://osv.mycorp.internal/v1/query fetched 2026-06-23T12:00:00.000Z --");
    expect(output.join("")).not.toMatch(/user|token|api_key|secret|frag/);

    await runSingleTransition(parseArgs(["pkg@1.0.0", "pkg@1.0.1", "--json", "--advisories", "--registry", "https://npm.mycorp.internal", "--advisory-endpoint", endpoint]), {
      fetchArtifacts: async () => fetchResult("pkg", "1.0.0", "1.0.1"),
      analyze: async () => reportFor("pkg", "1.0.0", "1.0.1"),
      fetchAdvisories: async () => [],
      now: () => new Date("2026-06-23T12:00:00.000Z"),
      write: (text) => jsonOutput.push(text)
    });

    expect(JSON.stringify(JSON.parse(jsonOutput.join("")))).toContain("OSV-compatible endpoint: https://osv.mycorp.internal/v1/query");
    expect(jsonOutput.join("")).not.toMatch(/user|token|api_key|secret|frag/);
  });

  it("rejects public OSV endpoints for custom registries without acknowledgement", async () => {
    for (const endpoint of [
      "https://api.osv.dev:443/v1/query/",
      "https://api.osv.dev/v1/query?private=leak",
      "https://api.osv.dev/%76%31/query",
      "https://api.osv.dev./v1/query"
    ]) {
      let artifactCalls = 0;
      let advisoryCalls = 0;

      await expect(
        runSingleTransition(parseArgs(["pkg@1.0.0", "pkg@1.0.1", "--advisories", "--registry", "https://npm.mycorp.internal", "--advisory-endpoint", endpoint]), {
          fetchArtifacts: async () => {
            artifactCalls += 1;
            return fetchResult("pkg", "1.0.0", "1.0.1");
          },
          analyze: async () => reportFor("pkg", "1.0.0", "1.0.1"),
          fetchAdvisories: async () => {
            advisoryCalls += 1;
            return [];
          },
          write: () => undefined
        })
      ).rejects.toThrow("--advisories with a custom registry requires --advisory-endpoint <url> or --advisories-allow-public");

      expect(artifactCalls).toBe(0);
      expect(advisoryCalls).toBe(0);
    }
  });

  it("allows acknowledged public OSV endpoints for custom registries", async () => {
    const requestedEndpoints: (string | undefined)[] = [];
    const output: string[] = [];

    await runSingleTransition(parseArgs(["pkg@1.0.0", "pkg@1.0.1", "--advisories", "--registry", "https://npm.mycorp.internal", "--advisory-endpoint", "https://api.osv.dev:443/v1/query/", "--advisories-allow-public"]), {
      fetchArtifacts: async () => fetchResult("pkg", "1.0.0", "1.0.1"),
      analyze: async () => reportFor("pkg", "1.0.0", "1.0.1"),
      fetchAdvisories: async (_name, _version, options) => {
        requestedEndpoints.push(options?.endpoint);
        return [];
      },
      now: () => new Date("2026-06-23T12:00:00.000Z"),
      write: (text) => output.push(text)
    });

    expect(requestedEndpoints).toEqual(["https://api.osv.dev/v1/query/", "https://api.osv.dev/v1/query/"]);
    expect(output.join("")).toContain("-- Advisory sidecar: OSV.dev fetched 2026-06-23T12:00:00.000Z --");
  });

  it("requires an explicit acknowledgement before using public OSV with a custom registry", async () => {
    const requestedEndpoints: (string | undefined)[] = [];

    await runSingleTransition(parseArgs(["pkg@1.0.0", "pkg@1.0.1", "--advisories", "--registry", "https://npm.mycorp.internal", "--advisories-allow-public"]), {
      fetchArtifacts: async () => fetchResult("pkg", "1.0.0", "1.0.1"),
      analyze: async () => reportFor("pkg", "1.0.0", "1.0.1"),
      fetchAdvisories: async (_name, _version, options) => {
        requestedEndpoints.push(options?.endpoint);
        return [];
      },
      write: () => undefined
    });

    expect(requestedEndpoints).toEqual([undefined, undefined]);
  });

  it("keeps core report output when advisory fetching fails", async () => {
    const output: string[] = [];
    await runSingleTransition(parseArgs(["pkg@1.0.0", "pkg@1.0.1", "--advisories"]), {
      fetchArtifacts: async () => fetchResult("pkg", "1.0.0", "1.0.1"),
      analyze: async () => reportFor("pkg", "1.0.0", "1.0.1"),
      fetchAdvisories: async (_name, version) => {
        if (version === "1.0.0") throw new Error("OSV.dev request failed: HTTP 503");
        return [];
      },
      now: () => new Date("2026-06-23T12:00:00.000Z"),
      write: (text) => output.push(text)
    });

    const text = output.join("");
    expect(text).toContain("packsift  pkg@1.0.0 -> 1.0.1");
    expect(text).toContain("-- Files --------------------------------");
    expect(text).toContain("old version 1.0.0\n    advisories unavailable: OSV.dev request failed: HTTP 503");
    expect(text).toContain("new version 1.0.1\n    none returned");
  });

  it("adds advisorySidecar to JSON only when --advisories is set", async () => {
    const withOutput: string[] = [];
    await runSingleTransition(parseArgs(["pkg@1.0.0", "pkg@1.0.1", "--json", "--advisories"]), {
      fetchArtifacts: async () => fetchResult("pkg", "1.0.0", "1.0.1"),
      analyze: async () => reportFor("pkg", "1.0.0", "1.0.1"),
      fetchAdvisories: async () => [],
      now: () => new Date("2026-06-23T12:00:00.000Z"),
      write: (text) => withOutput.push(text)
    });
    const withJson = JSON.parse(withOutput.join(""));
    expect(withJson.advisorySidecar).toMatchObject({
      enabled: true,
      source: "OSV.dev",
      fetchedAt: "2026-06-23T12:00:00.000Z",
      oldVersion: { version: "1.0.0", vulns: [] },
      newVersion: { version: "1.0.1", vulns: [] }
    });
    expect(withJson.advisories).toBeUndefined();

    const withoutOutput: string[] = [];
    await runSingleTransition(parseArgs(["pkg@1.0.0", "pkg@1.0.1", "--json"]), {
      fetchArtifacts: async () => fetchResult("pkg", "1.0.0", "1.0.1"),
      analyze: async () => reportFor("pkg", "1.0.0", "1.0.1"),
      fetchAdvisories: async () => {
        throw new Error("must not run");
      },
      write: (text) => withoutOutput.push(text)
    });
    const withoutJson = JSON.parse(withoutOutput.join(""));
    expect(withoutJson.advisorySidecar).toBeUndefined();
    expect(withoutJson.advisories).toBeUndefined();
  });

  it("includes advisory summary in JSON only in summary mode", async () => {
    const structuredOutput: string[] = [];
    await runSingleTransition(parseArgs(["pkg@1.0.0", "pkg@1.0.1", "--json", "--advisories"]), {
      fetchArtifacts: async () => fetchResult("pkg", "1.0.0", "1.0.1"),
      analyze: async () => reportFor("pkg", "1.0.0", "1.0.1"),
      fetchAdvisories: async (_name, _version, options) => [options?.includeSummary ? { ...sampleAdvisory, summary: "must be dropped" } : sampleAdvisory],
      now: () => new Date("2026-06-23T12:00:00.000Z"),
      write: (text) => structuredOutput.push(text)
    });
    expect(JSON.stringify(JSON.parse(structuredOutput.join("")))).not.toContain("must be dropped");

    const summaryOutput: string[] = [];
    await runSingleTransition(parseArgs(["pkg@1.0.0", "pkg@1.0.1", "--json", "--advisories=summary"]), {
      fetchArtifacts: async () => fetchResult("pkg", "1.0.0", "1.0.1"),
      analyze: async () => reportFor("pkg", "1.0.0", "1.0.1"),
      fetchAdvisories: async (_name, _version, options) => [options?.includeSummary ? { ...sampleAdvisory, summary: "third-party summary text" } : sampleAdvisory],
      now: () => new Date("2026-06-23T12:00:00.000Z"),
      write: (text) => summaryOutput.push(text)
    });
    expect(JSON.stringify(JSON.parse(summaryOutput.join("")))).toContain("third-party summary text");
  });
});

interface RunOptions {
  packageName?: string;
  oldVersion?: string;
  newVersion?: string;
  oldFiles?: Record<string, string | Buffer>;
  newFiles?: Record<string, string | Buffer>;
  oldManifest?: PackageManifest;
  newManifest?: PackageManifest;
  oldRegistryManifest?: PackageManifest;
  newRegistryManifest?: PackageManifest;
  includeDiffs?: boolean;
}

async function run(options: RunOptions = {}): Promise<Report> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sift-test-"));
  const oldDir = path.join(root, "old");
  const newDir = path.join(root, "new");
  const oldManifest = options.oldManifest ?? { name: "pkg", version: "1.0.0" };
  const newManifest = options.newManifest ?? { name: "pkg", version: "1.0.1" };
  const oldFiles = {
    "package.json": `${JSON.stringify(oldManifest, null, 2)}\n`,
    ...(options.oldFiles ?? {})
  };
  const newFiles = {
    "package.json": `${JSON.stringify(newManifest, null, 2)}\n`,
    ...(options.newFiles ?? {})
  };
  await materialize(oldDir, oldFiles);
  await materialize(newDir, newFiles);
  return analyze(
    {
      packageName: options.packageName ?? "pkg",
      oldVersion: options.oldVersion ?? "1.0.0",
      newVersion: options.newVersion ?? "1.0.1",
      oldDir,
      newDir,
      oldRegistryManifest: options.oldRegistryManifest ?? oldManifest,
      newRegistryManifest: options.newRegistryManifest ?? newManifest
    },
    { includeDiffs: options.includeDiffs }
  );
}

async function runInspectFixture(options: {
  manifest: PackageManifest;
  registryManifest?: PackageManifest;
  metadata?: InspectReport["metadata"];
  files?: Record<string, string | Buffer>;
}): Promise<InspectReport> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sift-test-inspect-"));
  try {
    const packageDir = path.join(root, "package");
    await materialize(packageDir, {
      "package.json": `${JSON.stringify(options.manifest, null, 2)}\n`,
      ...(options.files ?? {})
    });
    return await inspectPackage({
      packageName: options.manifest.name ?? "pkg",
      version: options.manifest.version ?? "1.0.0",
      packageDir,
      registryManifest: options.registryManifest ?? options.manifest,
      metadata: options.metadata
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fetchResult(name: string, oldVersion: string, newVersion: string) {
  return {
    oldArtifacts: { spec: { raw: `${name}@${oldVersion}`, name, version: oldVersion }, registryManifest: { name, version: oldVersion }, tarballPath: "old.tgz", extractDir: "old", integrity: {} },
    newArtifacts: { spec: { raw: `${name}@${newVersion}`, name, version: newVersion }, registryManifest: { name, version: newVersion }, tarballPath: "new.tgz", extractDir: "new", integrity: {} },
    integrityWarnings: [],
    cleanup: async () => undefined
  };
}

function fetchPackageResult(name: string, version: string): FetchPackageResult {
  return {
    artifacts: { spec: { raw: `${name}@${version}`, name, version }, registryManifest: { name, version }, tarballPath: "new.tgz", extractDir: "new", integrity: {} },
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

const sampleAdvisory: Advisory = {
  id: "GHSA-pv5w-4p9q-p3v2",
  aliases: ["CVE-2026-44635"],
  severity: "HIGH",
  affectedRanges: [">=0.26.0 <0.28.17"],
  references: ["https://github.com/kysely-org/kysely/security/advisories/GHSA-pv5w-4p9q-p3v2"]
};

async function materialize(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [filePath, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, filePath)), { recursive: true });
    await writeFile(path.join(root, filePath), contents);
  }
}

async function packageTarball(root: string, fileName: string): Promise<Buffer> {
  const packageRoot = path.join(root, `${fileName}-contents`, "package");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), '{"name":"pkg"}\n');
  const tarballPath = path.join(root, fileName);
  await tar.c({ file: tarballPath, gzip: true, cwd: path.dirname(packageRoot) }, ["package"]);
  return readFile(tarballPath);
}

function signalIds(report: Pick<Report, "signals">): string[] {
  return report.signals.map((signal) => signal.id);
}

function findSignal(report: Report, id: string) {
  return report.signals.find((signal) => signal.id === id);
}

function sri(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}
