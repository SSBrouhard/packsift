import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { describe, expect, it } from "vitest";
import { analyze, formatHuman, parsePackageSpec, verifyBytes } from "../src/index.js";
import { fetchArtifacts } from "../src/registry.js";
import { PackageManifest, Report } from "../src/types.js";

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

function signalIds(report: Report): string[] {
  return report.signals.map((signal) => signal.id);
}

function sri(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}
