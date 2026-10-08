"""Find or reserve a private package by stable ledger job ID and vNNN version.

ID matches precede conservative company/title fallback for older packages.
CLI requires the selected private materials configuration; exit 3 means a
package already exists and should be reviewed before an explicit revision.
"""
import argparse
import json
import re
import sys
from pathlib import Path
import fcntl
from .workspace import load_workspace_config, package_root, private_path

# 1 is an unhandled error and 2 is argparse's usage error. 3 is "stop, but
# nothing failed", as for fetch-posting.ts and jobs_queue set-status.
EXIT_PACKAGE_EXISTS = 3

VERSION = re.compile(r"^v(\d{3})$")
# Legacy human-readable folders may carry a ticket/date prefix.
TICKET_PREFIX = re.compile(r"^[A-Za-z]+-[\d-]+_")
LEGACY_POSTING = Path("originals", "working", "legacy_workspace", "official_posting.json")

# Folder names spell these the short way. Longest phrase first.
PHRASES = [
    (("senior", "vice", "president"), "svp"),
    (("executive", "vice", "president"), "evp"),
    (("assistant", "vice", "president"), "avp"),
    (("vice", "president"), "vp"),
    (("go", "to", "market"), "gtm"),
    (("artificial", "intelligence"), "ai"),
]
ABBREVIATIONS = {"senior": "sr", "operations": "ops", "operation": "ops"}
STOPWORDS = {"a", "an", "and", "at", "for", "in", "of", "on", "the", "to", "with"}

# Folder titles may abbreviate a posting title. Measure overlap against
# the shorter title while retaining the threshold that separates roles
# with different substantive words.
TITLE_OVERLAP = 0.75
# Below this, a company name only matches exactly: "ey" is inside "keystone".
MIN_PARTIAL_COMPANY = 4


def _words(text):
    """Lowercase words, dropping in-word punctuation the way folder names do.

    "U.S." gives "us" and "R&D" gives "rd", as in Head_of_US_Policy and
    Chief_of_Staff_RD. Any other punctuation separates words.
    """
    return re.findall(r"[a-z0-9]+", re.sub(r"[.'’&]", "", text.lower()))


def _title_words(words):
    out = []
    i = 0
    while i < len(words):
        for phrase, short in PHRASES:
            if tuple(words[i:i + len(phrase)]) == phrase:
                out.append(short)
                i += len(phrase)
                break
        else:
            out.append(ABBREVIATIONS.get(words[i], words[i]))
            i += 1
    return {w for w in out if w not in STOPWORDS}


def _partial(shorter, longer):
    return len(shorter) >= MIN_PARTIAL_COMPANY and shorter in longer


def _company_length(words, company):
    """How many leading folder words name the company, or 0 if they do not.

    Board slugs may join words or differ from employer display names. Match
    conservatively using the supplied company name and leading folder words."""
    within = 0
    for k in range(1, len(words)):
        head = "".join(words[:k])
        if head == company or _partial(head, company):
            within = k
        else:
            break
    if within:
        return within
    for k in range(1, len(words)):
        if _partial(company, "".join(words[:k])):
            return k
    return 0


def _name_matches(folder_name, company, title):
    words = _words(TICKET_PREFIX.sub("", folder_name))
    k = _company_length(words, "".join(_words(company)))
    if not k:
        return False
    have, wanted = _title_words(words[k:]), _title_words(_words(title))
    if not have or not wanted:
        return False
    return len(have & wanted) / min(len(have), len(wanted)) >= TITLE_OVERLAP


def _posting_ids(folder):
    paths = sorted(folder.glob("v[0-9][0-9][0-9]/posting.json")) + [folder / LEGACY_POSTING]
    ids = []
    for path in paths:
        if not path.resolve().is_relative_to(folder.resolve()):
            raise ValueError(f"Posting path resolves outside the selected package: {path}")
        try:
            recorded = json.loads(path.read_text()).get("id")
        except (OSError, ValueError, AttributeError):
            # Missing or unreadable; the name check still covers the folder.
            continue
        if recorded:
            ids.append(str(recorded))
    return ids


def _same_posting(recorded, job_id):
    """D1 ids are ats:company:native; legacy folders kept the native id alone."""
    recorded, job_id = recorded.strip(), job_id.strip()
    return recorded == job_id or (":" not in recorded and job_id.endswith(":" + recorded))


def _versions(folder):
    versions = []
    for path in folder.iterdir():
        if VERSION.match(path.name) and path.is_dir():
            if not path.resolve().is_relative_to(folder.resolve()):
                raise ValueError(f'Version resolves outside the selected package: {path}')
            versions.append(path.name)
    return sorted(versions)


def find(apps, job_id, company, title):
    """Every matching package folder for this job, with exact ID matches first.

    Skip hidden or underscore-prefixed administrative directories."""
    apps = Path(apps)
    if not apps.is_dir():
        # An unmounted folder would otherwise report "no existing package".
        raise FileNotFoundError(
            f"applications folder {apps} not found; cannot confirm this job has no package"
        )
    by_id, by_name = [], []
    for folder in sorted(p for p in apps.iterdir() if p.is_dir() and p.name[0] not in "_."):
        if not folder.resolve().is_relative_to(apps.resolve()):
            raise ValueError(f"Package resolves outside the selected applications folder: {folder}")
        ids = _posting_ids(folder)
        if any(_same_posting(recorded, job_id) for recorded in ids):
            matched_on, bucket = "id", by_id
        elif not ids and _name_matches(folder.name, company, title):
            matched_on, bucket = "company_title", by_name
        else:
            continue
        versions = _versions(folder)
        latest = int(VERSION.match(versions[-1]).group(1)) if versions else 0
        bucket.append({
            "folder": folder.name,
            "matched_on": matched_on,
            "versions": versions,
            "next_version": f"v{latest + 1:03d}",
            "posting_ids": ids,
        })
    return by_id + by_name


def reserve_package(config, posting, new_version=False):
    """Idempotent preparation; only an explicit revision allocates a new version.

    Shared applications lock spans duplicate discovery, mkdir and manifests.
    Legacy/ambiguous associations require resolution before any allocation.
    """
    job_id = posting.get('id')
    root = package_root(config, job_id)
    apps = private_path(config.workspace_root, config.applications_root)
    apps.mkdir(parents=True, exist_ok=True, mode=0o700)
    # One lock covers discovery and allocation across all package folder names.
    lock = private_path(config.workspace_root, apps / '.package-reservation.lock')
    with lock.open('a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        matches = find(apps, job_id, posting.get('company', ''), posting.get('title', ''))
        if any(match['folder'] != root.name or match['matched_on'] != 'id' for match in matches):
            raise ValueError('An existing package was discovered; explicit resolution is required before reservation: ' + ', '.join(match['folder'] for match in matches))
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        versions = _versions(root)
        if versions and not new_version:
            latest = private_path(config.workspace_root, root / versions[-1])
            manifest_path = private_path(latest, latest / 'package.json')
            manifest = json.loads(manifest_path.read_text())
            if manifest.get('jobId') != job_id: raise ValueError('Existing package belongs to another job')
            return latest
        number = int(versions[-1][1:]) + 1 if versions else 1
        if number > 999: raise ValueError('Package version limit reached; review before allocation')
        version = f'v{number:03d}'
        destination = private_path(config.workspace_root, root / version)
        destination.mkdir(mode=0o700)
        (destination / 'posting.json').write_text(json.dumps(posting, indent=2) + '\n')
        (destination / 'package.json').write_text(json.dumps({'schemaVersion': 1, 'jobId': job_id, 'version': version, 'state': 'preparation_only'}) + '\n')
        return destination


def main():
    parser = argparse.ArgumentParser(description="Find this job's existing application package.")
    parser.add_argument("--id", required=True)
    parser.add_argument("--company", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--workspace-config", required=True, help="Private materials.json path")
    args = parser.parse_args()

    apps = load_workspace_config(Path(args.workspace_config)).applications_root
    matches = find(apps, args.id, args.company, args.title)
    print(json.dumps({"id": args.id, "matches": matches}, indent=2))
    if matches:
        sys.exit(EXIT_PACKAGE_EXISTS)


if __name__ == "__main__":
    main()
