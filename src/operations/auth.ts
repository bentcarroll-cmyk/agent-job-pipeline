/** Missing installation secrets never authorize a predictable bearer value. */
export function authorizedTrigger(request: Request, secret: unknown): boolean {
  return typeof secret === "string" && secret.trim().length > 0 &&
    request.headers.get("authorization") === `Bearer ${secret}`;
}
