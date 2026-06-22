export { analyze } from "./analyze.js";
export { analyzeBatch, classifyTransitions } from "./batch.js";
export { formatBatchHuman, formatHuman } from "./format.js";
export { parseLockfile, parseLockfileData, packageNameFromLockPath } from "./lockfile.js";
export { parsePackageSpec, assertSamePackage } from "./spec.js";
export { verifyBytes } from "./registry.js";
export type {
  AnalyzeInput,
  AnalyzeOptions,
  BatchEntry,
  BatchErrorEntry,
  BatchReport,
  ClassifiedTransitions,
  Report,
  SkippedEntry,
  SkippedReason,
  Transition,
  VersionSetMap
} from "./types.js";
