import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { IntegritySource, IntegrityWarning, PackageManifest, PackageMetadataFacts, PackageSpec, VersionArtifacts } from "./types.js";

interface RegistryMetadata {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, PackageManifest>;
  time?: Record<string, string>;
  maintainers?: unknown[];
}

export async function resolvePublishedVersion(name: string, registry: string, tag = "latest"): Promise<string> {
  let metadata: RegistryMetadata;
  try {
    metadata = await fetchMetadata(name, registry);
  } catch (error) {
    throw new Error(`Could not resolve a published ${tag} baseline for ${name}: ${errorMessage(error)}`);
  }
  const version = metadata["dist-tags"]?.[tag];
  if (!version || !metadata.versions?.[version]) {
    throw new Error(`Package has no published ${tag} version on the configured registry: ${name}`);
  }
  return version;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface FetchOptions {
  registry: string;
  keep: boolean;
}

export interface FetchResult {
  oldArtifacts: VersionArtifacts;
  newArtifacts: VersionArtifacts;
  integrityWarnings: IntegrityWarning[];
  cleanup: () => Promise<void>;
}

export interface FetchPackageResult {
  artifacts: VersionArtifacts;
  integrityWarnings: IntegrityWarning[];
  metadata: PackageMetadataFacts;
  cleanup: () => Promise<void>;
}

export async function fetchArtifacts(oldSpec: PackageSpec, newSpec: PackageSpec, options: FetchOptions): Promise<FetchResult> {
  const metadata = await fetchMetadata(oldSpec.name, options.registry);
  const oldManifest = metadata.versions?.[oldSpec.version];
  const newManifest = metadata.versions?.[newSpec.version];
  if (!oldManifest) throw new Error(`Version not found in registry metadata: ${oldSpec.name}@${oldSpec.version}`);
  if (!newManifest) throw new Error(`Version not found in registry metadata: ${newSpec.name}@${newSpec.version}`);
  if (!oldManifest.dist?.tarball) throw new Error(`Registry metadata has no tarball URL for ${oldSpec.raw}`);
  if (!newManifest.dist?.tarball) throw new Error(`Registry metadata has no tarball URL for ${newSpec.raw}`);

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sift-"));
  const integrityWarnings: IntegrityWarning[] = [];
  let oldArtifacts: VersionArtifacts;
  let newArtifacts: VersionArtifacts;
  try {
    oldArtifacts = await downloadAndExtract(oldSpec, oldManifest, tempRoot, "old", integrityWarnings);
    newArtifacts = await downloadAndExtract(newSpec, newManifest, tempRoot, "new", integrityWarnings);
  } catch (error) {
    if (!options.keep) await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    oldArtifacts,
    newArtifacts,
    integrityWarnings,
    cleanup: async () => {
      if (!options.keep) await rm(tempRoot, { recursive: true, force: true });
    }
  };
}

export async function fetchPackage(spec: PackageSpec, options: FetchOptions): Promise<FetchPackageResult> {
  const metadata = await fetchMetadata(spec.name, options.registry);
  const manifest = metadata.versions?.[spec.version];
  if (!manifest) throw new Error(`Version not found in registry metadata: ${spec.name}@${spec.version}`);
  if (!manifest.dist?.tarball) throw new Error(`Registry metadata has no tarball URL for ${spec.raw}`);

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sift-"));
  const integrityWarnings: IntegrityWarning[] = [];
  let artifacts: VersionArtifacts;
  try {
    artifacts = await downloadAndExtract(spec, manifest, tempRoot, "new", integrityWarnings);
  } catch (error) {
    if (!options.keep) await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    artifacts,
    integrityWarnings,
    metadata: {
      publishedAt: metadata.time?.[spec.version],
      maintainerCount: Array.isArray(metadata.maintainers) ? metadata.maintainers.length : manifest.maintainers?.length,
      versionCount: metadata.versions ? Object.keys(metadata.versions).length : undefined
    },
    cleanup: async () => {
      if (!options.keep) await rm(tempRoot, { recursive: true, force: true });
    }
  };
}

async function fetchMetadata(name: string, registry: string): Promise<RegistryMetadata> {
  let baseEnd = registry.length;
  while (baseEnd > 0 && registry[baseEnd - 1] === "/") baseEnd -= 1;
  const base = registry.slice(0, baseEnd);
  const encodedName = name.startsWith("@") ? name.replace("/", "%2F") : encodeURIComponent(name);
  const response = await fetch(`${base}/${encodedName}`);
  if (!response.ok) {
    throw new Error(`Registry metadata request failed for ${name}: HTTP ${response.status}`);
  }
  return (await response.json()) as RegistryMetadata;
}

async function downloadAndExtract(
  spec: PackageSpec,
  manifest: PackageManifest,
  tempRoot: string,
  label: "old" | "new",
  warnings: IntegrityWarning[]
): Promise<VersionArtifacts> {
  const tarballUrl = manifest.dist?.tarball;
  if (!tarballUrl) throw new Error(`Missing tarball URL for ${spec.raw}`);
  const response = await fetch(tarballUrl);
  if (!response.ok) {
    throw new Error(`Tarball request failed for ${spec.raw}: HTTP ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const tarballPath = path.join(tempRoot, `${label}.tgz`);
  await writeFile(tarballPath, bytes);

  const integrity = { integrity: manifest.dist?.integrity, shasum: manifest.dist?.shasum };
  warnings.push(...verifyBytes(spec.version, bytes, integrity));

  const extractDir = path.join(tempRoot, label);
  await extractPackageTarball(tarballPath, extractDir);

  return {
    spec,
    registryManifest: manifest,
    tarballPath,
    extractDir,
    integrity
  };
}

export async function extractPackageTarball(tarballPath: string, extractDir: string): Promise<void> {
  await mkdir(extractDir, { recursive: true });
  await tar.x({
    file: tarballPath,
    cwd: extractDir,
    strip: 1,
    filter: (entryPath: string) => entryPath === "package" || entryPath.startsWith("package/")
  });
}

export function verifyBytes(version: string, bytes: Buffer, source: IntegritySource): IntegrityWarning[] {
  const warnings: IntegrityWarning[] = [];
  if (source.integrity) {
    const first = source.integrity.split(/\s+/)[0];
    const separator = first.indexOf("-");
    const algorithm = separator > 0 ? first.slice(0, separator) : "";
    const expected = separator > 0 ? first.slice(separator + 1) : first;
    if (algorithm && expected) {
      const actual = createHash(algorithm).update(bytes).digest("base64");
      if (actual !== expected) warnings.push({ version, kind: "integrity", expected, actual });
    }
  }
  if (source.shasum) {
    const actual = createHash("sha1").update(bytes).digest("hex");
    if (actual !== source.shasum) warnings.push({ version, kind: "shasum", expected: source.shasum, actual });
  }
  return warnings;
}
