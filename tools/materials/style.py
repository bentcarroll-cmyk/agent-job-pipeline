"""Shared single-column document geometry and typography.

Point sizes live here. Line spacing is exact, never a multiplier. Reviewed
pagination uses explicitly selected reviewed fonts; missing fonts/licenses block completion.
"""
from .workspace import resolve_font_paths

from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfbase.ttfonts import TTFont

PT_PER_INCH = 72.0

RESUME_PAGE = {
    "width_pt": 8.5 * PT_PER_INCH,
    "height_pt": 11 * PT_PER_INCH,
    "left_pt": 0.65 * PT_PER_INCH,
    "right_pt": 0.65 * PT_PER_INCH,
    # 835 twips; twips are 1/20 pt.
    "top_pt": 835 / 20,
    "bottom_pt": 835 / 20,
    # Minimum breathing room between a wrapped role heading's text and the
    # date on its first line (render_resume.py's _RoleHeading).
    "role_date_gap_pt": 6,
}

LETTER_PAGE = {
    "width_pt": 8.5 * PT_PER_INCH,
    "height_pt": 11 * PT_PER_INCH,
    "left_pt": 0.65 * PT_PER_INCH,
    "right_pt": 0.65 * PT_PER_INCH,
    "top_pt": 0.60 * PT_PER_INCH,
    "bottom_pt": 0.65 * PT_PER_INCH,
    # Declared for completeness; the letter renders no visible header or footer.
    "footer_distance_pt": 0.50 * PT_PER_INCH,
}

# One configured indent controls both the bullet text start and hanging
# continuation, keeping every line aligned. Twips are 1/20 point.
BULLET_INDENT_PT = 187 / 20
BULLET_GLYPH = "•"

# Non-breaking space: reportlab collapses ordinary spaces and would happily
# break the line between the marker and the first word.
BULLET_SPACER_CHAR = " "

# The gap after the marker is set as this many non-breaking spaces at a
# derived size (see bullet_spacer_font_size). Two keeps that size below the
# 11 pt body, so the spacer never becomes the tallest glyph on its line.
BULLET_SPACER_COUNT = 2

_FONTS_REGISTERED = None
_ACTIVE_FONT_NAMES = ("Arial", "Arial-Bold")


def register_fonts(preferred_family=None):
    """Select actual embedded fonts explicitly; internal bullet calls retain selection."""
    global _FONTS_REGISTERED, _ACTIVE_FONT_NAMES
    if preferred_family is None and _FONTS_REGISTERED is not None:
        return
    regular, bold = resolve_font_paths(preferred_family)
    if _FONTS_REGISTERED == (regular, bold):
        return
    names = ("LiberationSans", "LiberationSans-Bold") if preferred_family == 'Liberation Sans' else ("Arial", "Arial-Bold")
    pdfmetrics.registerFont(TTFont(names[0], str(regular)))
    pdfmetrics.registerFont(TTFont(names[1], str(bold)))
    pdfmetrics.registerFontFamily(names[0], normal=names[0], bold=names[1],
                                  italic=names[0], boldItalic=names[1])
    for styles in (RESUME_STYLES, LETTER_STYLES):
        for style in styles.values():
            style.fontName = names[1] if style.fontName.endswith('-Bold') else names[0]
    _ACTIVE_FONT_NAMES = names
    _FONTS_REGISTERED = (regular, bold)


def font_names():
    register_fonts()
    return _ACTIVE_FONT_NAMES


def _style(name, font, size, leading, space_before=0, space_after=0, **kw):
    return ParagraphStyle(name, fontName=font, fontSize=size, leading=leading,
                          spaceBefore=space_before, spaceAfter=space_after,
                          textColor=colors.black, **kw)


# Single source of resume typography and paragraph spacing.
RESUME_STYLES = {
    "name": _style("name", "Arial-Bold", 24, 27, 0, 2),
    "positioning": _style("positioning", "Arial-Bold", 12, 15, 0, 4),
    "contact": _style("contact", "Arial", 10, 12, 0, 0),
    "linkedin": _style("linkedin", "Arial", 10, 12, 0, 8),
    "summary": _style("summary", "Arial", 11, 12.7, 0, 6),
    "expertise": _style("expertise", "Arial", 10, 12, 0, 0),
    "section": _style("section", "Arial-Bold", 10.5, 12.7, 9, 5, keepWithNext=True),
    "role": _style("role", "Arial-Bold", 11, 12.7, 6, 3, keepWithNext=True),
    "role_context": _style("role_context", "Arial", 10, 11.6, 0, 5, keepWithNext=True),
    # Workday layout: title, employer and dates as separate paragraphs so
    # the parser cannot read the start of the title into the employer.
    "wd_role_title": _style("wd_role_title", "Arial-Bold", 11, 12.7, 6, 0, keepWithNext=True),
    "wd_role_employer": _style("wd_role_employer", "Arial-Bold", 11, 12.7, 0, 0, keepWithNext=True),
    "wd_role_dates": _style("wd_role_dates", "Arial", 10, 12.7, 0, 3, keepWithNext=True),
    # A true hanging indent: the first line starts at the left margin
    # (leftIndent + firstLineIndent == 0) and carries the marker, every
    # continuation line starts at BULLET_INDENT_PT, and the explicitly sized
    # spacer after the marker puts the first line's text there too.
    "bullet": _style("bullet", "Arial", 11, 12.7, 0, 3,
                     leftIndent=BULLET_INDENT_PT, firstLineIndent=-BULLET_INDENT_PT),
    "earlier_descriptor": _style("earlier_descriptor", "Arial-Bold", 10.5, 12.7, 0, 4, keepWithNext=True),
    "education_institution": _style("education_institution", "Arial-Bold", 11, 12.7, 0, 2),
    "degree": _style("degree", "Arial", 11, 12.7, 0, 6),
    "skills": _style("skills", "Arial", 10, 12, 0, 3),
}

# Cover letter typography and paragraph spacing.
LETTER_STYLES = {
    "name": _style("l_name", "Arial-Bold", 24, 27, 0, 4),
    "contact": _style("l_contact", "Arial", 10, 14.5, 0, 0),
    "linkedin": _style("l_linkedin", "Arial", 10, 14.5, 0, 16),
    "date": _style("l_date", "Arial", 10, 14.5, 0, 10),
    "subject": _style("l_subject", "Arial-Bold", 11, 14.5, 0, 12),
    "salutation": _style("l_salutation", "Arial", 11, 14.5, 0, 10),
    "body": _style("l_body", "Arial", 11, 14.5, 0, 10, firstLineIndent=0),
    "signoff": _style("l_signoff", "Arial", 11, 14.5, 0, 3),
    "signature_name": _style("l_signature_name", "Arial", 11, 14.5, 0, 0),
}


def bullet_spacer_font_size():
    """Point size at which the spacer closes the gap after the bullet exactly.

    reportlab's own bullet machinery (Paragraph's bulletText) cannot produce
    this geometry: it starts the first line's text at
    ``bulletIndent + bulletWidth + 0.6 * bulletFontSize``, which is 10.45 pt
    for an 11 pt marker and so overruns the 9.35 pt the reference calls for,
    leaving a step between the first line and the continuation lines. The
    marker is therefore inline and the gap after it is sized here, from the
    font's own metrics, instead of being whatever an `&nbsp;` happens to
    measure.
    """
    register_fonts()
    body = RESUME_STYLES["bullet"]
    gap = BULLET_INDENT_PT - stringWidth(BULLET_GLYPH, body.fontName, body.fontSize)
    per_pt = stringWidth(BULLET_SPACER_CHAR, body.fontName, 1000) / 1000.0
    return gap / (BULLET_SPACER_COUNT * per_pt)
