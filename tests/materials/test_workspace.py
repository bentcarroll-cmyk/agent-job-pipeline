import hashlib
import json
from pathlib import Path
import pytest
from tools.materials.workspace import load_workspace_config, capture_source_resume, load_evidence, resolve_font_paths


def workspace(tmp_path, pages=2):
    root = tmp_path / 'private'
    root.mkdir()
    (root / 'Career_Evidence.md').write_text('```json\n' + json.dumps({'schemaVersion': 1, 'facts': [{'id': 'scope', 'text': 'Managed four projects'}], 'corrections': [{'id': 'scope', 'text': 'Managed three projects'}]}) + '\n```')
    (root / 'Writing_Preferences.md').write_text('Plain language')
    (root / 'instance.json').write_text(json.dumps({'schemaVersion': 1, 'instanceId': 'synthetic', 'cloudflare': {'databaseName': 'synthetic-db', 'databaseId': 'synthetic-id'}}))
    config = root / 'materials.json'
    config.write_text(json.dumps({'schemaVersion': 1, 'workspaceRoot': str(root), 'careerEvidencePath': 'Career_Evidence.md', 'writingPreferencesPath': 'Writing_Preferences.md', 'applicationsRoot': 'applications', 'instanceConfigPath': 'instance.json', 'resumePages': pages, 'coverLetterEnabled': True}))
    return load_workspace_config(config)


def test_external_resolution_and_byte_exact_source(tmp_path):
    config = workspace(tmp_path)
    assert config.applications_root == tmp_path / 'private/applications'
    source = tmp_path / 'original.pdf'
    source.write_bytes(b'%PDF synthetic\r\n\x00\xff')
    receipt = capture_source_resume(source, config)
    assert Path(receipt['path']).read_bytes() == source.read_bytes()
    assert receipt['sha256'] == hashlib.sha256(source.read_bytes()).hexdigest()


def test_corrections_replace_original_authority(tmp_path):
    config = workspace(tmp_path)
    assert load_evidence(config) == {'scope': 'Managed three projects'}


def test_config_rejects_escape_symlink_versions_and_missing_evidence(tmp_path):
    config = workspace(tmp_path)
    path = config.workspace_root / 'materials.json'
    data = json.loads(path.read_text())
    for key, value in [('careerEvidencePath', '../outside.md'), ('schemaVersion', 2), ('resumePages', True), ('coverLetterEnabled', 'yes')]:
        bad = {**data, key: value}
        path.write_text(json.dumps(bad))
        with pytest.raises(ValueError): load_workspace_config(path)
    path.write_text(json.dumps(data))
    config.career_evidence_path.unlink()
    config.career_evidence_path.symlink_to(tmp_path / 'outside.md')
    with pytest.raises(ValueError): load_workspace_config(path)


def test_missing_font_blocks_and_unknown_family_never_falls_back():
    with pytest.raises(RuntimeError, match='font'): resolve_font_paths('Unavailable Synthetic Font')


def test_missing_dependencies_has_actionable_error(monkeypatch):
    from tools.materials import workspace as module
    monkeypatch.setattr(module.importlib.util, 'find_spec', lambda name: None if name == 'reportlab' else object())
    with pytest.raises(RuntimeError, match='reportlab.*requirements-macos-py312.lock'): module.check_dependencies()


def test_missing_font_files_block(monkeypatch):
    monkeypatch.setattr(Path, 'is_file', lambda self: False)
    with pytest.raises(RuntimeError, match='Missing Arial'): resolve_font_paths()


def test_unreconciled_prose_corrections_cannot_be_silently_dropped(tmp_path):
    config = workspace(tmp_path)
    with config.career_evidence_path.open('a') as stream: stream.write('\nCorrection: I managed two projects, not three.\n')
    with pytest.raises(ValueError, match='incorporate prose'): load_evidence(config)


def test_explicit_installed_licensed_fallback(monkeypatch, installed_liberation):
    installed = installed_liberation
    monkeypatch.setenv('MATERIALS_FONT_DIR', str(installed))
    regular, bold = resolve_font_paths('Liberation Sans')
    assert regular == installed/'LiberationSans-Regular.ttf'
    assert bold == installed/'LiberationSans-Bold.ttf'
    # Explicit fallback settings must not silently alter the default family.
    assert resolve_font_paths()[0].name == 'Arial.ttf'


def test_fallback_requires_explicit_installation_and_valid_license(tmp_path, monkeypatch, installed_liberation):
    import shutil
    monkeypatch.delenv('MATERIALS_FONT_DIR', raising=False)
    with pytest.raises(RuntimeError, match='explicitly selected'): resolve_font_paths('Liberation Sans')
    fonts = tmp_path/'fonts'
    fonts.mkdir()
    for filename in ('LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf', 'LICENSE_LIBERATION'):
        shutil.copyfile(installed_liberation/filename, fonts/filename)
    monkeypatch.setenv('MATERIALS_FONT_DIR', str(fonts))
    assert resolve_font_paths('Liberation Sans')[0] == fonts/'LiberationSans-Regular.ttf'
    (fonts/'LICENSE_LIBERATION').write_text('Unverified substitute license')
    with pytest.raises(RuntimeError, match='font/license'): resolve_font_paths('Liberation Sans')
