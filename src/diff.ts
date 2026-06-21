import { createTwoFilesPatch, diffLines } from "diff";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { FileChange, FileInfo } from "./types.js";

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".d.ts",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".yml",
  ".yaml"
]);

export function compareManifests(oldFiles: Map<string, FileInfo>, newFiles: Map<string, FileInfo>): FileChange[] {
  const entries: FileChange[] = [];
  const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);

  for (const filePath of [...paths].sort()) {
    const oldFile = oldFiles.get(filePath);
    const newFile = newFiles.get(filePath);

    if (!oldFile && newFile) {
      entries.push({
        path: filePath,
        status: "added",
        oldSize: 0,
        newSize: newFile.size,
        newHash: newFile.hash
      });
      continue;
    }

    if (oldFile && !newFile) {
      entries.push({
        path: filePath,
        status: "removed",
        oldSize: oldFile.size,
        newSize: 0,
        oldHash: oldFile.hash
      });
      continue;
    }

    if (oldFile && newFile && oldFile.hash !== newFile.hash) {
      entries.push({
        path: filePath,
        status: "changed",
        oldSize: oldFile.size,
        newSize: newFile.size,
        oldHash: oldFile.hash,
        newHash: newFile.hash
      });
    }
  }

  return entries;
}

export async function enrichTextDiffs(
  entries: FileChange[],
  oldRoot: string,
  newRoot: string,
  includeDiffs: boolean,
  limitBytes: number
): Promise<void> {
  for (const entry of entries) {
    if (entry.status !== "changed") continue;
    const oldSize = entry.oldSize ?? 0;
    const newSize = entry.newSize ?? 0;
    if (oldSize > limitBytes || newSize > limitBytes || !looksTextualPath(entry.path)) {
      entry.binaryOrLarge = true;
      continue;
    }

    const oldBytes = await readFile(path.join(oldRoot, entry.path));
    const newBytes = await readFile(path.join(newRoot, entry.path));
    if (!looksTextualBytes(oldBytes) || !looksTextualBytes(newBytes)) {
      entry.binaryOrLarge = true;
      continue;
    }

    const oldText = oldBytes.toString("utf8");
    const newText = newBytes.toString("utf8");
    const changes = diffLines(oldText, newText);
    entry.addedLines = changes.filter((part) => part.added).reduce((sum, part) => sum + countLines(part.value), 0);
    entry.removedLines = changes.filter((part) => part.removed).reduce((sum, part) => sum + countLines(part.value), 0);
    if (includeDiffs) {
      entry.diff = createTwoFilesPatch(`old/${entry.path}`, `new/${entry.path}`, oldText, newText, "", "", { context: 3 });
    }
  }
}

function looksTextualPath(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function looksTextualBytes(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1;
  }
  return sample.length === 0 || suspicious / sample.length < 0.05;
}

function countLines(value: string): number {
  if (value.length === 0) return 0;
  return value.endsWith("\n") ? value.split("\n").length - 1 : value.split("\n").length;
}
