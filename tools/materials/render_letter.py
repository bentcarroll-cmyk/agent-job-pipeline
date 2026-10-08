"""letter.json -> one-page cover letter PDF.

Run from the repo root:
    tools/materials/.venv/bin/python -m tools.materials.render_letter \
        --content "$PKG/letter.json" --out "$PKG/Candidate_Cover_Letter.pdf"

The letter shares the resume's Arial system but has its own geometry and no
visible header or footer. There is no positioning subtitle in the letter header.
"""
import argparse
import json
from pathlib import Path
from .workspace import check_dependencies, load_workspace_config, private_path

check_dependencies()
from xml.sax.saxutils import escape

from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate, Paragraph

from .style import LETTER_PAGE, LETTER_STYLES, register_fonts


REQUIRED_KEYS = ("name", "contact", "date", "subject", "salutation",
                 "paragraphs", "signoff")
REQUIRED_CONTACT_KEYS = ("location", "phone", "email", "linkedin")


def validate(content, source="content"):
    """Fail on a missing key by name, not with a bare KeyError from a renderer.

    letter.json is authored a step earlier in the skill, so a typo or an
    omitted block is the likely failure. Naming the key and the file turns a
    stack trace into an instruction.
    """
    if not isinstance(content, dict):
        raise ValueError(f"{source}: expected a JSON object, got {type(content).__name__}")

    missing = [key for key in REQUIRED_KEYS if not content.get(key)]
    if missing:
        raise ValueError(
            f"{source}: missing or empty required key(s): {', '.join(missing)}"
        )

    contact = content["contact"]
    if not isinstance(contact, dict):
        raise ValueError(f"{source}: 'contact' must be an object of "
                         f"{', '.join(REQUIRED_CONTACT_KEYS)}")
    missing = [key for key in REQUIRED_CONTACT_KEYS if not contact.get(key)]
    if missing:
        raise ValueError(
            f"{source}: missing or empty required key(s): "
            f"{', '.join('contact.' + key for key in missing)}"
        )


def _p(text, style_name):
    return Paragraph(escape(text), LETTER_STYLES[style_name])


def _doc_template(content, out_path):
    """Create and return the BaseDocTemplate with letter geometry and correct margins.

    Uses an explicit Frame with zero padding to ensure declared margins match actual
    glyph positions (reportlab's SimpleDocTemplate applies 6pt default padding).
    No footer callback since the letter has no visible header or footer.
    """
    name = content["name"]
    doc = BaseDocTemplate(
        out_path,
        pagesize=(LETTER_PAGE["width_pt"], LETTER_PAGE["height_pt"]),
        leftMargin=LETTER_PAGE["left_pt"], rightMargin=LETTER_PAGE["right_pt"],
        topMargin=LETTER_PAGE["top_pt"], bottomMargin=LETTER_PAGE["bottom_pt"],
        title=f"{name} Cover Letter", author=name,
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="body",
                  leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([PageTemplate(id="letter", frames=[frame])])
    return doc


def build_story(content):
    c = content["contact"]
    story = [
        _p(content["name"].upper(), "name"),
        _p(f'{c["location"]} | {c["phone"]} | {c["email"]}', "contact"),
        _p(c["linkedin"], "linkedin"),
        _p(content["date"], "date"),
        _p(content["subject"], "subject"),
        _p(content["salutation"], "salutation"),
    ]
    story += [_p(paragraph, "body") for paragraph in content["paragraphs"]]
    story += [_p(content["signoff"], "signoff"), _p(content["name"], "signature_name")]
    return story


def render_letter(content, out_path, source="content", workspace_config=None, preferred_family=None):
    """Render and return the page count. Must be 1; the caller enforces that.

    `source` names the file the content came from, so a validation
    failure says which file to go and fix.
    """
    validate(content, source)
    if workspace_config is not None:
        out_path = str(private_path(workspace_config.workspace_root, out_path))
        if not workspace_config.cover_letter_enabled:
            raise ValueError('Cover letters are disabled in this workspace')
    register_fonts(preferred_family or "Arial")
    doc = _doc_template(content, out_path)
    doc.build(build_story(content))
    if workspace_config is not None and doc.page != 1:
        raise ValueError(f'Rendered {doc.page} pages; expected 1. Review supported content and layout before readiness')
    return doc.page


def main():
    parser = argparse.ArgumentParser(description="Render a cover letter PDF from content JSON.")
    parser.add_argument("--content", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--workspace-config", required=True, type=Path)
    parser.add_argument("--font-family", choices=("Arial", "Liberation Sans"), default="Arial")
    args = parser.parse_args()
    workspace_config = load_workspace_config(args.workspace_config)
    private_path(workspace_config.workspace_root, args.content)
    with open(args.content) as handle:
        content = json.load(handle)
    pages = render_letter(content, args.out, source=args.content, workspace_config=workspace_config, preferred_family=args.font_family)
    print(json.dumps({"out": args.out, "pages": pages}))


if __name__ == "__main__":
    main()
