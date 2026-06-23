import { type Advisory } from "./types.js";

const DEFAULT_ENDPOINT = "https://api.osv.dev/v1/query";
const NO_SEVERITY = "(none reported)";

interface FetchAdvisoriesOptions {
  endpoint?: string;
  fetch?: typeof fetch;
}

interface OsvQueryResponse {
  vulns?: OsvVulnerability[];
}

interface OsvVulnerability {
  id?: unknown;
  aliases?: unknown;
  severity?: unknown;
  database_specific?: unknown;
  affected?: unknown;
  references?: unknown;
}

interface OsvAffected {
  package?: {
    ecosystem?: unknown;
    name?: unknown;
  };
  ranges?: unknown;
  versions?: unknown;
}

interface OsvRange {
  events?: unknown;
}

interface OsvEvent {
  introduced?: unknown;
  fixed?: unknown;
}

interface OsvReference {
  url?: unknown;
}

interface OsvSeverity {
  score?: unknown;
}

export async function fetchAdvisories(name: string, version: string, options: FetchAdvisoriesOptions = {}): Promise<Advisory[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  if (!fetchImpl) throw new Error("fetch is not available");

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ package: { name, ecosystem: "npm" }, version })
    });
  } catch (error) {
    throw new Error(`OSV.dev request failed: ${errorMessage(error)}`);
  }

  if (!response.ok) {
    throw new Error(`OSV.dev request failed: HTTP ${response.status}`);
  }

  let body: OsvQueryResponse;
  try {
    body = (await response.json()) as OsvQueryResponse;
  } catch (error) {
    throw new Error(`OSV.dev response was not valid JSON: ${errorMessage(error)}`);
  }

  return (arrayOf(body.vulns) as OsvVulnerability[]).map(mapVulnerability);
}

function mapVulnerability(vuln: OsvVulnerability): Advisory {
  return {
    id: stringValue(vuln.id) ?? "(unknown id)",
    aliases: arrayOf(vuln.aliases).flatMap((alias) => {
      const value = stringValue(alias);
      return value === undefined ? [] : [value];
    }),
    severity: mapSeverity(vuln),
    affectedRanges: mapAffectedRanges(vuln.affected),
    references: arrayOf(vuln.references).flatMap((reference) => {
      const url = stringValue((reference as OsvReference).url);
      return url === undefined ? [] : [url];
    })
  };
}

function mapSeverity(vuln: OsvVulnerability): string {
  const databaseSpecific = objectValue(vuln.database_specific);
  const databaseSeverity = stringValue(databaseSpecific?.severity);
  if (databaseSeverity) return databaseSeverity;

  for (const severity of arrayOf(vuln.severity)) {
    const score = stringValue((severity as OsvSeverity).score);
    if (score) return score;
  }

  return NO_SEVERITY;
}

function mapAffectedRanges(affectedValue: unknown): string[] {
  const ranges: string[] = [];
  const versions: string[] = [];

  for (const affected of arrayOf(affectedValue) as OsvAffected[]) {
    if (stringValue(affected.package?.ecosystem) !== "npm") continue;
    const affectedRanges = arrayOf(affected.ranges) as OsvRange[];
    for (const range of affectedRanges) {
      ranges.push(...mapRangeEvents(range.events));
    }
    if (affectedRanges.length === 0) {
      versions.push(...arrayOf(affected.versions).flatMap((version) => {
        const value = stringValue(version);
        return value === undefined ? [] : [value];
      }));
    }
  }

  return ranges.length > 0 ? ranges : versions;
}

function mapRangeEvents(eventsValue: unknown): string[] {
  const output: string[] = [];
  let introduced: string | undefined;

  for (const event of arrayOf(eventsValue) as OsvEvent[]) {
    const nextIntroduced = stringValue(event.introduced);
    if (nextIntroduced !== undefined) {
      introduced = nextIntroduced;
      continue;
    }

    const fixed = stringValue(event.fixed);
    if (fixed !== undefined) {
      output.push(introduced === undefined ? `<${fixed}` : `>=${introduced} <${fixed}`);
      introduced = undefined;
    }
  }

  if (introduced !== undefined) output.push(`>=${introduced}`);
  return output;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
