import json
from dataclasses import replace
from pathlib import Path
import pdfplumber
from pypdf import PdfReader
import pytest
from synthetic import candidate
from tools.materials.existing_package import reserve_package
from tools.materials.render_resume import render_resume
from tools.materials.render_letter import render_letter
from tools.materials.measure_space import measure
from tools.materials.check_bullets import check
from tools.materials.verify_ats import extract_work_history
from tools.materials.workspace import load_evidence
from tools.materials.style import RESUME_PAGE


@pytest.mark.parametrize('engineering', [False, True])
def test_real_candidate_pdf_package_quality_and_association(tmp_path, engineering, preferred_family=None):
    config, posting, content, letter = candidate(tmp_path / 'private', engineering)
    package = reserve_package(config, posting)
    resume, companion = package/'resume.pdf', package/'letter.pdf'
    assert render_resume(content, str(resume), workspace_config=config, preferred_family=preferred_family) == 2
    assert render_letter(letter, str(companion), workspace_config=config, preferred_family=preferred_family) == 1
    assert json.loads((package/'posting.json').read_text())['id'] == posting['id']
    assert load_evidence(config)['scope'] == 'Three service teams'
    for bullet in content['roles'][0]['bullets']:
        assert bullet in load_evidence(config).values()
    with pdfplumber.open(resume) as pdf:
        plumber_text = '\n'.join(page.extract_text() for page in pdf.pages)
        # Every rendered glyph stays inside the declared page margins.
        for page in pdf.pages:
            assert all(char['x0'] >= RESUME_PAGE['left_pt'] - 0.5 and char['x1'] <= page.width - RESUME_PAGE['right_pt'] + 0.5 for char in page.chars)
            assert all(char['top'] >= RESUME_PAGE['top_pt'] - 0.5 and char['bottom'] <= page.height - RESUME_PAGE['bottom_pt'] + 0.5 for char in page.chars)
    reader = PdfReader(str(resume))
    independent_text = '\n'.join(page.extract_text() for page in reader.pages)
    other_name = 'Alex Example' if engineering else 'Morgan Example'
    for text in (plumber_text, independent_text):
        assert content['name'].upper() in text and other_name.upper() not in text
        assert content['contact']['location'] in text
        normalized = ' '.join(text.split())
        for role in content['roles']:
            normalized = normalized.replace(role['dates'], '')
        assert all(role['title'] in ' '.join(normalized.split()) for role in content['roles'])
        assert 'Four service teams' not in text and 'four fictional service teams' not in text
    ats = extract_work_history(str(resume))
    assert not ats['warnings'] and len(ats['roles']) == 4
    assert ats['role_lines_by_extractor']['pdfplumber'] == ats['role_lines_by_extractor']['pypdf']
    assert not check(str(resume))['violations']
    assert all(page['fill_ratio'] >= .8 for page in measure(str(resume), 'resume')['pages'])
    assert measure(str(companion), 'letter')['pages'][0]['fill_ratio'] >= .5
    assert content['name'] in PdfReader(str(companion)).pages[0].extract_text()


def test_long_heading_wrapping_preserves_words_and_independent_dates(tmp_path):
    config, _, content, _ = candidate(tmp_path/'private')
    content['roles'] = [content['roles'][0]]
    content['roles'][0]['title'] = 'Senior Director of Global Service Reliability and Operational Planning across Synthetic Programs'
    out = tmp_path/'private/long.pdf'
    render_resume(content, str(out), workspace_config=replace(config, resume_pages=1))
    ats = extract_work_history(str(out))
    assert len(ats['roles']) == 1 and not ats['warnings']
    extracted = ' '.join(PdfReader(str(out)).pages[0].extract_text().split())
    extracted = ' '.join(extracted.replace(content['roles'][0]['dates'], '').split())
    assert content['roles'][0]['title'] in extracted


def test_private_outputs_page_count_and_disabled_letter_block(tmp_path):
    config, _, content, letter = candidate(tmp_path/'private')
    with pytest.raises(ValueError, match='inside'): render_resume(content, str(tmp_path/'outside.pdf'), workspace_config=config)
    with pytest.raises(ValueError, match='expected 1'): render_resume(content, str(config.workspace_root/'wrong-pages.pdf'), workspace_config=replace(config, resume_pages=1))
    with pytest.raises(ValueError, match='disabled'): render_letter(letter, str(config.workspace_root/'letter.pdf'), workspace_config=replace(config, cover_letter_enabled=False))


@pytest.mark.parametrize('engineering', [False, True])
def test_fallback_real_pdf_layout_and_actual_embedded_family(tmp_path, engineering, monkeypatch, installed_liberation):
    monkeypatch.setenv('MATERIALS_FONT_DIR', str(installed_liberation))
    test_real_candidate_pdf_package_quality_and_association(tmp_path, engineering, preferred_family='Liberation Sans')
    package = next((tmp_path/'private/applications').glob('*/v001'))
    for name in ('resume', 'letter'):
        reader = PdfReader(str(package/f'{name}.pdf'))
        fonts = [str(font.get_object()['/BaseFont']) for page in reader.pages for font in page['/Resources']['/Font'].get_object().values()]
        assert any('LiberationSans' in name for name in fonts) and not any('Arial' in name for name in fonts)
    # A subsequent default render selects Arial again, despite the installed fallback.
    config, _, _, letter = candidate(tmp_path/'default')
    out = config.workspace_root/'default-letter.pdf'
    render_letter(letter, str(out), workspace_config=config)
    fonts = [str(font.get_object()['/BaseFont']) for font in PdfReader(str(out)).pages[0]['/Resources']['/Font'].get_object().values()]
    assert any('Arial' in name for name in fonts) and not any('LiberationSans' in name for name in fonts)
