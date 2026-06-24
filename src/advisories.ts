import { type Advisory } from "./types.js";
import { type AdvisorySidecar } from "./types.js";

export const DEFAULT_ADVISORY_ENDPOINT = "https://api.osv.dev/v1/query";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PAGES = 10;
const NO_SEVERITY = "(none reported)";

interface FetchAdvisoriesOptions {
  endpoint?: string;
  fetch?: typeof fetch;
  includeSummary?: boolean;
  timeoutMs?: number;
  maxPages?: number;
}

interface OsvQueryResponse {
  vulns?: OsvVulnerability[];
  next_page_token?: unknown;
}

interface OsvVulnerability {
  id?: unknown;
  aliases?: unknown;
  summary?: unknown;
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
  severity?: unknown;
  ranges?: unknown;
  versions?: unknown;
}

interface OsvRange {
  events?: unknown;
}

interface OsvEvent {
  introduced?: unknown;
  fixed?: unknown;
  last_affected?: unknown;
  limit?: unknown;
}

interface OsvReference {
  url?: unknown;
}

interface OsvSeverity {
  score?: unknown;
}

export async function fetchAdvisories(name: string, version: string, options: FetchAdvisoriesOptions = {}): Promise<Advisory[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? DEFAULT_ADVISORY_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  if (!fetchImpl) throw new Error("fetch is not available");
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error("maxPages must be a positive integer");

  const vulns: OsvVulnerability[] = [];
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;
  let pagesFetched = 0;

  while (true) {
    if (pagesFetched >= maxPages) {
      throw new Error(`OSV.dev pagination did not terminate after ${maxPages} pages`);
    }

    const query: Record<string, unknown> = { package: { name, ecosystem: "npm" }, version };
    if (pageToken !== undefined) query.page_token = pageToken;

    let body: OsvQueryResponse;
    try {
      body = await fetchOsvPage(fetchImpl, endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(query)
      }, timeoutMs);
    } catch (error) {
      if (error instanceof InvalidJsonError) {
        throw new Error(`OSV.dev response was not valid JSON: ${error.message}`);
      }
      throw new Error(`OSV.dev request failed: ${errorMessage(error)}`);
    }

    pagesFetched += 1;
    vulns.push(...(arrayOf(body.vulns) as OsvVulnerability[]));
    pageToken = stringValue(body.next_page_token);
    if (pageToken === undefined || pageToken === "") break;
    if (seenPageTokens.has(pageToken)) {
      throw new Error(`OSV.dev pagination repeated next_page_token: ${pageToken}`);
    }
    seenPageTokens.add(pageToken);
  }

  return vulns.map((vuln) => mapVulnerability(vuln, name, options.includeSummary ?? false));
}

export async function buildAdvisorySidecar(
  name: string,
  oldVersion: string,
  newVersion: string,
  fetchAdvisoriesImpl: (name: string, version: string) => Promise<Advisory[]>,
  now: () => Date,
  source = advisorySource()
): Promise<AdvisorySidecar> {
  const [oldResult, newResult] = await Promise.allSettled([fetchAdvisoriesImpl(name, oldVersion), fetchAdvisoriesImpl(name, newVersion)]);
  return {
    enabled: true,
    source,
    fetchedAt: now().toISOString(),
    oldVersion: settleAdvisoryVersion(oldVersion, oldResult),
    newVersion: settleAdvisoryVersion(newVersion, newResult)
  };
}

export function advisorySource(endpoint = DEFAULT_ADVISORY_ENDPOINT): string {
  return isDefaultAdvisoryEndpoint(endpoint) ? "OSV.dev" : `OSV-compatible endpoint: ${endpoint}`;
}

export function isDefaultAdvisoryEndpoint(endpoint: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return false;
  }
  const defaultEndpoint = new URL(DEFAULT_ADVISORY_ENDPOINT);
  return parsed.protocol === defaultEndpoint.protocol
    && parsed.hostname === defaultEndpoint.hostname
    && normalizedPort(parsed) === normalizedPort(defaultEndpoint)
    && stripTrailingSlashes(parsed.pathname) === defaultEndpoint.pathname
    && parsed.search === ""
    && parsed.hash === "";
}

class InvalidJsonError extends Error {}

async function fetchOsvPage(fetchImpl: typeof fetch, endpoint: string, init: RequestInit, timeoutMs: number): Promise<OsvQueryResponse> {
  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      fetchImpl(endpoint, { ...init, signal: controller.signal }),
      timeoutPromise
    ]);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    try {
      return await Promise.race([
        response.json() as Promise<OsvQueryResponse>,
        timeoutPromise
      ]);
    } catch (error) {
      if (timedOut) throw new Error(`timed out after ${timeoutMs}ms`);
      throw new InvalidJsonError(errorMessage(error));
    }
  } catch (error) {
    if (timedOut) throw new Error(`timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function mapVulnerability(vuln: OsvVulnerability, packageName: string, includeSummary: boolean): Advisory {
  return {
    id: stringValue(vuln.id) ?? "(unknown id)",
    aliases: arrayOf(vuln.aliases).flatMap((alias) => {
      const value = stringValue(alias);
      return value === undefined ? [] : [value];
    }),
    ...(includeSummary && stringValue(vuln.summary) ? { summary: stringValue(vuln.summary) } : {}),
    severity: mapSeverity(vuln, packageName),
    affectedRanges: mapAffectedRanges(vuln.affected, packageName),
    references: arrayOf(vuln.references).flatMap((reference) => {
      const url = stringValue((reference as OsvReference).url);
      return url === undefined ? [] : [url];
    })
  };
}

function settleAdvisoryVersion(version: string, result: PromiseSettledResult<Advisory[]>) {
  if (result.status === "fulfilled") return { version, vulns: result.value };
  return { version, vulns: [], unavailable: errorMessage(result.reason) };
}

function normalizedPort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function mapSeverity(vuln: OsvVulnerability, packageName: string): string {
  for (const affected of matchingAffectedEntries(vuln.affected, packageName)) {
    const severity = mapSeverityEntries(affected.severity);
    if (severity) return severity;
  }

  const databaseSpecific = objectValue(vuln.database_specific);
  const databaseSeverity = stringValue(databaseSpecific?.severity);
  if (databaseSeverity) return databaseSeverity;

  const topLevelSeverity = mapSeverityEntries(vuln.severity);
  if (topLevelSeverity) return topLevelSeverity;

  return NO_SEVERITY;
}

function mapSeverityEntries(severityValue: unknown): string | undefined {
  for (const severity of arrayOf(severityValue)) {
    const score = stringValue((severity as OsvSeverity).score);
    if (score) return score;
  }

  return undefined;
}

function mapAffectedRanges(affectedValue: unknown, packageName: string): string[] {
  const ranges: string[] = [];
  const versions: string[] = [];

  for (const affected of matchingAffectedEntries(affectedValue, packageName)) {
    const affectedRanges = arrayOf(affected.ranges) as OsvRange[];
    for (const range of affectedRanges) {
      ranges.push(...mapRangeEvents(range.events));
    }
    versions.push(...arrayOf(affected.versions).flatMap((version) => {
      const value = stringValue(version);
      return value === undefined ? [] : [value];
    }));
  }

  return ranges.length > 0 ? ranges : versions;
}

function matchingAffectedEntries(affectedValue: unknown, packageName: string): OsvAffected[] {
  return (arrayOf(affectedValue) as OsvAffected[]).filter((affected) => (
    stringValue(affected.package?.ecosystem) === "npm" &&
    stringValue(affected.package?.name) === packageName
  ));
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
      continue;
    }

    const lastAffected = stringValue(event.last_affected);
    if (lastAffected !== undefined) {
      output.push(introduced === undefined ? `<=${lastAffected}` : `>=${introduced} <=${lastAffected}`);
      introduced = undefined;
      continue;
    }

    const limit = stringValue(event.limit);
    if (limit !== undefined) {
      output.push(introduced === undefined ? `<${limit}` : `>=${introduced} <${limit}`);
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
