"""Per-page usable-room measurement, PDF only.

Read the document geometry from style.py and measure retained page content.
Report available space for factual review before content is trimmed.

Run: python -m tools.materials.measure_space --pdf resume.pdf --kind resume --out report.json"""
import argparse
import json

import pdfplumber

from .style import LETTER_PAGE, RESUME_PAGE

GEOMETRY = {"resume": RESUME_PAGE, "letter": LETTER_PAGE}


def measure(pdf_path, kind):
    if kind not in GEOMETRY:
        raise ValueError(f"unknown kind {kind!r}; expected 'resume' or 'letter'")
    page_geometry = GEOMETRY[kind]

    body_top = page_geometry["top_pt"]
    body_bottom = page_geometry["height_pt"] - page_geometry["bottom_pt"]
    body_height = body_bottom - body_top

    pages = []
    with pdfplumber.open(pdf_path) as pdf:
        for index, page in enumerate(pdf.pages, start=1):
            # Only characters inside the body rectangle count as content.
            body_chars = [c for c in page.chars if c["top"] >= body_top - 0.5
                          and c["bottom"] <= body_bottom + 0.5]
            if body_chars:
                last_bottom = max(c["bottom"] for c in body_chars)
                blank = body_bottom - last_bottom
                used = last_bottom - body_top
            else:
                last_bottom = body_top
                blank = body_height
                used = 0.0
            pages.append({
                "page": index,
                "body_top_pt": round(body_top, 2),
                "body_bottom_pt": round(body_bottom, 2),
                "body_height_pt": round(body_height, 2),
                "last_text_bottom_pt": round(last_bottom, 2),
                "blank_bottom_pt": round(blank, 2),
                "fill_ratio": round(used / body_height, 4) if body_height else 0.0,
                "body_glyph_count": len(body_chars),
            })
    return {"kind": kind, "pdf": pdf_path, "pages": pages}


def main():
    parser = argparse.ArgumentParser(description="Measure per-page usable room in a rendered PDF.")
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--kind", required=True, choices=sorted(GEOMETRY))
    parser.add_argument("--out")
    args = parser.parse_args()
    report = measure(args.pdf, args.kind)
    text = json.dumps(report, indent=2)
    if args.out:
        with open(args.out, "w") as handle:
            handle.write(text)
    print(text)


if __name__ == "__main__":
    main()
