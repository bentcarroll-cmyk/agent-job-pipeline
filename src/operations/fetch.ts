// The signal remains attached while callers read json()/text(), so a
// provider that sends headers and then stalls its body is bounded too.
// This is shorter than a discovery step and its lease; per-posting callers
// can record a retry instead of letting the Workflow time out around them.
export function fetchWithDeadline(url: string, init?: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(30_000);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(url, { ...init, signal });
}
