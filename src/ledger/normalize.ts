// Employer and title spelling can vary across imported records and emails.
// Normalize corporate suffixes, punctuation and supported abbreviations.
// Matching compares these normalized forms and nothing looser: a near miss
// becomes a question for the candidate, never a guess.

// Legal and corporate words that vary between a company's own emails and
// the posting. Dropped wherever they appear.
const EMPLOYER_NOISE = new Set([
  "inc",
  "llc",
  "ltd",
  "corp",
  "corporation",
  "co",
  "company",
  "technologies",
  "industries",
  "group",
]);

function words(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    // "U.S." and "US" are the same word; so are "Sr." and "Sr".
    .replace(/\./g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

export function normalizeEmployer(name: string): string {
  const kept = words(name).filter((w) => !EMPLOYER_NOISE.has(w));
  if (kept[0] === "the") kept.shift();
  return kept.join(" ");
}

// A slash-separated employer label can name multiple entities; consider
// each component as well as the whole when proposing a match.
export function employerVariants(name: string): string[] {
  const parts = name.includes("/") ? [name, ...name.split("/")] : [name];
  return [...new Set(parts.map(normalizeEmployer).filter(Boolean))];
}

export function normalizeTitle(title: string): string {
  // A trailing "(Open)" marks requisition status, not part of the title.
  return words(title.replace(/\s*\(open\)\s*$/i, ""))
    .map((w) => (w === "sr" ? "senior" : w))
    .join(" ");
}

// Null without a title: an employer-level confirmation can propose a
// candidate match but cannot establish application identity.
export function identityKey(employer: string, title: string | null): string | null {
  if (!title) return null;
  const t = normalizeTitle(title);
  return t ? `${normalizeEmployer(employer)}|${t}` : null;
}
