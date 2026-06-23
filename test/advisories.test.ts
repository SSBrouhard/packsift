import { describe, expect, it } from "vitest";
import { fetchAdvisories } from "../src/index.js";

describe("OSV advisory client", () => {
  it("posts npm package/version queries and maps structured advisory fields", async () => {
    const requests: { input: string | URL | Request; init?: RequestInit }[] = [];
    const vulns = await fetchAdvisories("kysely", "0.28.16", {
      endpoint: "https://osv.test/v1/query",
      fetch: async (input, init) => {
        requests.push({ input, init });
        return jsonResponse({
          vulns: [
            {
              id: "GHSA-pv5w-4p9q-p3v2",
              aliases: ["CVE-2026-44635"],
              summary: "do not map this",
              details: "do not map this either",
              database_specific: { severity: "HIGH" },
              affected: [
                {
                  package: { name: "kysely", ecosystem: "npm" },
                  ranges: [{ events: [{ introduced: "0.26.0" }, { fixed: "0.28.17" }] }]
                }
              ],
              references: [{ url: "https://github.com/kysely-org/kysely/security/advisories/GHSA-pv5w-4p9q-p3v2" }]
            }
          ]
        });
      }
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].input).toBe("https://osv.test/v1/query");
    expect(requests[0].init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ package: { name: "kysely", ecosystem: "npm" }, version: "0.28.16" });
    expect(vulns).toEqual([
      {
        id: "GHSA-pv5w-4p9q-p3v2",
        aliases: ["CVE-2026-44635"],
        severity: "HIGH",
        affectedRanges: [">=0.26.0 <0.28.17"],
        references: ["https://github.com/kysely-org/kysely/security/advisories/GHSA-pv5w-4p9q-p3v2"]
      }
    ]);
    expect(JSON.stringify(vulns)).not.toContain("do not map");
  });

  it("maps empty responses to an empty advisory list", async () => {
    await expect(fetchAdvisories("pkg", "1.0.0", { fetch: async () => jsonResponse({ vulns: [] }) })).resolves.toEqual([]);
  });

  it("follows OSV pagination tokens", async () => {
    const requests: unknown[] = [];
    const responses = [
      jsonResponse({ vulns: [{ id: "A" }], next_page_token: "second" }),
      jsonResponse({ next_page_token: "third" }),
      jsonResponse({ vulns: [{ id: "B" }] })
    ];

    const vulns = await fetchAdvisories("pkg", "1.0.0", {
      fetch: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return responses.shift() ?? jsonResponse({ vulns: [] });
      }
    });

    expect(requests).toEqual([
      { package: { name: "pkg", ecosystem: "npm" }, version: "1.0.0" },
      { package: { name: "pkg", ecosystem: "npm" }, version: "1.0.0", page_token: "second" },
      { package: { name: "pkg", ecosystem: "npm" }, version: "1.0.0", page_token: "third" }
    ]);
    expect(vulns.map((vuln) => vuln.id)).toEqual(["A", "B"]);
  });

  it("maps introduced-only ranges and explicit versions", async () => {
    const vulns = await fetchAdvisories("pkg", "1.0.0", {
      fetch: async () =>
        jsonResponse({
          vulns: [
            {
              id: "A",
              affected: [{ package: { name: "pkg", ecosystem: "npm" }, ranges: [{ events: [{ introduced: "0.26.0" }] }] }]
            },
            {
              id: "B",
              affected: [{ package: { name: "pkg", ecosystem: "npm" }, versions: ["1.0.0", "1.0.1"] }]
            }
          ]
        })
    });

    expect(vulns.map((vuln) => vuln.affectedRanges)).toEqual([[">=0.26.0"], ["1.0.0", "1.0.1"]]);
  });

  it("maps last affected and limit range events", async () => {
    const vulns = await fetchAdvisories("pkg", "1.0.0", {
      fetch: async () =>
        jsonResponse({
          vulns: [
            {
              id: "A",
              affected: [
                {
                  package: { name: "pkg", ecosystem: "npm" },
                  ranges: [
                    {
                      events: [
                        { introduced: "1.0.0" },
                        { last_affected: "1.5.0" },
                        { introduced: "2.0.0" },
                        { limit: "2.3.0" }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        })
    });

    expect(vulns[0].affectedRanges).toEqual([">=1.0.0 <=1.5.0", ">=2.0.0 <2.3.0"]);
  });

  it("falls back to explicit versions when ranges cannot be mapped", async () => {
    const vulns = await fetchAdvisories("pkg", "1.0.0", {
      fetch: async () =>
        jsonResponse({
          vulns: [
            {
              id: "A",
              affected: [
                {
                  package: { name: "pkg", ecosystem: "npm" },
                  ranges: [{ events: [{ unhandled: "shape" }] }],
                  versions: ["1.0.0", "1.0.1"]
                }
              ]
            }
          ]
        })
    });

    expect(vulns[0].affectedRanges).toEqual(["1.0.0", "1.0.1"]);
  });

  it("uses package-specific affected severity and ranges", async () => {
    const vulns = await fetchAdvisories("pkg", "1.0.0", {
      fetch: async () =>
        jsonResponse({
          vulns: [
            {
              id: "A",
              database_specific: { severity: "LOW" },
              severity: [{ score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:L" }],
              affected: [
                {
                  package: { name: "other", ecosystem: "npm" },
                  severity: [{ score: "CRITICAL" }],
                  ranges: [{ events: [{ introduced: "9.0.0" }, { fixed: "9.0.1" }] }]
                },
                {
                  package: { name: "pkg", ecosystem: "npm" },
                  severity: [{ score: "MEDIUM" }],
                  ranges: [{ events: [{ introduced: "1.0.0" }, { fixed: "1.0.1" }] }]
                },
                {
                  package: { name: "pkg", ecosystem: "PyPI" },
                  severity: [{ score: "HIGH" }],
                  ranges: [{ events: [{ introduced: "2.0.0" }, { fixed: "2.0.1" }] }]
                }
              ]
            }
          ]
        })
    });

    expect(vulns).toEqual([
      {
        id: "A",
        aliases: [],
        severity: "MEDIUM",
        affectedRanges: [">=1.0.0 <1.0.1"],
        references: []
      }
    ]);
  });

  it("falls back to CVSS score and then none reported for severity", async () => {
    const vulns = await fetchAdvisories("pkg", "1.0.0", {
      fetch: async () =>
        jsonResponse({
          vulns: [
            { id: "A", severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }] },
            { id: "B" }
          ]
        })
    });

    expect(vulns.map((vuln) => vuln.severity)).toEqual(["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", "(none reported)"]);
  });

  it("throws clear errors for non-200, network, and invalid JSON failures", async () => {
    await expect(fetchAdvisories("pkg", "1.0.0", { fetch: async () => new Response("nope", { status: 503 }) })).rejects.toThrow("OSV.dev request failed: HTTP 503");
    await expect(fetchAdvisories("pkg", "1.0.0", { fetch: async () => { throw new Error("socket closed"); } })).rejects.toThrow("OSV.dev request failed: socket closed");
    await expect(fetchAdvisories("pkg", "1.0.0", { fetch: async () => new Response("{", { status: 200 }) })).rejects.toThrow("OSV.dev response was not valid JSON");
  });

  it("times out unresponsive requests", async () => {
    const stalledFetch: typeof fetch = async (_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Promise<Response>(() => {});
    };

    await expect(fetchAdvisories("pkg", "1.0.0", { fetch: stalledFetch, timeoutMs: 1 })).rejects.toThrow("OSV.dev request failed: timed out after 1ms");
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
