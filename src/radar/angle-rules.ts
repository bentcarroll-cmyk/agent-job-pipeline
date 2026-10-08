// Source-grounded public draft constraints; no candidate career facts inferred.
export const ANGLE_RULES = `Angles:
- One line stating a supported position about the supplied source, for the reader to review.
- Never imply personal experience, current employment, authority, metrics or opinions from target-role interests.
- Do not reveal confidential employer information, internal product names, budgets or performance figures.
- Do not mention the reader's job search, applications, resume or personal job-search tooling.
- These are private drafts. Publishing or messaging requires an explicit user request.`;

// Whole phrases, ignoring case; generic disclosure constraints only.
export const BANNED_TERMS: string[] = [
  "open to work", "job search", "job hunt", "my next role", "my next chapter",
  "my next opportunity", "my resume", "hire me",
];
