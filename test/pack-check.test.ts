import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { packCheckHelpText, parsePackCheckArgs, runPackCheck } from "../src/cli.js";
import { prepareLocalPackage } from "../src/local-pack.js";
import { Report } from "../src/types.js";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("pack-check arguments", () => {
  it("defaults to the current directory and latest registry version", () => {
    expect(parsePackCheckArgs([])).toMatchObject({ input: ".", against: undefined });
  });

  it("accepts a directory or tarball with an explicit baseline", () => {
    expect(parsePackCheckArgs(["./release.tgz", "--against", "@scope/pkg@1.2.3", "--json", "--diff"])).toMatchObject({
      input: "./release.tgz",
      against: "@scope/pkg@1.2.3",
      json: true,
      diff: true
    });
  });

  it("documents the pre-publish command and advisory limit", () => {
    const help = packCheckHelpText();
    expect(help).toContain("packsift pack-check [dir-or-tgz]");
    expect(help).toContain("defaults to latest");
    expect(help).toContain("Advisory flags are not supported");
  });
});

describe("local package preparation", () => {
  it("extracts a prebuilt tgz with the npm package prefix stripped", async () => {
    const root = await fixtureRoot();
    const tarball = await createPackageTarball(root, "local.tgz", {
      name: "local-fixture",
      version: "2.0.0"
    }, {
      "lib/index.js": "export const local = true;\n"
    });

    const prepared = await prepareLocalPackage(tarball, { keep: false });
    try {
      expect(prepared.manifest).toMatchObject({ name: "local-fixture", version: "2.0.0" });
      expect(await readFile(path.join(prepared.extractDir, "lib/index.js"), "utf8")).toBe("export const local = true;\n");
    } finally {
      await prepared.cleanup();
    }
  });

  it("runs npm pack for a directory and analyzes the packed file set", async () => {
    const root = await fixtureRoot();
    const packageDir = path.join(root, "source");
    await mkdir(packageDir);
    await writeFile(path.join(packageDir, "package.json"), JSON.stringify({
      name: "directory-fixture",
      version: "3.0.0",
      files: ["published.js"]
    }));
    await writeFile(path.join(packageDir, "published.js"), "module.exports = 'packed';\n");
    await writeFile(path.join(packageDir, "excluded.js"), "module.exports = 'excluded';\n");

    const prepared = await prepareLocalPackage(packageDir, { keep: false });
    try {
      expect(await readFile(path.join(prepared.extractDir, "published.js"), "utf8")).toContain("packed");
      await expect(readFile(path.join(prepared.extractDir, "excluded.js"), "utf8")).rejects.toThrow();
    } finally {
      await prepared.cleanup();
    }
  });
});

describe("pack-check comparison", () => {
  it("compares a local pack with the registry latest through the transition evidence engine", async () => {
    const root = await fixtureRoot();
    const oldTarball = await createPackageTarball(root, "old.tgz", {
      name: "fixture-pkg",
      version: "1.0.0",
      maintainers: [{ name: "registry-maintainer" }]
    }, {
      "index.js": "module.exports = 1;\n"
    });
    const localTarball = await createPackageTarball(root, "local.tgz", {
      name: "fixture-pkg",
      version: "2.0.0",
      scripts: { postinstall: "node install.js" },
      bin: { fixture: "cli.js" }
    }, {
      "index.js": "module.exports = 2;\n",
      "install.js": "require('dns');\n",
      "cli.js": "#!/usr/bin/env node\n"
    });
    const oldBytes = await readFile(oldTarball);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = input.toString();
      if (url === "https://registry.test/fixture-pkg") {
        return new Response(JSON.stringify({
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "1.0.0": {
              name: "fixture-pkg",
              version: "1.0.0",
              maintainers: [{ name: "registry-maintainer" }],
              _npmUser: { name: "registry-publisher" },
              dist: { tarball: "https://registry.test/fixture-pkg/-/fixture-pkg-1.0.0.tgz", shasum: "wrong" }
            }
          }
        }));
      }
      if (url === "https://registry.test/fixture-pkg/-/fixture-pkg-1.0.0.tgz") {
        return new Response(new Uint8Array(oldBytes));
      }
      return new Response(null, { status: 404 });
    };

    const output: string[] = [];
    try {
      await runPackCheck(parsePackCheckArgs([localTarball, "--registry", "https://registry.test", "--json"]), {
        write: (text) => output.push(text)
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const report = JSON.parse(output.join("")) as Report;
    expect(report).toMatchObject({
      packageName: "fixture-pkg",
      oldVersion: "1.0.0",
      newVersion: "2.0.0"
    });
    expect(report.signals.map((signal) => signal.id)).toEqual(expect.arrayContaining([
      "lifecycle-scripts",
      "install-path-network",
      "new-bin"
    ]));
    expect(report.signals.map((signal) => signal.id)).not.toContain("maintainer-publisher");
    expect(report.integrityWarnings).toEqual([
      expect.objectContaining({ version: "1.0.0", kind: "shasum", expected: "wrong" })
    ]);
  });

  it("fails closed when the package has no published latest baseline", async () => {
    const root = await fixtureRoot();
    const localTarball = await createPackageTarball(root, "local.tgz", {
      name: "never-published",
      version: "1.0.0"
    });
    await expect(runPackCheck(parsePackCheckArgs([localTarball]), {
      resolvePublishedVersion: async () => {
        throw new Error("Package has no published latest version on the configured registry: never-published");
      }
    })).rejects.toThrow("Package has no published latest version");
  });

  it("rejects advisory queries for the unpublished local side before packing", async () => {
    let prepared = false;
    await expect(runPackCheck(parsePackCheckArgs([".", "--advisories"]), {
      prepareLocalPackage: async () => {
        prepared = true;
        throw new Error("must not run");
      }
    })).rejects.toThrow("does not support --advisories");
    expect(prepared).toBe(false);
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "packsift-pack-check-test-"));
  cleanupRoots.push(root);
  return root;
}

async function createPackageTarball(
  root: string,
  filename: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {}
): Promise<string> {
  const source = path.join(root, `${filename}-source`);
  const packageDir = path.join(source, "package");
  await mkdir(packageDir, { recursive: true });
  await writeFile(path.join(packageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(packageDir, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const tarball = path.join(root, filename);
  await tar.c({ cwd: source, file: tarball, gzip: true }, ["package"]);
  return tarball;
}
