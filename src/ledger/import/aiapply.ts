// AIApply applications, from its emails: one "X received your application"
// notice per application (aiapplynotif.com), with titles filled in from the
// daily digests (aiapplymail.com) where the notice omits them.
import { identityKey, normalizeEmployer } from "../normalize";
import type { Candidate, Question } from "./types";

// Consume explicitly selected notice evidence.
export type AiApplyNotice = {
  employer: string;
  title: string | null;
  date: string;
  evidence: string;
  // Listed in a digest, with no per-application notice to back it up.
  digestOnly?: boolean;
};

export function aiapplyCandidates(
  notices: AiApplyNotice[],
  answers: Record<string, string>,
): { candidates: Candidate[]; questions: Question[] } {
  const seen = new Map<string, Candidate>();
  const questions: Question[] = [];
  for (const n of [...notices].sort((a, b) => a.date.localeCompare(b.date))) {
    const key = identityKey(n.employer, n.title) ?? `employer:${normalizeEmployer(n.employer)}`;
    // AIApply re-notifies. The first notice dates the application.
    if (seen.has(key)) continue;
    if (n.digestOnly) {
      const id = `aiapply:${key}`;
      const answer = answers[id];
      if (answer === undefined) {
        questions.push({
          id,
          kind: "aiapply_digest_only",
          text: `AIApply's digest lists ${n.employer}${n.title ? ` — ${n.title}` : ""}, but no notice for it arrived. Record it as applied?`,
          evidence: n.evidence,
          options: ["applied", "skip"],
        });
        continue;
      }
      if (answer !== "applied") continue;
    }
    seen.set(key, {
      source: "aiapply",
      sourceJobId: null,
      employer: n.employer,
      title: n.title,
      status: "applied",
      statusAt: n.date,
      appliedAt: n.date,
      postingUrl: null,
      requisitionId: null,
      mergeInto: null,
      evidence: n.evidence,
    });
  }
  return { candidates: [...seen.values()], questions };
}
