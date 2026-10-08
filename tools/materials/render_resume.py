"""content.json -> two-page resume PDF.

Run from the repo root:
    tools/materials/.venv/bin/python -m tools.materials.render_resume \
        --content "$PKG/content.json" --out "$PKG/Candidate_Resume.pdf"
"""
import argparse
import json
from pathlib import Path
from .workspace import check_dependencies, load_workspace_config, private_path

check_dependencies()
from xml.sax.saxutils import escape

from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.platypus import BaseDocTemplate, Flowable, Frame, PageTemplate, Paragraph

from .style import (
    BULLET_GLYPH,
    BULLET_SPACER_CHAR,
    BULLET_SPACER_COUNT,
    RESUME_PAGE,
    RESUME_STYLES,
    bullet_spacer_font_size,
    register_fonts,
    font_names,
)


REQUIRED_KEYS = ("name", "contact", "roles")
REQUIRED_CONTACT_KEYS = ("location", "phone", "email", "linkedin")


def validate(content, source="content"):
    """Fail on a missing key by name, not with a bare KeyError from a renderer.

    content.json is authored by hand (or by an agent) a step earlier in the
    skill, so a typo or an omitted block is the likely failure. Naming the
    key and the file turns a stack trace into an instruction.
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

    for index, role in enumerate(content["roles"]):
        missing = [key for key in ("company", "title", "dates") if not role.get(key)]
        if missing:
            raise ValueError(
                f"{source}: missing or empty required key(s): "
                f"{', '.join('roles[%d].%s' % (index, key) for key in missing)}"
            )


def _p(text, style_name):
    return Paragraph(escape(text), RESUME_STYLES[style_name])


def _bullet(text):
    """An achievement bullet with aligned first and continuation text.

    Size the inline spacer from the selected font metrics so the text starts
    at the configured hanging indent."""
    spacer = '<font size="{:.6f}">{}</font>'.format(
        bullet_spacer_font_size(), BULLET_SPACER_CHAR * BULLET_SPACER_COUNT
    )
    return Paragraph(BULLET_GLYPH + spacer + escape(text), RESUME_STYLES["bullet"])


class _RoleHeading(Flowable):
    """Employer and role flush left, date flush right on the first line.

    Draw text runs directly with the canvas. Reserve first-line space for the
    date and configured gap; wrap remaining words across full-width lines.
    The title is never truncated and all sizes come from style.py.

    Emit each line as one text object with real space glyphs, including the
    gap before the date, so independent text extractors can agree on reading
    order. Geometry and text extraction both require verification."""

    def __init__(self, company, title, dates, style):
        Flowable.__init__(self)
        self.company = company
        self.title = title
        self.dates = dates
        self.style = style
        self._lines = None

    def _tokens(self):
        """(word, font) pairs for 'COMPANY — Title', in reading order."""
        tokens = [(word, font_names()[1]) for word in self.company.split()]
        tokens.append(("-", font_names()[0]))
        tokens.extend((word, font_names()[0]) for word in self.title.split())
        return tokens

    @staticmethod
    def _runs(words):
        """Merge consecutive same-font words into runs holding real spaces.

        The separating space between two differently-fonted runs is parked
        at the end of the earlier run, so every gap between words is an
        actual space glyph inside some run rather than a jump of the text
        cursor that extractors read as a line break.
        """
        runs = []
        for word, font in words:
            if runs and runs[-1][1] == font:
                runs[-1][0] += " " + word
            elif runs:
                runs[-1][0] += " "
                runs.append([word, font])
            else:
                runs.append([word, font])
        return [(text, font) for text, font in runs]

    def _runs_width(self, runs):
        return sum(stringWidth(text, font, self.style.fontSize) for text, font in runs)

    def wrap(self, availWidth, availHeight):
        self.width = availWidth
        style = self.style
        self._space_w = stringWidth(" ", font_names()[0], style.fontSize)
        self._date_w = stringWidth(self.dates, font_names()[0], style.fontSize)
        first_line_limit = max(self.width - self._date_w - RESUME_PAGE["role_date_gap_pt"], 0)

        lines = [[]]
        for word, font in self._tokens():
            limit = first_line_limit if len(lines) == 1 else self.width
            candidate = lines[-1] + [(word, font)]
            # Measure the candidate exactly as it will be drawn, spaces and
            # per-run fonts included, rather than summing word widths and a
            # nominal space width.
            if lines[-1] and self._runs_width(self._runs(candidate)) > limit:
                lines.append([(word, font)])
            else:
                lines[-1] = candidate

        self._lines = [self._runs(words) for words in lines]
        self.height = len(self._lines) * style.leading
        return self.width, self.height

    def _pad_to_the_date(self, text, used_w):
        """Close the gap to the right margin, then show the date, in place.

        The gap is filled with as many real space glyphs as fit and closed
        exactly with PDF word spacing (Tw) -- the operator reportlab
        documents for flush justification. Jumping the text cursor instead
        lands the date in the same spot but leaves no characters between
        the title and the date, which pdfminer.six reads as the start of a
        new line. Spaces keep the whole heading on one extracted line for
        every extractor, and the date still ends exactly on the margin.
        """
        style = self.style
        text.setFont(font_names()[0], style.fontSize)
        gap = self.width - self._date_w - used_w
        count = max(1, int(gap // self._space_w))
        text.setWordSpace((gap - count * self._space_w) / count)
        text.textOut(" " * count)
        text.setWordSpace(0)
        text.textOut(self.dates)

    def draw(self):
        canvas = self.canv
        style = self.style
        canvas.saveState()
        canvas.setFillColor(style.textColor)

        for index, runs in enumerate(self._lines):
            # Approximate the font's ascent as 0.8em (a reasonable fit for
            # Arial) so the glyphs sit within the leading with descender room.
            baseline_y = self.height - index * style.leading - style.fontSize * 0.8
            text = canvas.beginText()
            text.setTextOrigin(0, baseline_y)
            for run, font in runs:
                text.setFont(font, style.fontSize)
                text.textOut(run)
            if index == 0:
                self._pad_to_the_date(text, self._runs_width(runs))
            canvas.drawText(text)

        canvas.restoreState()


def _role_heading(role):
    """Employer and role on one line, the date flush right at the text margin.

    See _RoleHeading for why this is a custom Flowable rather than a
    Paragraph with a tab stop.
    """
    return _RoleHeading(role["company"], role["title"], role["dates"], RESUME_STYLES["role"])


def _employer_name(role):
    """The employer as Workday should record it: "Synthetic", not "SYNTHETIC".

    The standard heading sets the company in capitals as a design choice;
    in the Workday layout the employer line is read straight into the
    company field, so it takes an explicit `employer` when the role gives
    one and otherwise a title-cased company.
    """
    if role.get("employer"):
        return role["employer"]
    company = role["company"]
    return company.title() if company.isupper() else company


def _workday_role_heading(role):
    """Title, employer and dates as three separate paragraphs.

    Keep employment fields distinct for autofill parsing. Dates use a spaced
    hyphen as required by the selected layout."""
    dates = role["dates"].replace("–", "-").replace("—", "-")
    return [
        _p(role["title"], "wd_role_title"),
        _p(_employer_name(role), "wd_role_employer"),
        _p(" ".join(dates.split()), "wd_role_dates"),
    ]


def build_story(content):
    story = [_p(content["name"].upper(), "name")]
    if content.get("headline"):
        story.append(_p(content["headline"], "positioning"))

    c = content["contact"]
    story.append(_p(f'{c["location"]} | {c["phone"]} | {c["email"]}', "contact"))
    story.append(_p(c["linkedin"], "linkedin"))

    if content.get("summary"):
        story.append(_p(content["summary"], "summary"))
    if content.get("expertise"):
        story.append(_p(content["expertise"], "expertise"))

    workday = content.get("layout") == "workday"
    story.append(_p("PROFESSIONAL EXPERIENCE", "section"))
    for role in content["roles"]:
        if workday:
            story.extend(_workday_role_heading(role))
        else:
            story.append(_role_heading(role))
        if role.get("context"):
            story.append(_p(role["context"], "role_context"))
        for bullet in role.get("bullets", []):
            story.append(_bullet(bullet))

    if content.get("education"):
        story.append(_p("EDUCATION", "section"))
        for item in content["education"]:
            story.append(_p(item["institution"], "education_institution"))
            story.append(_p(item["degree"], "degree"))

    if content.get("skillGroups"):
        story.append(_p("TECHNICAL SKILLS", "section"))
        for group in content["skillGroups"]:
            story.append(Paragraph(
                f'<b>{escape(group["label"])}:</b> {escape(group["items"])}',
                RESUME_STYLES["skills"],
            ))
    return story


def render_resume(content, out_path, source="content", workspace_config=None, preferred_family=None):
    """Render and return the page count.

    `source` names the file the content came from, so a validation
    failure says which file to go and fix.
    """
    validate(content, source)
    if workspace_config is not None:
        out_path = str(private_path(workspace_config.workspace_root, out_path))
    register_fonts(preferred_family or "Arial")
    name = content["name"]
    doc = BaseDocTemplate(
        out_path,
        pagesize=(RESUME_PAGE["width_pt"], RESUME_PAGE["height_pt"]),
        leftMargin=RESUME_PAGE["left_pt"], rightMargin=RESUME_PAGE["right_pt"],
        topMargin=RESUME_PAGE["top_pt"], bottomMargin=RESUME_PAGE["bottom_pt"],
        title=f"{name} Resume", author=name,
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="body",
                  leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    # No footer: preserve the single-column content extraction order.
    doc.addPageTemplates([PageTemplate(id="resume", frames=[frame])])
    doc.build(build_story(content))
    if workspace_config is not None and doc.page != workspace_config.resume_pages:
        raise ValueError(f'Rendered {doc.page} pages; expected {workspace_config.resume_pages}. Review supported content and layout before readiness')
    return doc.page


def main():
    parser = argparse.ArgumentParser(description="Render a resume PDF from content JSON.")
    parser.add_argument("--content", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--workspace-config", required=True, type=Path)
    parser.add_argument("--font-family", choices=("Arial", "Liberation Sans"), default="Arial")
    args = parser.parse_args()
    workspace_config = load_workspace_config(args.workspace_config)
    private_path(workspace_config.workspace_root, args.content)
    with open(args.content) as handle:
        content = json.load(handle)
    pages = render_resume(content, args.out, source=args.content, workspace_config=workspace_config, preferred_family=args.font_family)
    print(json.dumps({"out": args.out, "pages": pages}))


if __name__ == "__main__":
    main()
