import { Advisory, AdvisorySidecar, AdvisoryVersionResult, BatchReport, FileChange, InspectAdvisorySidecar, InspectReport, Report, Signal, SkippedReason } from "./types.js";

export function formatHuman(report: Report, includeDiffs: boolean, advisorySidecar?: AdvisorySidecar): string {
  const lines: string[] = [];
  lines.push(`sift  ${report.packageName}@${report.oldVersion} -> ${report.newVersion}`);
  lines.push("");
  lines.push("-- Flagged ------------------------------");

  if (report.integrityWarnings.length) {
    lines.push("  !! Integrity / shasum mismatch");
    for (const warning of report.integrityWarnings) {
      lines.push(`     ${warning.version} ${warning.kind}: expected ${shortHash(warning.expected)}, got ${shortHash(warning.actual)}`);
    }
  }

  if (report.signals.length === 0) {
    lines.push("  No notable supply-chain signals.");
  } else {
    for (const signal of report.signals) {
      lines.push(...formatSignal(signal));
    }
  }

  lines.push("");
  lines.push("-- Files --------------------------------");
  lines.push(`  added    ${report.files.summary.added}`);
  lines.push(`  removed  ${report.files.summary.removed}`);
  lines.push(`  changed  ${report.files.summary.changed}`);
  lines.push("");

  for (const entry of report.files.entries) {
    lines.push(`  ${statusLetter(entry.status)}  ${entry.path.padEnd(28)} ${formatFileChange(entry)}`);
  }

  if (advisorySidecar) {
    lines.push("");
    lines.push(...formatAdvisorySidecar(advisorySidecar));
  }

  if (includeDiffs) {
    const diffs = report.files.entries.filter((entry) => entry.diff).map((entry) => entry.diff);
    if (diffs.length) {
      lines.push("");
      lines.push("-- Diffs --------------------------------");
      lines.push(diffs.join("\n"));
    }
  }

  return `${lines.join("\n")}\n`;
}

export function formatInspectHuman(report: InspectReport, advisorySidecar?: InspectAdvisorySidecar): string {
  const lines: string[] = [];
  lines.push(`sift inspect  ${report.packageName}@${report.version}`);
  lines.push("");
  lines.push("-- Package metadata ---------------------");
  lines.push(`  published: ${report.metadata.publishedAt ?? "unknown"}`);
  lines.push(`  maintainers: ${report.metadata.maintainerCount ?? "unknown"}`);
  lines.push(`  versions: ${report.metadata.versionCount ?? "unknown"}`);
  lines.push(`  files: ${report.files.summary.added}`);
  lines.push(`  unpacked bytes: ${formatBytes(report.size.bytes)}`);
  if (report.size.unpackedSize !== undefined) lines.push(`  registry dist.unpackedSize: ${report.size.unpackedSize}`);
  lines.push("");
  lines.push("-- Flagged ------------------------------");

  if (report.integrityWarnings.length) {
    lines.push("  !! Integrity / shasum mismatch");
    for (const warning of report.integrityWarnings) {
      lines.push(`     ${warning.version} ${warning.kind}: expected ${shortHash(warning.expected)}, got ${shortHash(warning.actual)}`);
    }
  }

  if (report.signals.length === 0) {
    lines.push("  No notable supply-chain signals.");
  } else {
    for (const signal of report.signals) {
      lines.push(...formatSignal(signal));
    }
  }

  lines.push("");
  lines.push("-- Files --------------------------------");
  lines.push(`  added    ${report.files.summary.added}`);
  lines.push(`  removed  ${report.files.summary.removed}`);
  lines.push(`  changed  ${report.files.summary.changed}`);
  lines.push("");

  for (const entry of report.files.entries) {
    lines.push(`  ${statusLetter(entry.status)}  ${entry.path.padEnd(28)} ${formatFileChange(entry)}`);
  }

  if (advisorySidecar) {
    lines.push("");
    lines.push(...formatInspectAdvisorySidecar(advisorySidecar));
  }

  return `${lines.join("\n")}\n`;
}

export function formatAdvisorySidecar(sidecar: AdvisorySidecar): string[] {
  return [
    `-- Advisory sidecar: ${sidecar.source} fetched ${sidecar.fetchedAt} --`,
    ...formatAdvisoryVersion("old", sidecar.oldVersion),
    ...formatAdvisoryVersion("new", sidecar.newVersion)
  ];
}

export function formatInspectAdvisorySidecar(sidecar: InspectAdvisorySidecar): string[] {
  return [
    `-- Advisory sidecar: ${sidecar.source} fetched ${sidecar.fetchedAt} --`,
    ...formatAdvisoryVersion("version", sidecar.version)
  ];
}

export interface BatchHumanOptions {
  detail?: boolean;
  includeDiffs?: boolean;
}

export function formatBatchHuman(report: BatchReport, options: BatchHumanOptions = {}): string {
  const lines: string[] = [];
  const addedEntries = report.added ?? [];
  lines.push("sift batch");
  if (report.sources) {
    lines.push(`old: ${report.sources.old}`);
    lines.push(`new: ${report.sources.new}`);
  }
  lines.push("");
  lines.push("-- Analyzed -----------------------------");
  if (report.analyzed.length === 0 && addedEntries.length === 0) {
    lines.push("  No analyzed packages.");
  } else {
    for (const entry of report.analyzed) {
      const summary = entry.report.files.summary;
      const changedFiles = summary.added + summary.removed + summary.changed;
      const evidence = formatBatchEvidence(entry.report);
      lines.push(`  ${entry.name}  ${entry.report.oldVersion} -> ${entry.report.newVersion}   ${changedFiles} changed files; ${evidence}`);
      if (entry.advisorySidecar) {
        lines.push(`    advisories: ${formatBatchAdvisorySummary(entry.advisorySidecar)}`);
      }
      if (options.detail) {
        lines.push("");
        lines.push(indentBlock(formatHuman(entry.report, options.includeDiffs ?? false, entry.advisorySidecar).trimEnd(), "    "));
      }
    }
  }
  if (addedEntries.length) {
    for (const entry of addedEntries) {
      const summary = entry.report.files.summary;
      const fileCount = summary.added + summary.removed + summary.changed;
      const evidence = formatInspectBatchEvidence(entry.report);
      lines.push(`  ${entry.name}  added (no prior version to compare) -> ${entry.report.version}   ${fileCount} files; ${evidence}`);
      if (entry.advisorySidecar) {
        lines.push(`    advisories: ${formatBatchAdvisoryVersion(entry.advisorySidecar.version)} for version`);
      }
      if (options.detail) {
        lines.push("");
        lines.push(indentBlock(formatInspectHuman(entry.report, entry.advisorySidecar).trimEnd(), "    "));
      }
    }
  }

  lines.push("");
  lines.push("-- Skipped ------------------------------");
  if (report.skipped.length === 0) {
    lines.push("  No skipped transitions.");
  } else {
    for (const entry of report.skipped) {
      lines.push(`  ${entry.name}  (${formatSkippedReason(entry.reason)})`);
    }
  }

  lines.push("");
  lines.push("-- Errors -------------------------------");
  if (report.errors.length === 0) {
    lines.push("  No errors.");
  } else {
    for (const entry of report.errors) {
      lines.push(`  ${entry.name}  ${entry.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function indentBlock(value: string, prefix: string): string {
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function formatBatchEvidence(report: Report): string {
  const parts: string[] = [];
  const signals = report.signals.map((signal) => signal.id).join(",");
  if (signals) parts.push(`signals: ${signals}`);
  if (report.integrityWarnings.length) parts.push(`integrity/shasum mismatches: ${report.integrityWarnings.length}`);
  return parts.join("; ") || "signals: no signals";
}

function formatInspectBatchEvidence(report: InspectReport): string {
  const parts: string[] = [];
  const signals = report.signals.map((signal) => signal.id).join(",");
  if (signals) parts.push(`signals: ${signals}`);
  if (report.integrityWarnings.length) parts.push(`integrity/shasum mismatches: ${report.integrityWarnings.length}`);
  parts.push(`size: ${formatBytes(report.size.bytes)}`);
  return parts.join("; ");
}

function formatAdvisoryVersion(label: "old" | "new" | "version", result: AdvisoryVersionResult): string[] {
  const heading = label === "version" ? "version" : `${label} version`;
  const lines = [`  ${heading} ${result.version}`];
  if (result.unavailable) {
    lines.push(`    advisories unavailable: ${result.unavailable}`);
    return lines;
  }
  if (result.vulns.length === 0) {
    lines.push("    none returned");
    return lines;
  }
  for (const advisory of result.vulns) {
    lines.push(...formatAdvisory(advisory));
  }
  return lines;
}

function formatAdvisory(advisory: Advisory): string[] {
  const lines = [`    ${advisory.id}`];
  lines.push(`      aliases: ${advisory.aliases.length ? advisory.aliases.join(", ") : "(none reported)"}`);
  lines.push(`      severity: ${advisory.severity}`);
  lines.push(`      affected ranges: ${advisory.affectedRanges.length ? advisory.affectedRanges.join(", ") : "(none reported)"}`);
  if (advisory.summary) lines.push(`      summary (OSV): ${advisory.summary}`);
  lines.push("      references:");
  if (advisory.references.length === 0) {
    lines.push("        - (none reported)");
  } else {
    for (const reference of advisory.references) lines.push(`        - ${reference}`);
  }
  return lines;
}

function formatBatchAdvisorySummary(sidecar: AdvisorySidecar): string {
  return `${formatBatchAdvisoryVersion(sidecar.oldVersion)} for old / ${formatBatchAdvisoryVersion(sidecar.newVersion)} for new`;
}

function formatBatchAdvisoryVersion(result: AdvisoryVersionResult): string {
  if (result.unavailable) return "unavailable";
  return result.vulns.length === 0 ? "none" : `${result.vulns.length}`;
}

function formatSignal(signal: Signal): string[] {
  const lines = [`  ${signal.title}`];
  switch (signal.id) {
    case "lifecycle-scripts": {
      for (const [name, change] of Object.entries(signal.details as Record<string, { old: string | null; new: string | null }>)) {
        lines.push(`     ${name}: ${change.old ?? "<absent>"} -> ${change.new ?? "<absent>"}`);
      }
      break;
    }
    case "maintainer-publisher": {
      const details = signal.details as { publisher?: { old: string | null; new: string | null } | null; addedMaintainers: string[]; removedMaintainers: string[] };
      if (details.publisher) lines.push(`     publisher: ${details.publisher.old ?? "<absent>"} -> ${details.publisher.new ?? "<absent>"}`);
      if (details.addedMaintainers.length) lines.push(`     added maintainers: ${details.addedMaintainers.join(", ")}`);
      if (details.removedMaintainers.length) lines.push(`     removed maintainers: ${details.removedMaintainers.join(", ")}`);
      break;
    }
    case "executable-payloads":
    case "minified-source": {
      const details = signal.details as { heuristic?: string; files: string[] };
      if (details.heuristic) lines.push(`     heuristic: ${details.heuristic}`);
      for (const file of details.files) lines.push(`     ${file}`);
      break;
    }
    case "native-build-config": {
      const details = signal.details as {
        files: string[];
        commandSubstitutions: { file: string; expression: string }[];
        commands: { file: string; command: string }[];
        nativeSourcesPresent: boolean;
      };
      for (const file of details.files) lines.push(`     gyp file: ${file}`);
      for (const item of details.commandSubstitutions) lines.push(`     command substitution: ${item.file}: ${item.expression}`);
      for (const item of details.commands) lines.push(`     build command: ${item.file}: ${item.command}`);
      lines.push(`     native sources: ${details.nativeSourcesPresent ? "present" : "none"}`);
      break;
    }
    case "install-path-network": {
      const details = signal.details as { heuristic: string; hits: { source: string; terms: string[] }[] };
      lines.push(`     heuristic: ${details.heuristic}`);
      for (const hit of details.hits) lines.push(`     ${hit.source}: ${hit.terms.join(", ")}`);
      break;
    }
    case "new-bin": {
      const details = signal.details as { added: Record<string, string> };
      for (const [name, target] of Object.entries(details.added)) lines.push(`     ${name}: ${target}`);
      break;
    }
    case "size-delta": {
      const details = signal.details as { oldBytes: number; newBytes: number; threshold: string; oldUnpackedSize?: number; newUnpackedSize?: number };
      lines.push(`     unpacked: ${formatBytes(details.oldBytes)} -> ${formatBytes(details.newBytes)} (${details.threshold})`);
      if (details.oldUnpackedSize !== undefined || details.newUnpackedSize !== undefined) {
        lines.push(`     registry dist.unpackedSize: ${details.oldUnpackedSize ?? "unknown"} -> ${details.newUnpackedSize ?? "unknown"}`);
      }
      break;
    }
    case "dependency-fields": {
      const details = signal.details as Record<string, { added: { name: string; version: string }[]; removed: { name: string; version: string }[]; changed: { name: string; old: string; new: string }[]; interest: string }>;
      for (const [field, diff] of Object.entries(details)) {
        lines.push(`     ${field}${diff.interest === "lower" ? " (lower-interest)" : ""}`);
        for (const item of diff.added) lines.push(`       + ${item.name}@${item.version}`);
        for (const item of diff.removed) lines.push(`       - ${item.name}@${item.version}`);
        for (const item of diff.changed) lines.push(`       ~ ${item.name}: ${item.old} -> ${item.new}`);
      }
      break;
    }
    case "license": {
      const details = signal.details as { license: { old: string | null; new: string | null } | null; files: { path: string; status: string }[] };
      if (details.license) lines.push(`     package.json license: ${details.license.old ?? "<absent>"} -> ${details.license.new ?? "<absent>"}`);
      for (const file of details.files) lines.push(`     ${file.status}: ${file.path}`);
      break;
    }
  }
  return lines;
}

function formatFileChange(entry: FileChange): string {
  if (entry.status === "added") return `(new, 0 -> ${formatBytes(entry.newSize ?? 0)})`;
  if (entry.status === "removed") return `(removed, ${formatBytes(entry.oldSize ?? 0)} -> 0)`;
  if (entry.binaryOrLarge) return `(changed, binary/large, ${formatBytes(entry.oldSize ?? 0)} -> ${formatBytes(entry.newSize ?? 0)})`;
  const label = entry.minifiedHeuristic ? "changed, minified, " : "";
  if (entry.addedLines !== undefined || entry.removedLines !== undefined) {
    return `(${label}+${entry.addedLines ?? 0} / -${entry.removedLines ?? 0})`;
  }
  return `(${label}${formatBytes(entry.oldSize ?? 0)} -> ${formatBytes(entry.newSize ?? 0)})`;
}

function statusLetter(status: string): string {
  if (status === "added") return "A";
  if (status === "removed") return "R";
  return "C";
}

function formatSkippedReason(reason: SkippedReason): string {
  if (reason === "multiple-versions") return "multiple versions";
  return reason;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${trim(kb)} KB`;
  return `${trim(kb / 1024)} MB`;
}

function trim(value: number): string {
  return value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, "");
}

function shortHash(value: string): string {
  return value.length > 24 ? `${value.slice(0, 24)}...` : value;
}
