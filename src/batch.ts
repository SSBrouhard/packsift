import { analyze } from "./analyze.js";
import { buildAdvisorySidecar, buildInspectAdvisorySidecar } from "./advisories.js";
import { inspectPackage } from "./inspect.js";
import { fetchArtifacts, FetchOptions, FetchResult, fetchPackage } from "./registry.js";
import {
  Advisory,
  BatchEntry,
  BatchErrorEntry,
  BatchReport,
  ClassifiedTransitions,
  Report,
  SkippedEntry,
  Transition,
  VersionSetMap
} from "./types.js";

export interface AnalyzeBatchOptions extends FetchOptions {
  includeDiffs?: boolean;
  concurrency?: number;
  advisories?: {
    fetchAdvisories: (name: string, version: string) => Promise<Advisory[]>;
    now: () => Date;
    source: string;
  };
}

interface AnalyzeBatchDependencies {
  fetchArtifacts?: typeof fetchArtifacts;
  fetchPackage?: typeof fetchPackage;
  analyze?: typeof analyze;
  inspectPackage?: typeof inspectPackage;
}

const DEFAULT_CONCURRENCY = 4;
const SORT_LOCALE = "en";

export function classifyTransitions(oldVersions: VersionSetMap, newVersions: VersionSetMap): ClassifiedTransitions {
  const analyzed: Transition[] = [];
  const analyzedAdded: ClassifiedTransitions["added"] = [];
  const skipped: SkippedEntry[] = [];
  const names = new Set([...oldVersions.keys(), ...newVersions.keys()]);

  for (const name of names) {
    const oldSet = oldVersions.get(name);
    const newSet = newVersions.get(name);
    if (!oldSet) {
      if (newSet && newSet.size === 1) {
        analyzedAdded.push({ kind: "added", name, version: singleVersion(newSet) });
      } else {
        skipped.push({ name, reason: "multiple-versions" });
      }
      continue;
    }
    if (!newSet) {
      skipped.push({ name, reason: "removed" });
      continue;
    }
    if (oldSet.size !== 1 || newSet.size !== 1) {
      skipped.push({ name, reason: "multiple-versions" });
      continue;
    }

    const oldVersion = singleVersion(oldSet);
    const newVersion = singleVersion(newSet);
    if (oldVersion !== newVersion) analyzed.push({ kind: "transition", name, oldVersion, newVersion });
  }

  return {
    analyzed: analyzed.sort(byName),
    added: analyzedAdded.sort(byName),
    skipped: skipped.sort(byName)
  };
}

export async function analyzeBatch(
  classified: ClassifiedTransitions,
  options: AnalyzeBatchOptions,
  dependencies: AnalyzeBatchDependencies = {}
): Promise<BatchReport> {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }

  const analyzeOne = dependencies.analyze ?? analyze;
  const inspectOne = dependencies.inspectPackage ?? inspectPackage;
  const fetchOne = dependencies.fetchArtifacts ?? fetchArtifacts;
  const fetchPackageOne = dependencies.fetchPackage ?? fetchPackage;
  const analyzed: BatchEntry[] = [];
  const added: BatchReport["added"] = [];
  const errors: BatchErrorEntry[] = [];

  await runPool(classified.analyzed, concurrency, async (transition) => {
    try {
      const fetched = await fetchOne(
        { raw: `${transition.name}@${transition.oldVersion}`, name: transition.name, version: transition.oldVersion },
        { raw: `${transition.name}@${transition.newVersion}`, name: transition.name, version: transition.newVersion },
        { registry: options.registry, keep: options.keep }
      );
      try {
        const report = await analyzeOne(
          {
            packageName: transition.name,
            oldVersion: transition.oldVersion,
            newVersion: transition.newVersion,
            oldDir: fetched.oldArtifacts.extractDir,
            newDir: fetched.newArtifacts.extractDir,
            oldRegistryManifest: fetched.oldArtifacts.registryManifest,
            newRegistryManifest: fetched.newArtifacts.registryManifest,
            integrityWarnings: fetched.integrityWarnings
          },
          { includeDiffs: options.includeDiffs }
        );
        analyzed.push({ kind: "transition", name: transition.name, report });
      } finally {
        await fetched.cleanup();
      }
    } catch (error) {
      errors.push({ name: transition.name, message: messageFor(error) });
    }
  });

  await runPool(classified.added ?? [], concurrency, async (entry) => {
    try {
      const fetched = await fetchPackageOne(
        { raw: `${entry.name}@${entry.version}`, name: entry.name, version: entry.version },
        { registry: options.registry, keep: options.keep }
      );
      try {
        const report = await inspectOne({
          packageName: entry.name,
          version: entry.version,
          packageDir: fetched.artifacts.extractDir,
          registryManifest: fetched.artifacts.registryManifest,
          metadata: fetched.metadata,
          integrityWarnings: fetched.integrityWarnings
        });
        added.push({ kind: "added", name: entry.name, report });
      } finally {
        await fetched.cleanup();
      }
    } catch (error) {
      errors.push({ name: entry.name, message: messageFor(error) });
    }
  });

  if (options.advisories) {
    await runPool(analyzed, concurrency, async (entry) => {
      entry.advisorySidecar = await buildAdvisorySidecar(
        entry.name,
        entry.report.oldVersion,
        entry.report.newVersion,
        options.advisories!.fetchAdvisories,
        options.advisories!.now,
        options.advisories!.source
      );
    });
    await runPool(added, concurrency, async (entry) => {
      entry.advisorySidecar = await buildInspectAdvisorySidecar(
        entry.name,
        entry.report.version,
        options.advisories!.fetchAdvisories,
        options.advisories!.now,
        options.advisories!.source
      );
    });
  }

  return {
    analyzed: analyzed.sort(byName),
    added: added.sort(byName),
    skipped: classified.skipped.slice().sort(byName),
    errors: errors.sort(byName)
  };
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        await worker(items[index]);
      }
    })
  );
}

function singleVersion(values: Set<string>): string {
  return values.values().next().value as string;
}

function byName(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name, SORT_LOCALE);
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { FetchResult, Report };
