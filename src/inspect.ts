import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildFileManifest, readJsonIfExists } from "./files.js";
import { compareManifests } from "./diff.js";
import { computeSignals } from "./signals.js";
import { InspectReport, PackageManifest, PackageMetadataFacts } from "./types.js";

export interface InspectInput {
  packageName: string;
  version: string;
  packageDir: string;
  registryManifest: PackageManifest;
  metadata?: PackageMetadataFacts;
  integrityWarnings?: InspectReport["integrityWarnings"];
}

export async function inspectPackage(input: InspectInput): Promise<InspectReport> {
  const emptyRoot = await mkdtemp(path.join(os.tmpdir(), "sift-empty-"));
  try {
    const oldDir = path.join(emptyRoot, "old");
    await mkdir(oldDir, { recursive: true });
    const oldFiles = await buildFileManifest(oldDir);
    const newFiles = await buildFileManifest(input.packageDir);
    const entries = compareManifests(oldFiles, newFiles);
    const manifest = (await readJsonIfExists<PackageManifest>(input.packageDir, "package.json")) ?? input.registryManifest;
    const bytes = [...newFiles.values()].reduce((sum, file) => sum + file.size, 0);
    const sizeDelta = {
      oldBytes: 0,
      newBytes: bytes,
      oldUnpackedSize: undefined,
      newUnpackedSize: input.registryManifest.dist?.unpackedSize,
      fired: false,
      threshold: "> 2x or > +1 MB"
    };
    const signals = await computeSignals({
      oldRoot: oldDir,
      newRoot: input.packageDir,
      oldManifest: {},
      newManifest: manifest,
      oldRegistryManifest: {},
      newRegistryManifest: input.registryManifest,
      entries,
      oldFiles,
      newFiles,
      sizeDelta
    });

    return {
      mode: "inspect",
      packageName: input.packageName,
      version: input.version,
      integrityWarnings: input.integrityWarnings ?? [],
      signals,
      files: {
        summary: {
          added: entries.filter((entry) => entry.status === "added").length,
          removed: 0,
          changed: 0
        },
        entries
      },
      size: {
        bytes,
        unpackedSize: input.registryManifest.dist?.unpackedSize
      },
      metadata: input.metadata ?? {}
    };
  } finally {
    await rm(emptyRoot, { recursive: true, force: true });
  }
}
