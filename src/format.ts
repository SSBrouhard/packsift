import { FileChange, Report, Signal } from "./types.js";

export function formatHuman(report: Report, includeDiffs: boolean): string {
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
