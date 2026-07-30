import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    expect(result.stdout).toContain("PackSift dependency evidence: batch");
    expect(await readFile(fixture.log, "utf8")).toMatch(
      /^batch [0-9a-f]+:package-lock\.json package-lock\.json --json\n$/,
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
    expect(result.stdout).toContain("PackSift pre-publish evidence: pack-check .");
    expect(await readFile(fixture.log, "utf8")).toBe("pack-check . --json\n");
  });

  it("returns non-zero when PackSift cannot complete", async () => {
    const fixture = await createFixture(7);
    await writeFile(path.join(fixture.repo, "package-lock.json"), lockfile("2.0.0"));

    const result = runHelper(fixture, ["--base", "main"]);

    expect(result.status).toBe(7);
    expect(result.stdout).toContain("fixture evidence");
  });
});

async function createFixture(exitCode = 0): Promise<{ repo: string; bin: string; log: string }> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "packsift-no-mistakes-"));
  tempRoots.push(repo);
  const bin = path.join(repo, "fake-packsift");
  const log = path.join(repo, "packsift.log");

  await writeFile(path.join(repo, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  await writeFile(path.join(repo, "package-lock.json"), lockfile("1.0.0"));
  await writeFile(log, "");
  await writeFile(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PACKSIFT_TEST_LOG"\necho "fixture evidence"\nexit ${exitCode}\n`,
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
