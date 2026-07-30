import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const helper = path.resolve("scripts/no-mistakes-packsift-check.sh");
const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("no-mistakes PackSift helper", () => {
  it("runs batch evidence for a lockfile changed from the base branch", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.repo, "package-lock.json"), lockfile("2.0.0"));

    const result = runHelper(fixture, ["--base", "main", "--json"]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "dependencies",
      results: [{ fixture: "evidence" }],
      events: [{ type: "batch", path: "package-lock.json" }],
      errors: [],
    });
    expect(result.stderr).toContain("PackSift dependency evidence: batch");
    expect(await readFile(fixture.log, "utf8")).toMatch(
      /^batch [0-9a-f]+:package-lock\.json package-lock\.json --json\n$/,
    );
  });

  it("runs batch evidence for a changed npm shrinkwrap file", async () => {
    const fixture = await createFixture("npm-shrinkwrap.json");
    await writeFile(path.join(fixture.repo, "npm-shrinkwrap.json"), lockfile("2.0.0"));

    const result = runHelper(fixture, ["--base", "main"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PackSift dependency evidence: batch");
    expect(await readFile(fixture.log, "utf8")).toMatch(
      /^batch [0-9a-f]+:npm-shrinkwrap\.json npm-shrinkwrap\.json\n$/,
    );
  });

  it("does not invent a package transition for a package.json-only change", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.repo, "package.json"), '{"name":"fixture","dependencies":{"left-pad":"1.3.0"}}\n');

    const result = runHelper(fixture, ["--base", "main"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("package.json changed, but no existing changed lockfile can be compared");
    expect(await readFile(fixture.log, "utf8")).toBe("");
  });

  it("runs pack-check in release mode", async () => {
    const fixture = await createFixture();

    const result = runHelper(fixture, ["release", ".", "--json"]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "release",
      input: ".",
      results: [{ fixture: "evidence" }],
      events: [{ type: "pre-publish", path: "." }],
      errors: [],
    });
    expect(result.stderr).toContain("PackSift pre-publish evidence: pack-check .");
    expect(await readFile(fixture.log, "utf8")).toBe("pack-check . --json\n");
  });

  it("emits one JSON envelope for no-op and multiple-lockfile paths", async () => {
    const noOpFixture = await createFixture();
    const noOpResult = runHelper(noOpFixture, ["--base", "main", "--json"]);
    const noOpEnvelope = JSON.parse(noOpResult.stdout);

    expect(noOpResult.status).toBe(0);
    expect(noOpEnvelope).toMatchObject({
      mode: "dependencies",
      results: [],
      events: [{ type: "no-changes" }],
      errors: [],
    });

    const packageFixture = await createFixture();
    await writeFile(path.join(packageFixture.repo, "package.json"), '{"name":"fixture","dependencies":{"left-pad":"1.3.0"}}\n');
    const packageResult = runHelper(packageFixture, ["--base", "main", "--json"]);
    const packageEnvelope = JSON.parse(packageResult.stdout);

    expect(packageResult.status).toBe(0);
    expect(packageEnvelope).toMatchObject({
      mode: "dependencies",
      results: [],
      events: [{ type: "package-json-changed", path: "package.json" }],
      errors: [],
    });

    const newLockfileFixture = await createFixture();
    await writeFile(path.join(newLockfileFixture.repo, "npm-shrinkwrap.json"), lockfile("2.0.0"));
    const newLockfileResult = runHelper(newLockfileFixture, ["--base", "main", "--json"]);
    const newLockfileEnvelope = JSON.parse(newLockfileResult.stdout);

    expect(newLockfileResult.status).toBe(0);
    expect(newLockfileEnvelope).toMatchObject({
      mode: "dependencies",
      results: [],
      events: [{ type: "new-lockfile", path: "npm-shrinkwrap.json" }],
      errors: [],
    });

    const multiFixture = await createFixture(["package-lock.json", "npm-shrinkwrap.json"]);
    await writeFile(path.join(multiFixture.repo, "package-lock.json"), lockfile("2.0.0"));
    await writeFile(path.join(multiFixture.repo, "npm-shrinkwrap.json"), lockfile("3.0.0"));
    const multiResult = runHelper(multiFixture, ["--base", "main", "--json"]);
    const multiEnvelope = JSON.parse(multiResult.stdout);

    expect(multiResult.status).toBe(0);
    expect(multiEnvelope.results).toHaveLength(2);
    expect(multiEnvelope.events).toHaveLength(2);
    expect(multiEnvelope.errors).toEqual([]);
    expect(multiResult.stdout.trim().startsWith("{")).toBe(true);
    expect(multiResult.stdout.trim().endsWith("}")).toBe(true);

    const failedFixture = await createFixture("package-lock.json", 7);
    await writeFile(path.join(failedFixture.repo, "package-lock.json"), lockfile("2.0.0"));
    const failedResult = runHelper(failedFixture, ["--base", "main", "--json"]);
    const failedEnvelope = JSON.parse(failedResult.stdout);

    expect(failedResult.status).toBe(7);
    expect(failedEnvelope.errors).toEqual([{ type: "packsift", exitCode: 7 }]);
  });

  it("emits JSON for git failures and records workspace manifests beside batches", async () => {
    const invalidBaseFixture = await createFixture();
    const invalidBaseResult = runHelper(invalidBaseFixture, ["--base", "missing", "--json"]);
    const invalidBaseEnvelope = JSON.parse(invalidBaseResult.stdout);

    expect(invalidBaseResult.status).toBe(2);
    expect(invalidBaseEnvelope.errors).toEqual([
      {
        type: "git",
        exitCode: 2,
        message: "PackSift evidence error: cannot resolve base ref 'missing' or 'origin/missing'",
      },
    ]);

    const workspaceFixture = await createFixture("package-lock.json", 0, ["packages/foo/package.json"]);
    await writeFile(path.join(workspaceFixture.repo, "packages/foo/package.json"), '{"name":"foo","version":"1.0.1"}\n');
    await writeFile(path.join(workspaceFixture.repo, "package-lock.json"), lockfile("2.0.0"));
    const workspaceResult = runHelper(workspaceFixture, ["--base", "main", "--json"]);
    const workspaceEnvelope = JSON.parse(workspaceResult.stdout);

    expect(workspaceResult.status).toBe(0);
    expect(workspaceEnvelope.events).toEqual([
      { type: "package-json-changed", path: "packages/foo/package.json" },
      { type: "batch", path: "package-lock.json", base: expect.any(String) },
    ]);
  });

  it("emits JSON usage envelopes for malformed arguments", async () => {
    const fixture = await createFixture();
    const cases = [
      [["--json", "--base"], "PackSift evidence error: --base requires a git ref"],
      [["--json", "--unknown"], "PackSift evidence error: unknown option: --unknown"],
      [["--json", "extra"], "PackSift evidence error: unexpected argument: extra"],
    ] as const;

    for (const [args, message] of cases) {
      const result = runHelper(fixture, [...args]);
      const envelope = JSON.parse(result.stdout);

      expect(result.status).toBe(2);
      expect(envelope.errors).toEqual([{ type: "usage", exitCode: 2, message }]);
      expect(result.stdout).not.toContain("Usage:");
      expect(result.stderr).toContain("Usage:");
    }
  });

  it("emits an envelope for removed inputs in JSON mode", async () => {
    const fixture = await createFixture();
    await rm(path.join(fixture.repo, "package-lock.json"));

    const result = runHelper(fixture, ["--base", "main", "--json"]);
    const envelope = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(envelope).toMatchObject({
      mode: "dependencies",
      results: [],
      events: [{ type: "removed-lockfile", path: "package-lock.json" }],
      errors: [],
    });
  });

  it("reports removed package and lockfile inputs", async () => {
    const packageFixture = await createFixture();
    await rm(path.join(packageFixture.repo, "package.json"));

    const packageResult = runHelper(packageFixture, ["--base", "main"]);

    expect(packageResult.status).toBe(0);
    expect(packageResult.stdout).toContain("package.json was removed");

    const lockfileFixture = await createFixture();
    await rm(path.join(lockfileFixture.repo, "package-lock.json"));

    const lockfileResult = runHelper(lockfileFixture, ["--base", "main"]);

    expect(lockfileResult.status).toBe(0);
    expect(lockfileResult.stdout).toContain("package-lock.json was removed");
    expect(lockfileResult.stdout).not.toContain("no package.json or supported lockfile changes detected");
  });

  it("rejects multiple release inputs even when the first is the default path", async () => {
    const fixture = await createFixture();

    const result = runHelper(fixture, ["release", ".", "extra"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unexpected argument: extra");
    expect(await readFile(fixture.log, "utf8")).toBe("");
  });

  it("returns non-zero when PackSift cannot complete", async () => {
    const fixture = await createFixture("package-lock.json", 7);
    await writeFile(path.join(fixture.repo, "package-lock.json"), lockfile("2.0.0"));

    const result = runHelper(fixture, ["--base", "main"]);

    expect(result.status).toBe(7);
    expect(result.stdout).toContain("fixture evidence");
  });
});

async function createFixture(
  lockfileNames: string | string[] = "package-lock.json",
  exitCode = 0,
  packageJsonPaths: string[] = [],
): Promise<{ repo: string; bin: string; log: string }> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "packsift-no-mistakes-"));
  tempRoots.push(repo);
  const bin = path.join(repo, "fake-packsift");
  const log = path.join(repo, "packsift.log");
  const names = Array.isArray(lockfileNames) ? lockfileNames : [lockfileNames];

  await writeFile(path.join(repo, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  for (const packageJsonPath of packageJsonPaths) {
    const fullPath = path.join(repo, packageJsonPath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, '{"name":"foo","version":"1.0.0"}\n');
  }
  for (const name of names) {
    await writeFile(path.join(repo, name), lockfile("1.0.0"));
  }
  await writeFile(log, "");
  await writeFile(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PACKSIFT_TEST_LOG"\ncase " $* " in\n  *" --json "*) echo '{"fixture":"evidence"}' ;;\n  *) echo "fixture evidence" ;;\nesac\nexit ${exitCode}\n`,
  );
  await chmod(bin, 0o755);

  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "fixture@example.com"]);
  git(repo, ["config", "user.name", "Fixture"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "fixture base"]);
  git(repo, ["checkout", "-b", "feature"]);

  return { repo, bin, log };
}

function runHelper(
  fixture: { repo: string; bin: string; log: string },
  args: string[],
): ReturnType<typeof spawnSync> {
  return spawnSync(helper, args, {
    cwd: fixture.repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PACKSIFT_BIN: fixture.bin,
      PACKSIFT_TEST_LOG: fixture.log,
    },
  });
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function lockfile(version: string): string {
  return `${JSON.stringify(
    {
      name: "fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture", version: "1.0.0" },
        "node_modules/example": {
          version,
          resolved: `https://registry.npmjs.org/example/-/example-${version}.tgz`,
        },
      },
    },
    null,
    2,
  )}\n`;
}
