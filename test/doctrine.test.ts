import { describe, expect, it } from "vitest";
import { formatHuman } from "../src/index.js";
import { Report } from "../src/types.js";

const hardBanned = ["safe", "urgent", "recommended", "therefore", "should"] as const;
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

describe("evidence-never-verdict doctrine", () => {
  it("finds banned vocabulary by whole word and list", () => {
    expect(findBannedVocabulary("this upgrade appears safe, merge recommended")).toEqual([
      { word: "safe", list: "hardBanned", line: "this upgrade appears safe, merge recommended" },
      { word: "recommended", list: "hardBanned", line: "this upgrade appears safe, merge recommended" },
      { word: "appears", list: "inferenceBanned", line: "this upgrade appears safe, merge recommended" }
    ]);
    expect(findBannedVocabulary("safely unrelatedness")).toEqual([]);
  });

  it("keeps sift-authored human output free of verdict vocabulary", () => {
    const outputs = [
      formatHuman(noSignalsReport, false),
      formatHuman(signalCoverageReport, false),
      formatHuman(signalCoverageReport, true)
    ];

    expect(outputs.flatMap(findBannedVocabulary)).toEqual([]);
  });
});

const noSignalsReport: Report = {
  packageName: "fixture-pkg",
  oldVersion: "1.0.0",
  newVersion: "1.0.1",
  integrityWarnings: [],
  signals: [],
  files: {
    summary: { added: 0, removed: 0, changed: 1 },
    entries: [
      {
        path: "index.js",
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
  packageName: "fixture-pkg",
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
        install: { old: null, new: "node scripts/setup.js" },
        postinstall: { old: "node scripts/old.js", new: "node scripts/new.js" }
      }
    },
    {
      id: "maintainer-publisher",
      title: "Maintainer / publisher change",
      details: {
        publisher: { old: "alice", new: "bob" },
        addedMaintainers: ["carol"],
        removedMaintainers: ["dave"]
      }
    },
    {
      id: "executable-payloads",
      title: "New executable payloads",
      details: { files: ["native/addon.node"] }
    },
    {
      id: "minified-source",
      title: "New / newly-minified-or-obfuscated source",
      details: {
        heuristic: "average line length > 500 chars or one long line over 2 KB",
        files: ["dist/bundle.js"]
      }
    },
    {
      id: "install-path-network",
      title: "Install-path network-capable code",
      details: {
        heuristic: "lifecycle command plus one-hop local require/import scan",
        hits: [
          { source: "script:install", terms: ["fetch"] },
          { source: "scripts/setup.js", terms: ["dns", "https"] }
        ]
      }
    },
    {
      id: "new-bin",
      title: "New bin entries",
      details: { added: { fixture: "bin/fixture.js" } }
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
          added: [{ name: "alpha", version: "1.0.0" }],
          removed: [{ name: "beta", version: "1.0.0" }],
          changed: [{ name: "gamma", old: "1.0.0", new: "2.0.0" }],
          interest: "normal"
        },
        devDependencies: {
          added: [],
          removed: [],
          changed: [{ name: "delta", old: "1.0.0", new: "1.0.1" }],
          interest: "lower"
        }
      }
    },
    {
      id: "license",
      title: "License change",
      details: {
        license: { old: "MIT", new: "Apache-2.0" },
        files: [{ path: "LICENSE", status: "changed" }]
      }
    }
  ],
  files: {
    summary: { added: 1, removed: 1, changed: 2 },
    entries: [
      {
        path: "bin/fixture.js",
        status: "added",
        newSize: 33,
        newHash: "addhash"
      },
      {
        path: "old/module.js",
        status: "removed",
        oldSize: 44,
        oldHash: "removehash"
      },
      {
        path: "dist/bundle.js",
        status: "changed",
        oldSize: 2048,
        newSize: 4096,
        oldHash: "oldbundle",
        newHash: "newbundle",
        minifiedHeuristic: true,
        addedLines: 2,
        removedLines: 1,
        diff: "--- a/dist/bundle.js\n+++ b/dist/bundle.js\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;"
      },
      {
        path: "native/addon.node",
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
