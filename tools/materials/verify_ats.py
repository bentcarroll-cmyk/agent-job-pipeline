"""Check a rendered PDF text layer, layout and employment-field extraction.

A single-column layout and real text layer support machine parsing.
Report role lines independently with pdfplumber and pypdf; disagreement
requires review because extraction algorithms can interpret text objects
differently. These checks do not establish acceptance by a hosted ATS.

Run: python -m tools.materials.verify_ats --pdf resume.pdf --expect-roles 2"""
import argparse
import json
import re

import pdfplumber
from pypdf import PdfReader

# "COMPANY — Role Title    January 2023 - Present"
#
# The role heading is drawn flush-left (employer + title) with the date
# flush-right on the SAME line (see render_resume.py's _RoleHeading). When
# the employer+title is long enough to wrap, only the first line carries
# the date; this regex is only asked to find that first line, not to
# reconstruct a wrapped title -- see the wrapped-heading regression test in
# tests/materials/test_verify_ats.py for why that is an intentional limit.
ROLE_LINE = re.compile(
    r"^(?P<line>.*?\s+(?P<dates>"
    r"(January|February|March|April|May|June|July|August|September|October|November|December)"
    r"\s+\d{4}\s*[-–]\s*(Present|"
    r"(January|February|March|April|May|June|July|August|September|October|November|December)"
    r"\s+\d{4})))\s*$"
)


# Workday layout: title, employer and dates on three separate lines, the
# dates line holding nothing else ("July 2025 - Present").
_MONTH = r"(January|February|March|April|May|June|July|August|September|October|November|December)"
DATES_ONLY_LINE = re.compile(
    rf"^{_MONTH}\s+\d{{4}}\s*[-–]\s*(Present|{_MONTH}\s+\d{{4}})$"
)


def _workday_roles_from_lines(lines):
    """Records as (title, employer, dates): the two lines above each dates line."""
    lines = [_normalize(line) for line in lines]
    lines = [line for line in lines if line]
    roles = []
    for index, line in enumerate(lines):
        if index >= 2 and DATES_ONLY_LINE.match(line):
            roles.append({"title": lines[index - 2], "employer": lines[index - 1],
                          "dates": line})
    return roles


def _normalize(line):
    """Collapse whitespace runs.

    The role heading holds its date flush right with a run of real space
    characters. pdfplumber collapses those to one space, pypdf keeps them
    all; normalising lets the two extractors be compared for content
    rather than for spacing.
    """
    return " ".join(line.split())


def _roles_from_lines(lines):
    roles = []
    for line in lines:
        match = ROLE_LINE.match(_normalize(line))
        if match:
            roles.append({"line": match.group("line").strip(),
                          "dates": match.group("dates").strip()})
    return roles


def _pdfplumber_lines(pdf_path):
    with pdfplumber.open(pdf_path) as pdf:
        return [line for page in pdf.pages
                for line in (page.extract_text() or "").splitlines()]


def _pypdf_lines(pdf_path):
    return [line for page in PdfReader(str(pdf_path)).pages
            for line in (page.extract_text() or "").splitlines()]


# pdfplumber first: its result is the one reported, because the geometry
# checks below already read the page through it.
EXTRACTORS = (("pdfplumber", _pdfplumber_lines), ("pypdf", _pypdf_lines))


def extract_work_history(pdf_path):
    warnings = []
    text_chars = 0
    max_columns = 1

    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            text_chars += len(page.chars)
            words = page.extract_words()
            if words:
                columns = _column_gaps(words, page.width)
                max_columns = max(max_columns, columns)

    lines_by_extractor = {name: read(pdf_path) for name, read in EXTRACTORS}
    primary = EXTRACTORS[0][0]
    layout = "inline"
    by_extractor = {name: _roles_from_lines(lines) for name, lines in lines_by_extractor.items()}
    if not by_extractor[primary]:
        workday = {name: _workday_roles_from_lines(lines)
                   for name, lines in lines_by_extractor.items()}
        if workday[primary]:
            layout = "workday"
            by_extractor = {
                name: [dict(role, line=f'{role["title"]} | {role["employer"]}') for role in found]
                for name, found in workday.items()
            }
    roles = by_extractor[primary]
    if layout == "workday":
        for role in roles:
            # The failure this layout exists to prevent: an employer line
            # that carries part of the title, or a title line that carries
            # the employer or a separator.
            if len(role["employer"].split()) > 4 or any(
                mark in role["employer"] + role["title"] for mark in ("—", " | ")
            ):
                warnings.append(f"workday record looks merged: {role!r}")

    if text_chars == 0:
        warnings.append("PDF has no text layer; ATS parsers will extract nothing")
    if max_columns > 1:
        warnings.append(f"layout reads as {max_columns} columns; parsers may interleave them")
    if not roles:
        warnings.append("no work-history lines matched; Workday autofill may not populate")

    reference = [role["line"] for role in roles]
    for name, found in by_extractor.items():
        if name == primary:
            continue
        if [role["line"] for role in found] != reference:
            warnings.append(
                f"extractors disagree on role lines: {primary} read {reference!r}, "
                f"{name} read {[role['line'] for role in found]!r}; "
                "a parser that reads the content stream will see the second one"
            )

    return {
        "layout": layout,
        "text_layer": text_chars > 0,
        "columns": max_columns,
        "roles": roles,
        "role_lines_by_extractor": {
            name: [role["line"] for role in found] for name, found in by_extractor.items()
        },
        "warnings": warnings,
    }


def _column_gaps(words, page_width):
    """Count distinct text columns by looking for a persistent vertical corridor.

    Sample the midline band: a true second column leaves a wide empty
    x-range on most lines, whereas a right-tabbed date (the role heading's
    flush-right date, on the same row as the flush-left employer/title)
    leaves one only on the handful of role-heading rows. Requiring the gap
    on most rows before calling it a second column is what keeps those
    role-heading dates from being misread as a column break.
    """
    rows = {}
    for word in words:
        rows.setdefault(round(word["top"]), []).append((word["x0"], word["x1"]))
    wide_gap_rows = 0
    for spans in rows.values():
        spans.sort()
        for (_, end), (start, _) in zip(spans, spans[1:]):
            if start - end > page_width * 0.25:
                wide_gap_rows += 1
                break
    return 2 if rows and wide_gap_rows > len(rows) * 0.6 else 1


def main():
    parser = argparse.ArgumentParser(description="Verify a resume PDF parses for ATS autofill.")
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--expect-roles", type=int, default=None,
                         help="fail if the number of extracted role lines differs from N")
    args = parser.parse_args()
    result = extract_work_history(args.pdf)
    if args.expect_roles is not None and len(result["roles"]) != args.expect_roles:
        result["warnings"].append(
            f"expected {args.expect_roles} role line(s); found {len(result['roles'])}"
        )
    print(json.dumps(result, indent=2))
    raise SystemExit(1 if result["warnings"] else 0)


if __name__ == "__main__":
    main()
