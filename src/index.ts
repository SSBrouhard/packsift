export { analyze } from "./analyze.js";
export { fetchAdvisories } from "./advisories.js";
export { analyzeBatch, classifyTransitions } from "./batch.js";
export { formatAdvisorySidecar, formatBatchHuman, formatHuman } from "./format.js";
export { parseLockfile, parseLockfileData, packageNameFromLockPath } from "./lockfile.js";
export { parsePackageSpec, assertSamePackage } from "./spec.js";
export { verifyBytes } from "./registry.js";
export type {
  AnalyzeInput,
  AnalyzeOptions,
  Advisory,
  AdvisorySidecar,
  AdvisoryVersionResult,
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
