import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface PackDryRun {
  files: Array<{ path: string; mode: number }>;
}

describe("published package contract", () => {
  it("ships only the canonical PackSift CLI bin in the dry-run package", async () => {
    const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error("npm_execpath is required to verify the package");

    const output = execFileSync(process.execPath, [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: root,
      encoding: "utf8"
    });
    const [dryRun] = JSON.parse(output) as PackDryRun[];
    const cli = dryRun.files.find((file) => file.path === "dist/cli.js");
    const builtCli = await stat(path.join(root, "dist/cli.js"));

    expect(manifest.bin).toEqual({
      packsift: "dist/cli.js"
    });
    expect(builtCli.isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect(builtCli.mode & 0o111).not.toBe(0);
    }
    expect(cli).toBeDefined();
    expect(cli!.mode & 0o111).not.toBe(0);
  });
});
