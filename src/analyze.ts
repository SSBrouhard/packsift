import { buildFileManifest, readJsonIfExists } from "./files.js";
import { compareManifests, enrichTextDiffs } from "./diff.js";
import { AnalyzeInput, AnalyzeOptions, PackageManifest, Report, SizeDelta } from "./types.js";
import { computeSignals } from "./signals.js";

const DEFAULT_TEXT_DIFF_LIMIT = 512 * 1024;

export async function analyze(input: AnalyzeInput, options: AnalyzeOptions = {}): Promise<Report> {
  const oldFiles = await buildFileManifest(input.oldDir);
  const newFiles = await buildFileManifest(input.newDir);
  const entries = compareManifests(oldFiles, newFiles);
  await enrichTextDiffs(entries, input.oldDir, input.newDir, Boolean(options.includeDiffs), options.textDiffSizeLimit ?? DEFAULT_TEXT_DIFF_LIMIT);

  const oldManifest = (await readJsonIfExists<PackageManifest>(input.oldDir, "package.json")) ?? input.oldRegistryManifest;
  const newManifest = (await readJsonIfExists<PackageManifest>(input.newDir, "package.json")) ?? input.newRegistryManifest;
  const sizeDelta = computeSizeDelta(oldFiles, newFiles, input.oldRegistryManifest, input.newRegistryManifest);
  const signals = await computeSignals({
    oldRoot: input.oldDir,
    newRoot: input.newDir,
    oldManifest,
    newManifest,
    oldRegistryManifest: input.oldRegistryManifest,
    newRegistryManifest: input.newRegistryManifest,
    entries,
    oldFiles,
    newFiles,
    sizeDelta
  });

  return {
    packageName: input.packageName,
    oldVersion: input.oldVersion,
    newVersion: input.newVersion,
    integrityWarnings: input.integrityWarnings ?? [],
    signals,
    files: {
      summary: {
        added: entries.filter((entry) => entry.status === "added").length,
        removed: entries.filter((entry) => entry.status === "removed").length,
        changed: entries.filter((entry) => entry.status === "changed").length
      },
      entries
    },
    sizeDelta
  };
}

function computeSizeDelta(
  oldFiles: Map<string, { size: number }>,
  newFiles: Map<string, { size: number }>,
  oldManifest: PackageManifest,
  newManifest: PackageManifest
): SizeDelta {
  const oldBytes = [...oldFiles.values()].reduce((sum, file) => sum + file.size, 0);
  const newBytes = [...newFiles.values()].reduce((sum, file) => sum + file.size, 0);
  const growth = newBytes - oldBytes;
  return {
    oldBytes,
    newBytes,
    oldUnpackedSize: oldManifest.dist?.unpackedSize,
    newUnpackedSize: newManifest.dist?.unpackedSize,
    fired: oldBytes > 0 && (newBytes > oldBytes * 2 || growth > 1024 * 1024),
    threshold: "> 2x or > +1 MB"
  };
}
