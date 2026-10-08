import { fetchWithDeadline } from "../operations/fetch";
import type { QueryPageRequest } from "./queries";
import type { QueryPageOutcome } from "./query-pages";

type PageFetch = (url: string, init?: RequestInit) => Promise<Response>;

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 0) return undefined;
  return Math.min(seconds, 3600);
}

export async function requestSerperPage(apiKey: string, request: QueryPageRequest,
  fetchPage: PageFetch = fetchWithDeadline): Promise<QueryPageOutcome> {
  if (!apiKey) throw new Error("Search credential is missing");
  const body = { q: request.q, page: request.page,
    ...(request.tbs ? { tbs: request.tbs } : {}) };
  let response: Response;
  try {
    response = await fetchPage("https://google.serper.dev/search", {
      method: "POST", headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body), redirect: "error",
    });
  } catch {
    // The provider may have received and billed a request even though no
    // response reached us. The Workflow must not silently repeat it.
    return { status: "uncertain", errorCode: "transport_unknown" };
  }
  if (!response.ok) return { status: "failed", errorCode: `http_${response.status}`,
    ...(retryAfter(response.headers.get("Retry-After")) === undefined ? {} :
      { retryAfterSeconds: retryAfter(response.headers.get("Retry-After")) }) };
  let bodyJson: unknown;
  try { bodyJson = await response.json(); }
  catch { return { status: "failed", errorCode: "malformed_response" }; }
  const organic = bodyJson && typeof bodyJson === "object" && "organic" in bodyJson
    ? (bodyJson as { organic: unknown }).organic : null;
  if (!Array.isArray(organic) || organic.some(item => !item || typeof item !== "object" ||
    typeof item.link !== "string" || typeof item.title !== "string")) {
    return { status: "failed", errorCode: "malformed_response" };
  }
  return { status: "complete", results: organic.map(item => ({ link: item.link, title: item.title })) };
}
