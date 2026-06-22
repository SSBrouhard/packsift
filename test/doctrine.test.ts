import { describe, expect, it } from "vitest";
import { formatHuman } from "../src/index.js";
import { type FileChange, type JsonValue, type Report, type Signal } from "../src/types.js";

const hardBanned = [
  "merge",
  "review",
  "hold",
  "urgent",
  "risk-score",
  "recommendation",
  "recommended",
  "safe",
  "therefore",
  "should"
] as const;
const inferenceBanned = ["appears", "likely", "related"] as const;

type BannedListName = "hardBanned" | "inferenceBanned";

interface BannedVocabularyFinding {
  word: string;
  list: BannedListName;
  line: string;
}

function findBannedVocabulary(text: string): BannedVocabularyFinding[] {
  const findings: BannedVocabularyFinding[] = [];
  const lists: { list: BannedListName; words: readonly string[] }[] = [
    { list: "hardBanned", words: hardBanned },
    { list: "inferenceBanned", words: inferenceBanned }
  ];

  for (const line of text.split(/\r?\n/)) {
    for (const { list, words } of lists) {
      for (const word of words) {
        if (new RegExp(`\\b${word}\\b`, "i").test(line)) {
          findings.push({ word, list, line });
        }
      }
    }
  }

  return findings;
}

function doctrineSubject(report: Report, includeDiffs: boolean): string {
  return formatHuman(redactPackageControlledReport(report), includeDiffs);
}

function redactPackageControlledReport(report: Report): Report {
  return {
    ...report,
    packageName: "<package>",
    oldVersion: "<old-version>",
    newVersion: "<new-version>",
    integrityWarnings: report.integrityWarnings.map((warning) => ({
      ...warning,
      version: "<version>",
      expected: "<expected>",
      actual: "<actual>"
    })),
    signals: report.signals.map(redactSignal),
    files: {
      summary: report.files.summary,
      entries: report.files.entries.map(redactFileChange)
    }
  };
}

function redactSignal(signal: Signal): Signal {
  switch (signal.id) {
    case "lifecycle-scripts": {
      const details = signal.details as Record<string, { old: string | null; new: string | null }>;
      return {
        ...signal,
        details: Object.fromEntries(
          Object.entries(details).map(([name, change]) => [
            name,
            { old: redactNullable(change.old), new: redactNullable(change.new) }
          ])
        )
      };
    }
    case "maintainer-publisher": {
      const details = signal.details as {
        publisher?: { old: string | null; new: string | null } | null;
        addedMaintainers: string[];
        removedMaintainers: string[];
      };
      return {
        ...signal,
        details: {
          publisher: details.publisher
            ? { old: redactNullable(details.publisher.old), new: redactNullable(details.publisher.new) }
            : details.publisher ?? null,
          addedMaintainers: details.addedMaintainers.map(redactString),
          removedMaintainers: details.removedMaintainers.map(redactString)
        }
      };
    }
    case "executable-payloads":
    case "minified-source": {
      const details = signal.details as { heuristic?: string; files: string[] };
      return { ...signal, details: { ...details, files: details.files.map(redactString) } };
    }
    case "install-path-network": {
      const details = signal.details as { heuristic: string; hits: { source: string; terms: string[] }[] };
      return {
        ...signal,
        details: {
          heuristic: details.heuristic,
          hits: details.hits.map((hit) => ({ source: redactString(hit.source), terms: hit.terms }))
        }
      };
    }
    case "new-bin": {
      const details = signal.details as { added: Record<string, string> };
      return {
        ...signal,
        details: {
          added: Object.fromEntries(Object.values(details.added).map((target, index) => [`bin${index + 1}`, redactString(target)]))
        }
      };
    }
    case "size-delta":
      return signal;
    case "dependency-fields": {
      const details = signal.details as Record<
        string,
        {
          added: { name: string; version: string }[];
          removed: { name: string; version: string }[];
          changed: { name: string; old: string; new: string }[];
          interest: string;
        }
      >;
      return {
        ...signal,
        details: Object.fromEntries(
          Object.entries(details).map(([field, diff]) => [
            field,
            {
              added: diff.added.map(() => ({ name: "<dependency>", version: "<version>" })),
              removed: diff.removed.map(() => ({ name: "<dependency>", version: "<version>" })),
              changed: diff.changed.map(() => ({ name: "<dependency>", old: "<old-version>", new: "<new-version>" })),
              interest: diff.interest
            }
          ])
        )
      };
    }
    case "license": {
      const details = signal.details as {
        license: { old: string | null; new: string | null } | null;
        files: { path: string; status: string }[];
      };
      return {
        ...signal,
        details: {
          license: details.license
            ? { old: redactNullable(details.license.old), new: redactNullable(details.license.new) }
            : null,
          files: details.files.map((file) => ({ ...file, path: redactString(file.path) }))
        }
      };
    }
    default:
      return { ...signal, details: redactJsonStrings(signal.details) };
  }
}

function redactFileChange(entry: FileChange): FileChange {
  return {
    ...entry,
    path: redactString(entry.path),
    oldHash: entry.oldHash === undefined ? undefined : "<old-hash>",
    newHash: entry.newHash === undefined ? undefined : "<new-hash>",
    diff: entry.diff === undefined ? undefined : "<diff>"
  };
}

function redactJsonStrings(value: JsonValue): JsonValue {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactJsonStrings);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJsonStrings(item)]));
  }
  return value;
}

function redactNullable(value: string | null): string | null {
  return value === null ? null : redactString(value);
}

function redactString(_value: string): string {
  return "<value>";
}

describe("evidence-never-verdict doctrine", () => {
  it("finds banned vocabulary by whole word and list", () => {
    const line = "merge review hold urgent risk-score recommendation-style recommended safe appears";

    expect(findBannedVocabulary(line)).toEqual([
      { word: "merge", list: "hardBanned", line },
      { word: "review", list: "hardBanned", line },
      { word: "hold", list: "hardBanned", line },
      { word: "urgent", list: "hardBanned", line },
      { word: "risk-score", list: "hardBanned", line },
      { word: "recommendation", list: "hardBanned", line },
      { word: "recommended", list: "hardBanned", line },
      { word: "safe", list: "hardBanned", line },
      { word: "appears", list: "inferenceBanned", line }
    ]);
    expect(findBannedVocabulary("safely unrelatedness")).toEqual([]);
  });

  it("keeps sift-authored human output free of verdict vocabulary", () => {
    const outputs = [
      doctrineSubject(noSignalsReport, false),
      doctrineSubject(signalCoverageReport, false),
      doctrineSubject(signalCoverageReport, true)
    ];

    expect(outputs.flatMap(findBannedVocabulary)).toEqual([]);
  });
});

const noSignalsReport: Report = {
  packageName: "safe",
  oldVersion: "1.0.0",
  newVersion: "1.0.1",
  integrityWarnings: [],
  signals: [],
  files: {
    summary: { added: 0, removed: 0, changed: 1 },
    entries: [
      {
        path: "urgent.js",
        status: "changed",
        oldSize: 18,
        newSize: 18,
        oldHash: "oldhash",
        newHash: "newhash",
        addedLines: 1,
        removedLines: 1
      }
    ]
  },
  sizeDelta: {
    oldBytes: 18,
    newBytes: 18,
    fired: false,
    threshold: "> 2x or > +1 MB"
  }
};

const signalCoverageReport: Report = {
  packageName: "should",
  oldVersion: "1.0.0",
  newVersion: "2.0.0",
  integrityWarnings: [
    {
      version: "2.0.0",
      kind: "integrity",
      expected: "sha512-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      actual: "sha512-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    },
    {
      version: "2.0.0",
      kind: "shasum",
      expected: "cccccccccccccccccccccccccccccccccccccccc",
      actual: "dddddddddddddddddddddddddddddddddddddddd"
    }
  ],
  signals: [
    {
      id: "lifecycle-scripts",
      title: "Lifecycle scripts",
      details: {
        install: { old: null, new: "node safe.js" },
        postinstall: { old: "node likely.js", new: "node recommended.js" }
      }
    },
    {
      id: "maintainer-publisher",
      title: "Maintainer / publisher change",
      details: {
        publisher: { old: "safe", new: "recommended" },
        addedMaintainers: ["urgent"],
        removedMaintainers: ["related"]
      }
    },
    {
      id: "executable-payloads",
      title: "New executable payloads",
      details: { files: ["native/should.node"] }
    },
    {
      id: "minified-source",
      title: "New / newly-minified-or-obfuscated source",
      details: {
        heuristic: "average line length > 500 chars or one long line over 2 KB",
        files: ["dist/likely.js"]
      }
    },
    {
      id: "install-path-network",
      title: "Install-path network-capable code",
      details: {
        heuristic: "lifecycle command plus one-hop local require/import scan",
        hits: [
          { source: "script:install", terms: ["fetch"] },
          { source: "scripts/should.js", terms: ["dns", "https"] }
        ]
      }
    },
    {
      id: "new-bin",
      title: "New bin entries",
      details: { added: { recommended: "bin/should.js" } }
    },
    {
      id: "size-delta",
      title: "Size delta",
      details: {
        oldBytes: 1024,
        newBytes: 1049600,
        oldUnpackedSize: 1024,
        newUnpackedSize: 1049600,
        fired: true,
        threshold: "> 2x or > +1 MB"
      }
    },
    {
      id: "dependency-fields",
      title: "Dependency-field changes",
      details: {
        dependencies: {
          added: [{ name: "safe", version: "1.0.0" }],
          removed: [{ name: "urgent", version: "1.0.0" }],
          changed: [{ name: "likely", old: "1.0.0", new: "2.0.0" }],
          interest: "normal"
        },
        devDependencies: {
          added: [],
          removed: [],
          changed: [{ name: "related", old: "1.0.0", new: "1.0.1" }],
          interest: "lower"
        }
      }
    },
    {
      id: "license",
      title: "License change",
      details: {
        license: { old: "safe", new: "recommended" },
        files: [{ path: "LICENSE-urgent", status: "changed" }]
      }
    }
  ],
  files: {
    summary: { added: 1, removed: 1, changed: 2 },
    entries: [
      {
        path: "bin/recommended.js",
        status: "added",
        newSize: 33,
        newHash: "addhash"
      },
      {
        path: "old/likely.js",
        status: "removed",
        oldSize: 44,
        oldHash: "removehash"
      },
      {
        path: "dist/safe.js",
        status: "changed",
        oldSize: 2048,
        newSize: 4096,
        oldHash: "oldbundle",
        newHash: "newbundle",
        minifiedHeuristic: true,
        addedLines: 2,
        removedLines: 1,
        diff: "--- a/dist/bundle.js\n+++ b/dist/bundle.js\n@@ -1 +1 @@\n-const value = 1;\n+const value = 'safe';"
      },
      {
        path: "native/should.node",
        status: "changed",
        oldSize: 2048,
        newSize: 4096,
        oldHash: "oldnative",
        newHash: "newnative",
        binaryOrLarge: true
      }
    ]
  },
  sizeDelta: {
    oldBytes: 1024,
    newBytes: 1049600,
    oldUnpackedSize: 1024,
    newUnpackedSize: 1049600,
    fired: true,
    threshold: "> 2x or > +1 MB"
  }
};
