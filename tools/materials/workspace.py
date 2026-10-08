"""Private material configuration and corrected evidence authority (schema version 1)."""
from dataclasses import dataclass
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re

RELEASE_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class WorkspaceConfig:
    workspace_root: Path
    career_evidence_path: Path
    writing_preferences_path: Path
    applications_root: Path
    instance_config_path: Path
    resume_pages: int
    cover_letter_enabled: bool


def private_path(root: Path, value: str | Path) -> Path:
    path = Path(value)
    path = (path if path.is_absolute() else root / path).resolve()
    if not path.is_relative_to(root) or path == root:
        raise ValueError(f'Path must resolve inside the selected private workspace: {value}')
    return path


def load_workspace_config(config_path: Path) -> WorkspaceConfig:
    path = Path(config_path).resolve()
    try:
        data = json.loads(path.read_text())
        if type(data['schemaVersion']) is not int or data['schemaVersion'] != 1:
            raise ValueError('Unsupported materials schemaVersion; use version 1')
        raw_root = Path(data['workspaceRoot'])
        if not raw_root.is_absolute():
            raise ValueError('workspaceRoot must be an absolute private workspace path')
        root = raw_root.resolve()
        for checkout in (RELEASE_ROOT, RELEASE_ROOT.parent / 'glm-agent-pipeline'):
            if root.is_relative_to(checkout) or checkout.is_relative_to(root):
                raise ValueError('Select a private workspace outside the source checkouts')
        private_path(root, path)
        if type(data['resumePages']) is not int or not 1 <= data['resumePages'] <= 10:
            raise ValueError('resumePages must be an integer from 1 to 10')
        if type(data['coverLetterEnabled']) is not bool:
            raise ValueError('coverLetterEnabled must be true or false')
        paths = [private_path(root, data[key]) for key in ('careerEvidencePath', 'writingPreferencesPath', 'applicationsRoot', 'instanceConfigPath')]
        for required in (paths[0], paths[1], paths[3]):
            if not required.is_file():
                raise ValueError(f'Missing private input {required}; complete onboarding first')
        return WorkspaceConfig(root, *paths, data['resumePages'], data['coverLetterEnabled'])
    except (KeyError, TypeError, json.JSONDecodeError) as error:
        raise ValueError(f'{path}: invalid materials configuration; use the onboard schemaVersion 1 template') from error


def check_dependencies() -> None:
    missing = [name for name in ('reportlab', 'pdfplumber', 'pypdf') if importlib.util.find_spec(name) is None]
    if missing:
        raise RuntimeError('Missing PDF dependencies: ' + ', '.join(missing) + '; install tools/materials/requirements-macos-py312.lock in the selected workspace Python environment')


# Verified unmodified Mozilla PDF.js distribution of Liberation Sans (OFL1.1).
# Font and accompanying license bytes must match this reviewed distribution;
# unsupported installations need explicit verification, never silent substitution.
LIBERATION_SHA256 = {
    'LiberationSans-Regular.ttf': 'f8ace1f892b2bd9dc1792ba7f097fa7588f84fed48321480e04de5390828221f',
    'LiberationSans-Bold.ttf': '361c61b82d575c5c35fd9157fda8b0194bcfcd0d88ea8521a4fb5dd53d33dddc',
    'LICENSE_LIBERATION': '93fed46019c38bbe566b479d22148e2e8a1e85ada614accb0211c37b2c61c19b',
}


def resolve_font_paths(preferred_family: str | None = None) -> tuple[Path, Path]:
    if preferred_family == 'Liberation Sans':
        selected = os.environ.get('MATERIALS_FONT_DIR')
        if not selected or not Path(selected).is_absolute():
            raise RuntimeError('Liberation Sans requires an explicitly selected absolute MATERIALS_FONT_DIR containing the reviewed fonts and LICENSE_LIBERATION')
        directory = Path(selected).resolve()
        for filename, expected in LIBERATION_SHA256.items():
            path = directory / filename
            if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                raise RuntimeError(f'Unverified Liberation Sans font/license file {filename}; install the reviewed unmodified Mozilla PDF.js font distribution with its OFL license')
        return directory / 'LiberationSans-Regular.ttf', directory / 'LiberationSans-Bold.ttf'
    if preferred_family not in (None, 'Arial'):
        raise RuntimeError(f'Unavailable reviewed font family {preferred_family!r}; explicitly select Arial or verified installed Liberation Sans')
    paths = (Path('/System/Library/Fonts/Supplemental/Arial.ttf'), Path('/System/Library/Fonts/Supplemental/Arial Bold.ttf'))
    if not all(path.is_file() for path in paths):
        raise RuntimeError('Missing Arial regular/bold font files; completion is blocked. Explicitly select a verified licensed fallback and repeat document reviews')
    return paths


def load_evidence(config: WorkspaceConfig) -> dict[str, str]:
    """Read an assistant-maintained digest; explicit correction IDs replace originals.

    Free prose must be reconciled by the interview before this machine gate, never
    ignored while generating a package. The byte-exact original stays separate.
    """
    path = private_path(config.workspace_root, config.career_evidence_path)
    text = path.read_text()
    blocks = re.findall(r'```json\s*\n(.*?)\n```', text, flags=re.S)
    remainder = re.sub(r'```json\s*\n.*?\n```', '', text, flags=re.S)
    if len(blocks) != 1 or any(line.strip() and not line.startswith('#') for line in remainder.splitlines()):
        raise ValueError('Career evidence needs a reconciled version 1 JSON digest; incorporate prose notes and explicit corrections through onboarding before preparation')
    data = json.loads(blocks[0])
    if not isinstance(data, dict) or set(data) - {'schemaVersion', 'facts', 'corrections'}:
        raise ValueError('Evidence must contain only schemaVersion, facts and corrections; reconcile other notes before preparation')
    if data.get('schemaVersion') != 1 or type(data.get('schemaVersion')) is not int:
        raise ValueError('Unsupported career evidence schemaVersion; reconcile to version 1')
    facts = {}
    for section in ('facts', 'corrections'):
        rows = data.get(section, [])
        if not isinstance(rows, list): raise ValueError(f'Evidence {section} must be a list')
        seen = set()
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get('id'), str) or not row['id'].strip() or not isinstance(row.get('text'), str) or not row['text'].strip() or row['id'] in seen:
                raise ValueError(f'Invalid or duplicate evidence ID in {section}')
            if section == 'corrections' and row['id'] not in facts:
                raise ValueError(f'Correction targets unknown fact {row["id"]!r}; reconcile the evidence')
            seen.add(row['id'])
            facts[row['id']] = row['text']
    if not facts: raise ValueError('Career evidence is empty; interview the candidate before preparation')
    return facts


def package_root(config: WorkspaceConfig, job_id: str) -> Path:
    if not isinstance(job_id, str) or not job_id.strip() or job_id != job_id.strip():
        raise ValueError('A nonempty exact stable job ID is required')
    slug = re.sub(r'[^a-zA-Z0-9_-]', '-', job_id)[:48].strip('-') or 'job'
    digest = hashlib.sha256(job_id.encode()).hexdigest()
    return private_path(config.workspace_root, config.applications_root / f'{slug}-{digest}')


def capture_source_resume(source: Path, config: WorkspaceConfig) -> dict[str, str]:
    data = Path(source).read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    destination = private_path(config.workspace_root, Path('originals') / f'{digest}{Path(source).suffix}')
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        with destination.open('xb') as stream:
            stream.write(data)
        destination.chmod(0o600)
    except FileExistsError:
        if destination.read_bytes() != data: raise ValueError('Stored source hash path has different bytes; stop and review')
    return {'path': str(destination), 'sha256': digest}
