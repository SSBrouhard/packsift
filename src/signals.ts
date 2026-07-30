import path from "node:path";
import { readFile } from "node:fs/promises";
import { FileChange, FileInfo, JsonValue, Maintainer, PackageManifest, Signal, SizeDelta } from "./types.js";
import { fileExists, readText } from "./files.js";
import { looksTextualBytes } from "./diff.js";

const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "prepublishOnly"];
const NETWORK_TERMS = ["http", "https", "net", "fetch", "child_process", "dns"];
const SOURCE_EXTENSIONS = new Set([".js", ".ts", ".mjs", ".cjs"]);
const NATIVE_SOURCE_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".hh"]);
const BUILD_INTERPRETERS = ["node", "python", "python3", "sh", "bash"];
const SORT_LOCALE = "en";

export interface SignalInput {
  oldRoot: string;
  newRoot: string;
  oldManifest: PackageManifest;
  newManifest: PackageManifest;
  oldRegistryManifest: PackageManifest;
  newRegistryManifest: PackageManifest;
  includeRegistryMetadataSignals?: boolean;
  entries: FileChange[];
  oldFiles: Map<string, FileInfo>;
  newFiles: Map<string, FileInfo>;
  sizeDelta: SizeDelta;
}

export async function computeSignals(input: SignalInput): Promise<Signal[]> {
  const signals: (Signal | undefined)[] = [
    lifecycleScripts(input.oldManifest, input.newManifest),
    input.includeRegistryMetadataSignals === false
      ? undefined
      : maintainerPublisher(input.oldRegistryManifest, input.newRegistryManifest),
    await executablePayloads(input.entries, input.newRoot),
    await minifiedSource(input.entries, input.oldRoot, input.newRoot),
    await nativeBuildConfig(input.entries, input.newFiles, input.newRoot),
    await installPathNetworkCode(input.newRoot, input.newManifest, input.entries),
    newBinEntries(input.oldManifest, input.newManifest),
    sizeDeltaSignal(input.sizeDelta),
    dependencyFields(input.oldManifest, input.newManifest),
    licenseSignal(input.oldManifest, input.newManifest, input.entries)
  ];
  return signals.filter((signal): signal is Signal => Boolean(signal));
}

function lifecycleScripts(oldManifest: PackageManifest, newManifest: PackageManifest): Signal | undefined {
  const details: Record<string, { old: string | null; new: string | null }> = {};
  for (const name of LIFECYCLE_SCRIPTS) {
    const oldValue = oldManifest.scripts?.[name];
    const newValue = newManifest.scripts?.[name];
    if (newValue !== undefined && oldValue !== newValue) {
      details[name] = { old: oldValue ?? null, new: newValue };
    }
  }
  return Object.keys(details).length
    ? { id: "lifecycle-scripts", title: "Lifecycle scripts", details }
    : undefined;
}

function maintainerPublisher(oldManifest: PackageManifest, newManifest: PackageManifest): Signal | undefined {
  const publisherChanged = maintainerId(oldManifest._npmUser) !== maintainerId(newManifest._npmUser);
  const oldMaintainers = new Set((oldManifest.maintainers ?? []).map(maintainerId).filter(Boolean));
  const newMaintainers = new Set((newManifest.maintainers ?? []).map(maintainerId).filter(Boolean));
  const added = [...newMaintainers].filter((item) => !oldMaintainers.has(item)).sort();
  const removed = [...oldMaintainers].filter((item) => !newMaintainers.has(item)).sort();

  if (!publisherChanged && added.length === 0 && removed.length === 0) return undefined;
  return {
    id: "maintainer-publisher",
    title: "Maintainer / publisher change",
    details: {
      publisher: publisherChanged
        ? { old: maintainerId(oldManifest._npmUser) || null, new: maintainerId(newManifest._npmUser) || null }
        : null,
      addedMaintainers: added,
      removedMaintainers: removed
    }
  };
}

async function executablePayloads(entries: FileChange[], newRoot: string): Promise<Signal | undefined> {
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.status !== "added" && entry.status !== "changed") continue;
    if ([".node", ".wasm"].includes(path.extname(entry.path).toLowerCase()) || (await hasNativeMagic(newRoot, entry.path))) {
      files.push(entry.path);
    }
  }
  return files.length
    ? { id: "executable-payloads", title: "New executable payloads", details: { files: files.sort() } }
    : undefined;
}

async function minifiedSource(entries: FileChange[], oldRoot: string, newRoot: string): Promise<Signal | undefined> {
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.status !== "added" && entry.status !== "changed") continue;
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.path).toLowerCase())) continue;
    const bytes = await readFile(path.join(newRoot, entry.path));
    const oldWasMinified =
      entry.status === "changed" ? looksMinified(await readFile(path.join(oldRoot, entry.path))) : false;
    if (!oldWasMinified && looksMinified(bytes)) {
      entry.minifiedHeuristic = true;
      files.push(entry.path);
    }
  }
  return files.length
    ? {
        id: "minified-source",
        title: "New / newly-minified-or-obfuscated source",
        details: { heuristic: "average line length > 500 chars or one long line over 2 KB", files: files.sort() }
      }
    : undefined;
}

async function nativeBuildConfig(entries: FileChange[], newFiles: Map<string, FileInfo>, newRoot: string): Promise<Signal | undefined> {
  const gypEntries = changedGypEntries(entries);
  if (gypEntries.length === 0) return undefined;

  const files: string[] = [];
  const commandSubstitutions: { file: string; expression: string }[] = [];
  const commands: { file: string; command: string }[] = [];

  for (const entry of gypEntries) {
    files.push(entry.path);
    const text = await readText(newRoot, entry.path);
    const evidence = extractGypEvidence(text);
    for (const expression of evidence.commandSubstitutions) {
      commandSubstitutions.push({ file: entry.path, expression });
    }
    for (const command of evidence.commands) {
      commands.push({ file: entry.path, command });
    }
  }

  const nativeSourcesPresent = [...newFiles.keys()].some((file) => NATIVE_SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()));

  return {
    id: "native-build-config",
    title: "Native build configuration",
    details: {
      files: files.sort(),
      commandSubstitutions: commandSubstitutions.sort(compareFileEvidence),
      commands: commands.sort(compareFileEvidence),
      nativeSourcesPresent
    }
  };
}

async function installPathNetworkCode(newRoot: string, manifest: PackageManifest, entries: FileChange[]): Promise<Signal | undefined> {
  const scripts = Object.entries(manifest.scripts ?? {}).filter(([name]) => LIFECYCLE_SCRIPTS.includes(name));
  const hits: { source: string; terms: string[] }[] = [];
  const referencedFiles = new Map<string, string>();

  for (const [name, command] of scripts) {
    const terms = matchingTerms(command);
    if (terms.length) hits.push({ source: `script:${name}`, terms });
    for (const ref of directFileRefs(command)) {
      if (await fileExists(newRoot, ref)) referencedFiles.set(ref, ref);
    }
  }

  for (const entry of changedGypEntries(entries)) {
    const text = await readText(newRoot, entry.path);
    for (const ref of gypLocalFileRefs(text)) {
      if ((await fileExists(newRoot, ref)) && !referencedFiles.has(ref)) referencedFiles.set(ref, `${entry.path} -> ${ref}`);
    }
  }

  for (const [ref, source] of referencedFiles) {
    const text = await readText(newRoot, ref);
    const terms = matchingTerms(text);
    if (terms.length) hits.push({ source, terms });
    for (const imported of directImportRefs(text, ref)) {
      if (await fileExists(newRoot, imported)) {
        const importedText = await readText(newRoot, imported);
        const importedTerms = matchingTerms(importedText);
        if (importedTerms.length) hits.push({ source: imported === source ? source : `${source} -> ${imported}`, terms: importedTerms });
      }
    }
  }

  return hits.length
    ? {
        id: "install-path-network",
        title: "Install-path network-capable code",
        details: { heuristic: "lifecycle/gyp command plus one-hop local require/import scan", hits }
      }
    : undefined;
}

function newBinEntries(oldManifest: PackageManifest, newManifest: PackageManifest): Signal | undefined {
  const oldBin = normalizeBin(oldManifest.bin, oldManifest.name);
  const newBin = normalizeBin(newManifest.bin, newManifest.name);
  const added = Object.keys(newBin).filter((key) => !(key in oldBin)).sort();
  return added.length
    ? { id: "new-bin", title: "New bin entries", details: { added: Object.fromEntries(added.map((key) => [key, newBin[key]])) } }
    : undefined;
}

function sizeDeltaSignal(sizeDelta: SizeDelta): Signal | undefined {
  return sizeDelta.fired ? { id: "size-delta", title: "Size delta", details: sizeDelta as unknown as JsonValue } : undefined;
}

function dependencyFields(oldManifest: PackageManifest, newManifest: PackageManifest): Signal | undefined {
  const fields = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"] as const;
  const details: Record<string, JsonValue> = {};
  for (const field of fields) {
    const diff = diffRecord(oldManifest[field] ?? {}, newManifest[field] ?? {});
    if (diff.added.length || diff.removed.length || diff.changed.length) {
      details[field] = { ...diff, interest: field === "devDependencies" ? "lower" : "normal" };
    }
  }
  return Object.keys(details).length
    ? { id: "dependency-fields", title: "Dependency-field changes", details }
    : undefined;
}

function licenseSignal(oldManifest: PackageManifest, newManifest: PackageManifest, entries: FileChange[]): Signal | undefined {
  const licenseChanged = (oldManifest.license ?? null) !== (newManifest.license ?? null);
  const licenseFiles = entries
    .filter((entry) => /^license($|[.\-_])/i.test(path.basename(entry.path)) || path.basename(entry.path).toUpperCase() === "LICENSE")
    .map((entry) => ({ path: entry.path, status: entry.status }));

  if (!licenseChanged && licenseFiles.length === 0) return undefined;
  return {
    id: "license",
    title: "License change",
    details: {
      license: licenseChanged ? { old: oldManifest.license ?? null, new: newManifest.license ?? null } : null,
      files: licenseFiles
    }
  };
}

function maintainerId(maintainer: Maintainer | undefined): string {
  if (!maintainer) return "";
  return maintainer.name ?? maintainer.username ?? maintainer.email ?? "";
}

async function hasNativeMagic(root: string, relative: string): Promise<boolean> {
  const bytes = await readFile(path.join(root, relative));
  if (bytes.length < 4) return false;
  const hex4 = bytes.subarray(0, 4).toString("hex");
  const hex2 = bytes.subarray(0, 2).toString("hex");
  return (
    hex4 === "7f454c46" ||
    hex4 === "feedface" ||
    hex4 === "feedfacf" ||
    hex4 === "cefaedfe" ||
    hex4 === "cffaedfe" ||
    hex2 === "4d5a"
  );
}

function looksMinified(bytes: Buffer): boolean {
  if (!looksTextualBytes(bytes) || bytes.length < 2048) return false;
  const text = bytes.toString("utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  const average = lines.reduce((sum, line) => sum + line.length, 0) / lines.length;
  return average > 500 || (lines.length <= 2 && bytes.length > 2048);
}

function matchingTerms(text: string): string[] {
  const lower = text.toLowerCase();
  return NETWORK_TERMS.filter((term) => lower.includes(term));
}

function changedGypEntries(entries: FileChange[]): FileChange[] {
  return entries
    .filter((entry) => (entry.status === "added" || entry.status === "changed") && isGypFile(entry.path))
    .sort((a, b) => compareStrings(a.path, b.path));
}

function isGypFile(filePath: string): boolean {
  const basename = path.posix.basename(filePath).toLowerCase();
  const ext = path.posix.extname(filePath).toLowerCase();
  return basename === "binding.gyp" || ext === ".gyp" || ext === ".gypi";
}

function extractGypEvidence(text: string): { commandSubstitutions: string[]; commands: string[] } {
  return {
    commandSubstitutions: uniqueSorted(extractGypCommandSubstitutions(text)),
    commands: uniqueSorted(extractInterpreterCommands(text))
  };
}

function extractGypCommandSubstitutions(text: string): string[] {
  const substitutions: string[] = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("<!", index);
    if (start === -1) break;
    const open = text[start + 2] === "@" ? start + 3 : start + 2;
    if (text[open] !== "(") {
      index = start + 2;
      continue;
    }

    const end = findBalancedCloseParen(text, open);
    if (end === -1) {
      index = open + 1;
      continue;
    }

    substitutions.push(text.slice(start, end + 1).trim());
    index = end + 1;
  }
  return substitutions;
}

function findBalancedCloseParen(text: string, open: number): number {
  let depth = 1;
  let quote: string | undefined;
  let escaped = false;

  for (let index = open + 1; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function extractInterpreterCommands(text: string): string[] {
  const commands: string[] = [];
  const interpreterPattern = BUILD_INTERPRETERS.join("|");
  const quotedCommand = new RegExp(String.raw`["']((?:${interpreterPattern})(?:\s+[^"']*)?)["']`, "gi");
  const arrayCommand = new RegExp(String.raw`\[((?:\s*["'][^"']+["']\s*,?)+)\]`, "g");

  for (const match of text.matchAll(quotedCommand)) {
    const command = match[1].trim();
    if (startsWithBuildInterpreter(command) && /\s/.test(command)) commands.push(command);
  }

  for (const match of text.matchAll(arrayCommand)) {
    const tokens = [...match[1].matchAll(/["']([^"']+)["']/g)].map((tokenMatch) => tokenMatch[1]);
    if (tokens.length && BUILD_INTERPRETERS.includes(tokens[0].toLowerCase())) {
      commands.push(tokens.join(" "));
    }
  }

  return commands;
}

function gypLocalFileRefs(text: string): string[] {
  const refs = new Set<string>();
  const evidence = extractGypEvidence(text);
  for (const command of [
    ...evidence.commands,
    ...evidence.commandSubstitutions.map((substitution) => substitution.replace(/^<!@?\(/, "").replace(/\)$/, ""))
  ]) {
    for (const ref of directFileRefs(command)) refs.add(ref);
  }
  return [...refs].sort();
}

function directFileRefs(command: string): string[] {
  const refs = new Set<string>();
  const patterns = [
    new RegExp(String.raw`\b(?:${BUILD_INTERPRETERS.join("|")})\s+([^\s;&|]+)`, "g"),
    /\brequire\(["']([^"']+)["']\)/g,
    /\b((?:\.\/|\.\.\/)[^\s;&|]+)/g
  ];
  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) {
      for (const ref of normalizeLocalRefs(match[1])) {
        refs.add(ref);
      }
    }
  }
  return [...refs];
}

function directImportRefs(text: string, fromFile: string): string[] {
  const refs = new Set<string>();
  const patterns = [
    /\brequire\(["']([^"']+)["']\)/g,
    /\bimport\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (!match[1].startsWith(".")) continue;
      const base = path.posix.dirname(fromFile);
      for (const normalized of normalizeLocalRefs(path.posix.join(base, match[1]))) {
        refs.add(normalized);
      }
    }
  }
  return [...refs];
}

function normalizeLocalRefs(ref: string): string[] {
  const cleaned = path.posix.normalize(ref.replace(/^['"]|['"]$/g, "").replace(/\\/g, "/")).replace(/^\.\//, "");
  if (!cleaned || cleaned.startsWith("-") || cleaned.includes("://")) return [];
  if (cleaned === ".." || cleaned.startsWith("../") || cleaned.startsWith("/")) return [];
  if (path.posix.extname(cleaned)) return [cleaned];
  const candidates = [cleaned, `${cleaned}.js`, `${cleaned}.cjs`, `${cleaned}.mjs`];
  return candidates;
}

function startsWithBuildInterpreter(command: string): boolean {
  const first = command.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return BUILD_INTERPRETERS.includes(first);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function compareFileEvidence(a: { file: string; expression?: string; command?: string }, b: { file: string; expression?: string; command?: string }): number {
  return compareStrings(a.file, b.file) || compareStrings(a.expression ?? a.command ?? "", b.expression ?? b.command ?? "");
}

function compareStrings(a: string, b: string): number {
  return a.localeCompare(b, SORT_LOCALE);
}

function normalizeBin(bin: PackageManifest["bin"], packageName?: string): Record<string, string> {
  if (!bin) return {};
  if (typeof bin === "string") return { [packageName ?? ""]: bin };
  return bin;
}

function diffRecord(oldValues: Record<string, string>, newValues: Record<string, string>) {
  const added = Object.keys(newValues)
    .filter((key) => !(key in oldValues))
    .sort()
    .map((name) => ({ name, version: newValues[name] }));
  const removed = Object.keys(oldValues)
    .filter((key) => !(key in newValues))
    .sort()
    .map((name) => ({ name, version: oldValues[name] }));
  const changed = Object.keys(newValues)
    .filter((key) => key in oldValues && oldValues[key] !== newValues[key])
    .sort()
    .map((name) => ({ name, old: oldValues[name], new: newValues[name] }));
  return { added, removed, changed };
}
