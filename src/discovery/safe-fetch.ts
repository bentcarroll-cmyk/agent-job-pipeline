import type { SafePageFetcher } from "./types";

export type SafeFetchReason = "unsupported" | "blocked" | "budget_exhausted" | "transient";
export class SafeFetchError extends Error {
  constructor(public readonly reason: SafeFetchReason, message: string) { super(message); }
}

type Transport = (url: string, init: RequestInit) => Promise<Response>;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function authority(urlText: string, allowedHosts: ReadonlySet<string>): URL {
  let url: URL;
  try { url = new URL(urlText); }
  catch { throw new SafeFetchError("unsupported", "Invalid page URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
    !/^[a-z0-9.-]+$/.test(url.hostname) || !allowedHosts.has(url.hostname)) {
    throw new SafeFetchError("unsupported", "Destination is outside the reviewed HTTPS host allowlist");
  }
  return url;
}

async function readBounded(response: Response, maxBytes: number, deadline: number): Promise<string> {
  const claimedLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(claimedLength) && claimedLength > maxBytes) {
    throw new SafeFetchError("budget_exhausted", "Page exceeds byte limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new SafeFetchError("transient", "Page body deadline exceeded");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new SafeFetchError("transient", "Page body deadline exceeded")), remaining);
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new SafeFetchError("budget_exhausted", "Page exceeds byte limit");
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { try { await reader.cancel(); } catch { /* already closed */ } }
}

// Only reviewed exact hosts can leave this boundary. The transport is
// injected so tests never resolve .test domains. Production activation still
// requires an egress probe; this function does not assert DNS pinning.
export function createSafePageFetcher(input: { allowedHosts: readonly string[]; transport?: Transport }): SafePageFetcher {
  const allowed = new Set(input.allowedHosts.map(host => host.toLowerCase()));
  if (allowed.size === 0 || [...allowed].some(host => !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(host) ||
    host === "localhost" || host.endsWith(".localhost"))) {
    throw new Error("Safe fetch requires reviewed public hostnames");
  }
  const transport = input.transport ?? fetch;
  return async (urlText, limits) => {
    if (!Number.isSafeInteger(limits.maxRequests) || limits.maxRequests < 1 ||
      !Number.isSafeInteger(limits.maxRedirects) || limits.maxRedirects < 0 ||
      !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 ||
      !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1) {
      throw new SafeFetchError("budget_exhausted", "Invalid page budget");
    }
    const first = authority(urlText, allowed);
    const deadline = Date.now() + limits.timeoutMs;
    const seen = new Set<string>();
    const redirects: string[] = [];
    let current = first;
    let requests = 0;
    while (true) {
      if (seen.has(current.href)) throw new SafeFetchError("blocked", "Redirect loop");
      seen.add(current.href);
      if (requests >= limits.maxRequests) throw new SafeFetchError("budget_exhausted", "Request limit exhausted");
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new SafeFetchError("transient", "Page deadline exceeded");
      requests++;
      let response: Response;
      try {
        response = await transport(current.href, { method: "GET", redirect: "manual",
          headers: { Accept: "text/html, application/ld+json, application/json" },
          signal: AbortSignal.timeout(Math.max(1, remaining)) });
      } catch {
        throw new SafeFetchError("transient", "Page transport failed or timed out");
      }
      if (REDIRECTS.has(response.status)) {
        if (redirects.length >= limits.maxRedirects) throw new SafeFetchError("budget_exhausted", "Redirect limit exhausted");
        const location = response.headers.get("Location");
        if (!location) throw new SafeFetchError("blocked", "Redirect lacks destination");
        let destination: string;
        try { destination = new URL(location, current).href; }
        catch { throw new SafeFetchError("blocked", "Redirect destination is invalid"); }
        current = authority(destination, allowed);
        redirects.push(current.href);
        continue;
      }
      const body = await readBounded(response, limits.maxBytes, deadline);
      return { requestedUrl: first.href, finalUrl: current.href, status: response.status,
        contentType: response.headers.get("Content-Type"), body, redirects,
        requestCount: requests, fetchedAt: new Date().toISOString() };
    }
  };
}
