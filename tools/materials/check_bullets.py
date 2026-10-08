"""Measure rendered bullet lines and reject bullets split across page breaks.

Line counts follow supported content, usually two or three lines. Longer
bullets produce review warnings; page starts mid-bullet are violations.
Run: python -m tools.materials.check_bullets --pdf resume.pdf --out report.json
"""
import argparse
import json

import pdfplumber

from .style import BULLET_GLYPH, BULLET_INDENT_PT, RESUME_PAGE

WARN_ABOVE_LINES = 3

# Continuation lines start BULLET_INDENT_PT past the marker. Half of that
# absorbs glyph side bearings without mistaking one for the other.
INDENT_TOLERANCE_PT = BULLET_INDENT_PT / 2


def _body_lines(page):
    """(x0, text) for each rendered line inside the body rectangle."""
    body_top = RESUME_PAGE["top_pt"]
    body_bottom = RESUME_PAGE["height_pt"] - RESUME_PAGE["bottom_pt"]
    rows = {}
    for word in page.extract_words():
        if word["top"] >= body_top - 0.5 and word["bottom"] <= body_bottom + 0.5:
            rows.setdefault(round(word["top"]), []).append(word)
    lines = []
    for top in sorted(rows):
        words = sorted(rows[top], key=lambda w: w["x0"])
        lines.append((words[0]["x0"], " ".join(w["text"] for w in words)))
    return lines


def _kind(x0, text):
    """Headings and context lines sit on the left margin; bullets start with
    the marker. Anything else indented is the tail of a bullet. The margin is
    tested before the em dash because bullet text can contain one too."""
    if text.startswith(BULLET_GLYPH):
        return "bullet"
    if x0 > RESUME_PAGE["left_pt"] + INDENT_TOLERANCE_PT:
        return "continuation"
    return "heading" if "-" in text else "margin"


def check(pdf_path):
    found = []
    page_starts = []
    with pdfplumber.open(pdf_path) as pdf:
        for number, page in enumerate(pdf.pages, start=1):
            lines = _body_lines(page)
            if number > 1 and lines:
                x0, text = lines[0]
                page_starts.append({"page": number, "kind": _kind(x0, text), "text": text})

            # Reset at the page break: the tail of a split bullet is reported
            # as the next page's start, not as more lines of this bullet.
            current = None
            for x0, text in lines:
                if text.startswith(BULLET_GLYPH):
                    current = {"page": number, "x0": x0, "lines": [text]}
                    found.append(current)
                elif current and x0 > current["x0"] + INDENT_TOLERANCE_PT:
                    current["lines"].append(text)
                else:
                    current = None

    bullets = [{
        "page": b["page"],
        "lines": len(b["lines"]),
        "long": len(b["lines"]) > WARN_ABOVE_LINES,
        "text": " ".join(b["lines"]),
    } for b in found]

    warnings = [
        f"page {b['page']}: bullet renders in {b['lines']} lines: {b['text']}"
        for b in bullets if b["long"]
    ]
    violations = [
        f"page {s['page']} starts mid-bullet; a bullet is split across "
        f"the page break: {s['text']}"
        for s in page_starts if s["kind"] == "continuation"
    ]
    return {
        "pdf": pdf_path,
        "warn_above_lines": WARN_ABOVE_LINES,
        "bullets": bullets,
        "page_starts": page_starts,
        "warnings": warnings,
        "violations": violations,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Count resume bullet lines and fail on a bullet split across a page.")
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--out")
    args = parser.parse_args()
    report = check(args.pdf)
    text = json.dumps(report, indent=2)
    if args.out:
        with open(args.out, "w") as handle:
            handle.write(text)
    print(text)
    raise SystemExit(1 if report["violations"] else 0)


if __name__ == "__main__":
    main()
