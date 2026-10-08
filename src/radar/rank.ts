// Turns triaged posts into the editor's candidates. Rank is the triage score
// plus the author's learned boost; ties go to more likes plus replies. Each
// kind is capped on its own (10 hiring posts, 12 each of developments,
// practice and debates), so a busy kind can't crowd a quiet one out of the
// editor's view.
import type { Metrics, PostRow } from "./db";

export type CandidateKind = "development" | "debate" | "practice" | "hiring";
export type Candidate = {
  id: string;
  url: string;
  kind: CandidateKind;
  topic: string;
  score: number;
  rank: number;
  reason: string;
  text: string;
  quotedText: string | null;
  authorHandle: string;
  authorBio: string | null;
  authorFollowers: number | null;
  likes: number;
  replies: number;
  ageHours: number;
};

export const MAX_HIRING = 10;
export const MAX_PER_KIND = 12;
const KINDS: CandidateKind[] = ["development", "debate", "practice", "hiring"];

// At most 46 candidates (10 + 3 × 12), in rank order.
export function selectCandidates(rows: Array<PostRow & { boost: number }>, now: Date): Candidate[] {
  const all = rows
    .filter((r) => KINDS.includes(r.kind as CandidateKind) && (r.score ?? 0) > 0)
    .map((r) => toCandidate(r, now))
    .sort(byRank);
  return KINDS
    .flatMap((kind) => all.filter((c) => c.kind === kind).slice(0, kind === "hiring" ? MAX_HIRING : MAX_PER_KIND))
    .sort(byRank);
}

function toCandidate(r: PostRow & { boost: number }, now: Date): Candidate {
  const m = JSON.parse(r.metrics_json) as Metrics;
  const score = r.score ?? 0;
  return {
    id: r.id,
    url: r.url,
    kind: r.kind as CandidateKind,
    topic: r.topic ?? "",
    score,
    rank: score + r.boost,
    reason: r.reason ?? "",
    text: r.text,
    quotedText: r.quoted_text,
    authorHandle: r.author_handle,
    authorBio: r.author_bio,
    authorFollowers: r.author_followers,
    likes: m.likes,
    replies: m.replies,
    ageHours: Math.round(((now.getTime() - Date.parse(r.created_at)) / 3_600_000) * 10) / 10,
  };
}

function byRank(a: Candidate, b: Candidate): number {
  return b.rank - a.rank || b.likes + b.replies - (a.likes + a.replies) || a.id.localeCompare(b.id);
}
