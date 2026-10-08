"""Find posting terminology absent from tailored resume content.

A missing label is a review suggestion, not authority to claim a skill.
Add terminology only when corrected private evidence supports the work.
Bullets stay concrete. This pre-render content check does not replace PDF
layout, fullness or independent extraction reviews.
Run: python -m tools.materials.check_terms --posting posting.json --content content.json --out terms.json
"""
import argparse
import json
import re

# (the term as the resume should write it, patterns that count as that term)
TERMS = (
    ("generative AI", (r"\bgenerative ai\b", r"\bgen ?ai\b")),
    ("machine learning", (r"\bmachine learning\b", r"\bml\b")),
    ("change management", (r"\bchange management\b",)),
    ("stakeholder management", (r"\bstakeholders?\b",)),
    ("cross-functional leadership", (r"\bcross[- ]functional\b",)),
    ("program management", (r"\bprogram management\b",)),
    ("project management", (r"\bproject management\b",)),
    ("product management", (r"\bproduct management\b",)),
    ("vendor management", (r"\bvendor management\b",)),
    ("KPIs", (r"\bkpis?\b", r"\bkey performance indicators?\b")),
    ("OKRs", (r"\bokrs?\b",)),
    ("operating model", (r"\boperating models?\b",)),
    ("process improvement", (r"\bprocess (improvement|redesign|optimi[sz]ation)\b",)),
    ("A/B testing", (r"\ba/b test", r"\bexperimentation\b")),
    ("AI governance", (r"\bai governance\b",)),
    ("data governance", (r"\bdata governance\b",)),
    ("P&L", (r"\bp&l\b", r"\bprofit and loss\b")),
)

EXCERPT_CHARS = 60


def _posting_text(posting_path):
    """job.description from the envelope fetch-posting.ts prints.

    A missing description raises: an empty text would find no terms and
    report nothing missing, which reads as an all-clear.
    """
    with open(posting_path) as handle:
        envelope = json.load(handle)
    description = (envelope.get("job") or {}).get("description")
    if not description:
        raise ValueError(f"{posting_path}: no job.description in the posting envelope")
    return description


def _strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)


def _first_match(text, patterns):
    found = [m for m in (re.search(p, text, re.IGNORECASE) for p in patterns) if m]
    return min(found, key=lambda m: m.start()) if found else None


def check(posting_path, content_path):
    posting = " ".join(_posting_text(posting_path).split())
    with open(content_path) as handle:
        resume = " ".join(" ".join(_strings(json.load(handle))).split())

    missing, present = [], []
    for term, patterns in TERMS:
        match = _first_match(posting, patterns)
        if not match:
            continue
        if _first_match(resume, patterns):
            present.append(term)
        else:
            start = max(match.start() - EXCERPT_CHARS, 0)
            missing.append({"term": term,
                            "posting_excerpt": posting[start:match.end() + EXCERPT_CHARS]})
    return {"posting": posting_path, "content": content_path,
            "missing": missing, "present": present}


def main():
    parser = argparse.ArgumentParser(
        description="List standard terms the posting uses that the resume does not.")
    parser.add_argument("--posting", required=True)
    parser.add_argument("--content", required=True)
    parser.add_argument("--out")
    args = parser.parse_args()
    report = check(args.posting, args.content)
    text = json.dumps(report, indent=2)
    if args.out:
        with open(args.out, "w") as handle:
            handle.write(text)
    print(text)


if __name__ == "__main__":
    main()
