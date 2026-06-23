export interface PackageSpec {
  raw: string;
  name: string;
  version: string;
}

export interface VersionArtifacts {
  spec: PackageSpec;
  registryManifest: PackageManifest;
  tarballPath: string;
  extractDir: string;
  integrity: IntegritySource;
}

export interface IntegritySource {
  integrity?: string;
  shasum?: string;
}

export interface IntegrityWarning {
  version: string;
  kind: "integrity" | "shasum";
  expected: string;
  actual: string;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface PackageManifest {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  license?: string;
  maintainers?: Maintainer[];
  _npmUser?: Maintainer;
  dist?: {
    tarball?: string;
    integrity?: string;
    shasum?: string;
    unpackedSize?: number;
  };
  [key: string]: JsonValue | undefined | Maintainer | Maintainer[] | Record<string, string> | { tarball?: string; integrity?: string; shasum?: string; unpackedSize?: number };
}

export interface Maintainer {
  name?: string;
  email?: string;
  username?: string;
}

export interface FileInfo {
  path: string;
  hash: string;
  size: number;
}

export type FileStatus = "added" | "removed" | "changed";

export interface FileChange {
  path: string;
  status: FileStatus;
  oldSize?: number;
  newSize?: number;
  oldHash?: string;
  newHash?: string;
  binaryOrLarge?: boolean;
  minifiedHeuristic?: boolean;
  addedLines?: number;
  removedLines?: number;
  diff?: string;
}

export interface FileSummary {
  added: number;
  removed: number;
  changed: number;
}

export interface SizeDelta {
  oldBytes: number;
  newBytes: number;
  oldUnpackedSize?: number;
  newUnpackedSize?: number;
  fired: boolean;
  threshold: string;
}

export interface Signal {
  id:
    | "lifecycle-scripts"
    | "maintainer-publisher"
    | "executable-payloads"
    | "minified-source"
    | "install-path-network"
    | "new-bin"
    | "size-delta"
    | "dependency-fields"
    | "license";
  title: string;
  details: JsonValue;
}

export interface Report {
  packageName: string;
  oldVersion: string;
  newVersion: string;
  integrityWarnings: IntegrityWarning[];
  signals: Signal[];
  files: {
    summary: FileSummary;
    entries: FileChange[];
  };
  sizeDelta: SizeDelta;
}

export interface Advisory {
  id: string;
  aliases: string[];
  severity: string;
  affectedRanges: string[];
  references: string[];
}

export interface AdvisoryVersionResult {
  version: string;
  vulns: Advisory[];
  unavailable?: string;
}

export interface AdvisorySidecar {
  enabled: true;
  source: "OSV.dev";
  fetchedAt: string;
  oldVersion: AdvisoryVersionResult;
  newVersion: AdvisoryVersionResult;
}

export interface AnalyzeInput {
  packageName: string;
  oldVersion: string;
  newVersion: string;
  oldDir: string;
  newDir: string;
  oldRegistryManifest: PackageManifest;
  newRegistryManifest: PackageManifest;
  integrityWarnings?: IntegrityWarning[];
}

export interface AnalyzeOptions {
  includeDiffs?: boolean;
  textDiffSizeLimit?: number;
}

export type VersionSetMap = Map<string, Set<string>>;

export interface Transition {
  name: string;
  oldVersion: string;
  newVersion: string;
}

export type SkippedReason = "added" | "removed" | "multiple-versions";

export interface SkippedEntry {
  name: string;
  reason: SkippedReason;
}

export interface ClassifiedTransitions {
  analyzed: Transition[];
  skipped: SkippedEntry[];
}

export interface BatchEntry {
  name: string;
  report: Report;
}

export interface BatchErrorEntry {
  name: string;
  message: string;
}

export interface BatchReport {
  analyzed: BatchEntry[];
  skipped: SkippedEntry[];
  errors: BatchErrorEntry[];
}
