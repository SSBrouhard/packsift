import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { FileInfo } from "./types.js";

export async function buildFileManifest(root: string): Promise<Map<string, FileInfo>> {
  const out = new Map<string, FileInfo>();
  await walk(root, root, out);
  return out;
}

async function walk(root: string, dir: string, out: Map<string, FileInfo>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, absolute, out);
      continue;
    }
    if (!entry.isFile()) continue;

    const bytes = await readFile(absolute);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    out.set(relative, {
      path: relative,
      hash: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength
    });
  }
}

export async function readJsonIfExists<T>(root: string, relative: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path.join(root, relative), "utf8")) as T;
  } catch {
    return undefined;
  }
}

export async function readText(root: string, relative: string): Promise<string> {
  return readFile(path.join(root, relative), "utf8");
}

export async function fileExists(root: string, relative: string): Promise<boolean> {
  try {
    const info = await stat(path.join(root, relative));
    return info.isFile();
  } catch {
    return false;
  }
}
