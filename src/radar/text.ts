// Text helpers for what the radar sends to the models and to Slack.

export const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

// At most n UTF-16 units, without splitting a surrogate pair (an emoji, for
// instance). A lone surrogate makes the JSON body invalid, and Workers AI
// rejects the whole triage batch with HTTP 400 ("Invalid data for body -
// reason must be valid JSON"), so every length cut goes through here.
export function cut(s: string, n: number): string {
  // n <= 0 keeps nothing. Without this, a negative n reaches the slice below,
  // where the second argument's negative-index meaning ("up to n from the
  // end") slices the wrong end of the string instead of returning empty.
  if (n <= 0) return "";
  if (s.length <= n) return s;
  const last = s.charCodeAt(n - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n);
}
