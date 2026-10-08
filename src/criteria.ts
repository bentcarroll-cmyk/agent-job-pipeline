export const VERDICT_TOOL = {
  type: "function" as const,
  function: {
    name: "record_verdict",
    description: "Record the match verdict for this job posting",
    parameters: {
      type: "object",
      properties: {
        match: { type: "boolean", description: "true if this posting should be surfaced to the candidate" },
        hard_exclude: {
          type: ["string", "null"],
          enum: ["1", "2", "3", "4", null],
          description: "Which hard-exclude rule triggered (1-4), or null if none did",
        },
        lane: {
          type: ["string", "null"],
          enum: ["A", "B", null],
          description: "Which function-fit lane this matched, or null if neither",
        },
        reason: { type: "string", description: "One sentence explaining the verdict" },
      },
      required: ["match", "reason", "lane", "hard_exclude"],
      additionalProperties: false,
    },
  },
};

export type Verdict = {
  match: boolean;
  hard_exclude: string | null;
  lane: "A" | "B" | null;
  reason: string;
};

export function parseVerdict(argsJson: string): Verdict {
  let parsed;
  try { parsed = JSON.parse(argsJson); }
  catch { throw new Error("verdict requires complete, valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(",") !== "hard_exclude,lane,match,reason" ||
      typeof parsed.match !== "boolean" || typeof parsed.reason !== "string" || !parsed.reason.trim())
    throw new Error("verdict requires the complete supported wire contract");
  // Retain the supported provider spelling for an explicit null exclusion.
  const hardExclude = parsed.hard_exclude === "null" ? null : parsed.hard_exclude;
  if (![null, "1", "2", "3", "4"].includes(hardExclude) || ![null, "A", "B"].includes(parsed.lane) ||
      (parsed.match && (hardExclude !== null || parsed.lane === null)) ||
      (!parsed.match && hardExclude === null && parsed.lane !== null))
    throw new Error("verdict contains unsupported or contradictory fields");
  return { match: parsed.match, hard_exclude: hardExclude, lane: parsed.lane, reason: parsed.reason };
}
