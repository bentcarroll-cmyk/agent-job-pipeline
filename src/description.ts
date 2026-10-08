// Retain the head and tail of bounded posting text: role scope often appears
// near the start, while compensation and location conditions may appear last.
// Truncation remains explicit evidence uncertainty for screening.
export const MAX_DESCRIPTION_CHARS = 8000;

// Normalize and bound compensation HTML before model and Slack use.
export const MAX_COMPENSATION_CHARS = 400;

// The materials path reads the whole posting. MAX_DESCRIPTION_CHARS bounds
// per-posting screening spend on a match/no-match decision; reusing it here
// would tailor a resume against a budget artifact whose elided middle is
// usually the responsibilities the hiring argument is built from. This bound
// only guards against a pathological page.
export const MAX_MATERIALS_CHARS = 100000;
const HEAD_CHARS = 5000;
const ELISION = "\n\n… [middle of posting omitted] …\n\n";

export type TextProvenance = {
  provided: boolean;
  // Counts normalized plain text, not raw HTML. Null means no string was observed.
  originalChars: number | null;
  // Includes any omission marker in the returned text.
  retainedChars: number;
  truncated: boolean | null;
  sourceFields: string[];
  normalizerVersion: string;
};

const NORMALIZER_VERSION = "plain-text-v2";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// Returns readable plain text, or null when the posting has no usable body.
// Handles both real HTML (Ashby, Lever) and Greenhouse's entity-encoded
// HTML, which needs decoding before its tags can be stripped at all.
export function htmlToText(raw: string | null | undefined, limit: number = MAX_DESCRIPTION_CHARS): string | null {
  return htmlToTextWithProvenance(raw, limit).text;
}

// This records retention of observed provider text, never completeness of the
// entire posting. An empty string is observed input; an absent field is unknown.
export function htmlToTextWithProvenance(
  raw: unknown,
  limit: number = MAX_DESCRIPTION_CHARS,
  sourceFields: string[] = [],
): { text: string | null; provenance: TextProvenance } {
  const provenance: TextProvenance = {
    provided: typeof raw === "string", originalChars: null, retainedChars: 0,
    truncated: null, sourceFields: [...sourceFields], normalizerVersion: NORMALIZER_VERSION,
  };
  if (typeof raw !== "string") return { text: null, provenance };

  let text = decodeEntities(raw);
  text = text
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    // `li` is absent by design: <li> already opened its own line above, so
    // closing it too would double-space every bullet.
    .replace(/<\/(p|div|h[1-6]|tr|ul|ol|section)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  // Entities that were themselves encoded (&amp;nbsp;) survive the first
  // pass as literal text; this catches them.
  text = decodeEntities(text);

  text = text
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  provenance.originalChars = text.length;
  provenance.truncated = text.length > limit;
  const retained = truncate(text, limit) || null;
  provenance.retainedChars = retained?.length ?? 0;
  return { text: retained, provenance };
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= 0) return "";
  // A limit below the head budget (compensation, say) is a plain head cut:
  // there is no "middle" worth eliding in a field that short.
  if (limit <= HEAD_CHARS) return `${cutForward(text.slice(0, limit - 1))}…`;
  const headBudget = Math.min(HEAD_CHARS, limit - ELISION.length - 1);
  const head = cutForward(text.slice(0, headBudget));
  const tail = cutBackward(text.slice(text.length - (limit - headBudget - ELISION.length)));
  return `${head}${ELISION}${tail}`;
}

// Both cuts land on whitespace so GLM never sees a severed word that reads
// as a different one — "Secret" out of "Secretary" would invent a clearance
// requirement that the posting never stated.
function cutForward(chunk: string): string {
  const boundary = chunk.lastIndexOf(" ");
  return (boundary > chunk.length * 0.8 ? chunk.slice(0, boundary) : chunk).trimEnd();
}

function cutBackward(chunk: string): string {
  const boundary = chunk.indexOf(" ");
  return (boundary >= 0 && boundary < chunk.length * 0.2 ? chunk.slice(boundary) : chunk).trimStart();
}
