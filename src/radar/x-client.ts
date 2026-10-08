// The only file that knows twitterapi.io. Everything else sees XPost, so the
// official X API could replace this file without touching the rest.
import { fetchWithDeadline } from "../operations/fetch";

export type XPost = {
  id: string;
  url: string;
  text: string;
  createdAt: string;
  authorHandle: string;
  authorName: string | null;
  authorBio: string | null;
  authorFollowers: number | null;
  authorCreatedAt: string | null;
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
  views: number | null;
  conversationId: string | null;
  isReply: boolean;
  isRepost: boolean;
  quoted: { id: string; text: string; authorHandle: string } | null;
};

// rawCount is what the provider billed for: every post it returned, before
// any are dropped here.
export type Page = { posts: XPost[]; rawCount: number; nextCursor: string | null };
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface XClient {
  searchPosts(query: string, queryType: "Latest" | "Top", cursor?: string): Promise<Page>;
  getThreadContext(postId: string): Promise<Page>;
  getTopReplies(postId: string): Promise<Page>;
}

export class XApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "XApiError";
  }
}

const BASE = "https://api.twitterapi.io";

export function createXClient(apiKey: string, fetcher: Fetcher = fetchWithDeadline): XClient {
  async function get(path: string, params: Record<string, string>): Promise<Page> {
    const res = await fetcher(`${BASE}${path}?${new URLSearchParams(params)}`, { headers: { "X-API-Key": apiKey } });
    const body: any = await res.json().catch(() => null);
    if (!res.ok || body?.status === "error") {
      throw new XApiError(`twitterapi.io ${path} HTTP ${res.status}: ${body?.msg ?? body?.message ?? "no message"}`, res.status);
    }
    // An HTML challenge or maintenance page can arrive as a 200. Read as an
    // empty page, it would count as a successful search and let the next
    // run's window start after the posts it missed.
    if (body === null) throw new XApiError(`twitterapi.io ${path} HTTP ${res.status}: response was not JSON`, res.status);
    // Likewise for a 200 JSON body in some other, unrecognized shape: rawList
    // would silently read it as zero posts, and a search's next run would
    // then start after posts it never actually saw. A genuine empty result
    // still carries `tweets: []` (tests/fixtures/radar/search-empty.json), so
    // this only rejects a body with neither known list key.
    if (!Array.isArray(body?.tweets) && !Array.isArray(body?.replies)) {
      throw new XApiError(`twitterapi.io ${path} HTTP ${res.status}: response had no post list`, res.status);
    }
    const raw = rawList(body);
    return {
      posts: raw.map((r) => normalizePost(r)).filter((p): p is XPost => p !== null),
      rawCount: raw.length,
      nextCursor: body?.has_next_page && body?.next_cursor ? String(body.next_cursor) : null,
    };
  }
  return {
    searchPosts: (query, queryType, cursor = "") => get("/twitter/tweet/advanced_search", { query, queryType, cursor }),
    getThreadContext: (postId) => get("/twitter/tweet/thread_context", { tweetId: postId, cursor: "" }),
    getTopReplies: (postId) => get("/twitter/tweet/replies/v2", { tweetId: postId, queryType: "Likes", cursor: "" }),
  };
}

// Accepted provider envelopes use tweets or replies. The request adapter
// rejects a successful HTTP response that carries neither array.
export function rawList(body: any): unknown[] {
  const list = body?.tweets ?? body?.replies;
  return Array.isArray(list) ? list : [];
}

export function normalizePost(raw: any): XPost | null {
  if (raw?.id === undefined || raw?.id === null || raw.id === "") return null;
  const handle = str(raw.author?.userName);
  const createdAt = parseXDate(raw.createdAt);
  if (!handle || typeof raw.text !== "string" || !createdAt) return null;
  const id = String(raw.id);
  return {
    id,
    url: str(raw.url) ?? `https://x.com/${handle}/status/${id}`,
    text: raw.text,
    createdAt,
    authorHandle: handle,
    authorName: str(raw.author?.name),
    authorBio: str(raw.author?.description) ?? str(raw.author?.profile_bio?.description),
    authorFollowers: num(raw.author?.followers),
    authorCreatedAt: parseXDate(raw.author?.createdAt),
    likes: num(raw.likeCount) ?? 0,
    reposts: num(raw.retweetCount) ?? 0,
    replies: num(raw.replyCount) ?? 0,
    quotes: num(raw.quoteCount) ?? 0,
    views: num(raw.viewCount),
    conversationId: raw.conversationId ? String(raw.conversationId) : null,
    isReply: raw.isReply === true,
    isRepost: Boolean(raw.retweeted_tweet),
    quoted: raw.quoted_tweet?.id
      ? { id: String(raw.quoted_tweet.id), text: String(raw.quoted_tweet.text ?? ""), authorHandle: String(raw.quoted_tweet.author?.userName ?? "") }
      : null,
  };
}

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// X's legacy format ("Fri Sep 25 14:05:09 +0000 2026"), or ISO 8601.
export function parseXDate(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const legacy = /^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/.exec(value);
  if (legacy) {
    const [, mon, day, hh, mm, ss, sign, oh, om, year] = legacy;
    const month = MONTHS[mon];
    if (month === undefined) return null;
    const offsetMinutes = (Number(oh) * 60 + Number(om)) * (sign === "+" ? 1 : -1);
    return new Date(Date.UTC(Number(year), month, Number(day), Number(hh), Number(mm), Number(ss)) - offsetMinutes * 60_000).toISOString();
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
};
