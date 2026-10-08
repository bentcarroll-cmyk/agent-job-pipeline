"""Selected-instance D1 materials queue access, with guarded status writes.

Usage:
    python -m tools.materials.jobs_queue --instance-config /private/workspace/instance.json list
    python -m tools.materials.jobs_queue --instance-config /private/workspace/instance.json set-status --id ats:synthetic:1 --status materials_ready

Remote operations run only when explicitly invoked against a provisioned
instance and matching generated config; package rendering never invokes them.
"""
import argparse
import json
import subprocess
import sys
import os
import tomllib
from .workspace import private_path, load_workspace_config
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# Written only by this tool. 'materials' distinguishes these from 'manual'
# (a Slack button tap, or a row edited by hand) and 'pipeline' (an insert
# default). The source records which mechanism wrote the row, not who made
# the call: the candidate decides to apply or pass either way.
VALID_STATUSES = {"materials_ready", "posting_closed", "needs_materials",
                  "applied", "passed"}

# Slack decisions win over material preparation, including requeue attempts.
# Applied/pass transitions require separate explicit candidate instructions.
ALLOWED_FROM = {
    "needs_materials": ("not_applied", "needs_materials"),
    "materials_ready": ("needs_materials",),
    "posting_closed": ("needs_materials",),
    "applied": ("needs_materials", "materials_ready"),
    "passed": ("needs_materials", "materials_ready"),
}

# 1 is an unhandled error and 2 is argparse's usage error.
EXIT_STATUS_MOVED = 3


class StatusMovedError(Exception):
    """The job left the statuses this write may replace before it landed.

    Deliberately not a RuntimeError: nothing failed. The row holds the
    status the candidate set, and it should stay that way.
    """

    def __init__(self, job_id, status, current_status, source, updated_at,
                 allowed_from=("needs_materials",)):
        self.job_id = job_id
        self.status = status
        self.current_status = current_status
        expected = " or ".join(repr(s) for s in allowed_from)
        super().__init__(
            f"job {job_id!r} is already {current_status!r} (source {source!r}, "
            f"updated {updated_at}), not {expected}; {status!r} was NOT "
            "recorded and the row is unchanged."
        )


# Long enough for a local Wrangler start plus a remote round trip,
# short enough that a wrangler login prompt waiting on stdin fails the
# command instead of hanging the skill forever.
WRANGLER_TIMEOUT_SECONDS = 60


def _queue_target(instance_config_path):
    path = Path(instance_config_path).resolve()
    materials_path = next((parent / 'materials.json' for parent in path.parents
                          if (parent / 'materials.json').is_file()), None)
    if materials_path is None:
        raise ValueError('No selected private materials.json found above the instance; complete onboarding first')
    workspace = load_workspace_config(materials_path)
    if workspace.instance_config_path != path:
        raise ValueError('Instance path does not match the selected materials configuration')
    root = workspace.workspace_root
    instance = json.loads(path.read_text())
    if not isinstance(instance, dict): raise ValueError('Instance configuration must be a versioned object')
    if type(instance.get('schemaVersion')) is not int or instance['schemaVersion'] != 1:
        raise ValueError('Unsupported instance schemaVersion; use version 1')
    cloudflare = instance.get('cloudflare', {})
    if not isinstance(cloudflare, dict): raise ValueError('Invalid selected instance cloudflare configuration')
    database, database_id = cloudflare.get('databaseName'), cloudflare.get('databaseId')
    if not isinstance(database, str) or not database or not isinstance(database_id, str) or not database_id:
        raise ValueError('Materials queue requires a provisioned selected instance database')
    directory = private_path(root, '.setup/generated')
    operational = private_path(root, directory / 'wrangler.unbounded.operational.toml')
    config = operational if operational.is_file() else private_path(root, directory / 'wrangler.unbounded.toml')
    if not config.is_file(): raise ValueError('Missing selected workspace generated Wrangler configuration; complete setup preview first')
    parsed = tomllib.loads(config.read_text())
    matches = [binding for binding in parsed.get('d1_databases', []) if binding.get('binding') == 'DB']
    if len(matches) != 1 or matches[0].get('database_name') != database or matches[0].get('database_id') != database_id:
        raise ValueError('Generated configuration does not match the selected instance database; re-run setup')
    return root, config, database, cloudflare


def _run_wrangler(sql, instance_config_path):
    root, config, database, cloudflare = _queue_target(instance_config_path)
    # Preserve HOME while isolating tool caches. Wrangler currently prioritizes
    # legacy ~/.wrangler over XDG; refuse it rather than reading another account.
    ambient = Path.home() / '.wrangler'
    if ambient.exists() or ambient.is_symlink():
        raise ValueError('AMBIENT_WRANGLER_CONFIG_UNISOLATED: selected-workspace queue access is blocked')
    env = {key: value for key, value in os.environ.items() if key in ('PATH', 'HOME', 'CLOUDFLARE_API_TOKEN')}
    if cloudflare.get('accountId'): env['CLOUDFLARE_ACCOUNT_ID'] = cloudflare['accountId']
    for key, child in [('XDG_CONFIG_HOME', 'xdg'), ('XDG_CACHE_HOME', 'xdg-cache'), ('WRANGLER_CACHE_DIR', 'wrangler-cache'), ('WRANGLER_LOG_PATH', 'wrangler-logs'), ('TMPDIR', 'tmp')]:
        target = private_path(root, Path('.setup') / child)
        target.mkdir(parents=True, exist_ok=True, mode=0o700)
        env[key] = str(target)
    env.update({'WRANGLER_SEND_METRICS': 'false', 'WRANGLER_SEND_ERROR_REPORTS': 'false', 'CLOUDFLARE_AUTH_USE_KEYRING': 'false', 'CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV': 'false', 'CI': 'true', 'DO_NOT_TRACK': '1'})
    wrangler = private_path(root, '.setup/dependencies/node_modules/wrangler/bin/wrangler.js')
    if not wrangler.is_file():
        raise ValueError('Missing selected private Wrangler; complete the Node-core bootstrap in this workspace')
    try:
        result = subprocess.run(
            ["node", str(wrangler), "d1", "execute", database, "--remote", "--json",
             "--config", str(config), "--command", sql],
            capture_output=True, text=True, cwd=str(root), env=env, check=False,
            timeout=WRANGLER_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(
            f"wrangler timed out after {WRANGLER_TIMEOUT_SECONDS}s; the query was not "
            "confirmed, so do not assume it did or did not run. Check the row in D1 "
            "before retrying a status write."
        ) from e
    if result.returncode != 0:
        # With --json, wrangler writes its error to stdout and can leave
        # stderr empty, so report whichever stream actually said something.
        output = "; ".join(
            f"{name}: {text.strip()[:400]}"
            for name, text in (("stderr", result.stderr), ("stdout", result.stdout))
            if text.strip()
        )
        raise RuntimeError(
            f"wrangler failed (exit {result.returncode}): {output or 'no output'}"
        )
    return result.stdout


def _envelope(raw):
    """wrangler --json wraps each statement as [{results, success, meta}]."""
    try:
        payload = json.loads(raw)
        envelope = payload[0]
        if not isinstance(envelope, dict):
            raise TypeError(f"expected an object, got {type(envelope).__name__}")
        if envelope.get("success") is not True:
            raise RuntimeError("wrangler returned an unsuccessful statement; readiness was not confirmed")
        return envelope
    except (json.JSONDecodeError, KeyError, IndexError, TypeError) as e:
        exc_type = type(e).__name__
        raise RuntimeError(
            f"failed to parse wrangler response ({exc_type}): {raw.strip()[:400]}"
        ) from e


def _results(raw):
    envelope = _envelope(raw)
    try:
        return envelope["results"]
    except (KeyError, TypeError) as e:
        exc_type = type(e).__name__
        raise RuntimeError(
            f"failed to parse wrangler response ({exc_type}): {raw.strip()[:400]}"
        ) from e


def _changes(raw):
    """Rows the statement actually modified, from the envelope's meta block."""
    envelope = _envelope(raw)
    try:
        return int(envelope["meta"]["changes"])
    except (KeyError, TypeError, ValueError) as e:
        exc_type = type(e).__name__
        raise RuntimeError(
            f"failed to parse wrangler response ({exc_type}): "
            f"no meta.changes to confirm the update: {raw.strip()[:400]}"
        ) from e


def _quote(value):
    return value.replace("'", "''")


def list_needs_materials(instance_config_path):
    sql = (
        "SELECT id, company, title, url, location, match_lane, match_reason "
        "FROM jobs WHERE application_status = 'needs_materials' "
        "ORDER BY application_status_updated_at DESC"
    )
    return _results(_run_wrangler(sql, instance_config_path))


def _current_status(job_id, instance_config_path):
    rows = _results(_run_wrangler(
        "SELECT application_status, application_status_source, "
        f"application_status_updated_at FROM jobs WHERE id = '{_quote(job_id)}'", instance_config_path
    ))
    return rows[0] if rows else None


def set_status(job_id, status, instance_config_path):
    """Write a status and verify that the intended row actually changed.

    A successful UPDATE response can affect zero rows. Read back current
    state to distinguish a missing ID from a later candidate decision.

    materials_ready and posting_closed require needs_materials; applied and
    passed require needs_materials or materials_ready. A moved row raises
    StatusMovedError and preserves the candidate's newer state."""
    if status not in VALID_STATUSES:
        raise ValueError(f"unknown status {status!r}; expected one of {sorted(VALID_STATUSES)}")
    now = datetime.now(timezone.utc).isoformat()
    sql = (
        f"UPDATE jobs SET application_status = '{_quote(status)}', "
        f"application_status_source = 'materials', "
        f"application_status_updated_at = '{_quote(now)}' "
        f"WHERE id = '{_quote(job_id)}'"
    )
    allowed_from = ALLOWED_FROM.get(status)
    if allowed_from:
        sql += " AND application_status IN (" + ", ".join(
            f"'{_quote(s)}'" for s in allowed_from) + ")"
    changes = _changes(_run_wrangler(sql, instance_config_path))
    if changes == 0:
        current = _current_status(job_id, instance_config_path)
        if current is None:
            raise RuntimeError(
                f"no job row matched id {job_id!r}; status {status!r} was NOT recorded. "
                "Re-run the queue listing and check the id."
            )
        raise StatusMovedError(
            job_id, status,
            current["application_status"],
            current["application_status_source"],
            current["application_status_updated_at"],
            allowed_from or ("needs_materials",),
        )
    return changes


def main():
    parser = argparse.ArgumentParser(description="Materials queue access.")
    parser.add_argument("--instance-config", required=True, type=Path)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list")
    setter = sub.add_parser("set-status")
    setter.add_argument("--id", required=True)
    setter.add_argument("--status", required=True, choices=sorted(VALID_STATUSES))
    args = parser.parse_args()

    if args.command == "list":
        print(json.dumps(list_needs_materials(args.instance_config), indent=2))
    else:
        try:
            changes = set_status(args.id, args.status, args.instance_config)
        except StatusMovedError as e:
            print(e, file=sys.stderr)
            sys.exit(EXIT_STATUS_MOVED)
        print(json.dumps({"id": args.id, "status": args.status, "changes": changes}))


if __name__ == "__main__":
    main()
