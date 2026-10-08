import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
import pytest
from tools.materials import existing_package, jobs_queue
from tools.materials.workspace import package_root
from test_workspace import workspace


def test_repeat_preparation_retains_association_and_explicit_revision(tmp_path):
    config = workspace(tmp_path)
    posting = {'id': 'lever:synthetic:job-1', 'company': 'Synthetic Works', 'title': 'Operations Lead'}
    first = existing_package.reserve_package(config, posting)
    assert existing_package.reserve_package(config, posting) == first
    second = existing_package.reserve_package(config, posting, new_version=True)
    assert first.name == 'v001' and second.name == 'v002'
    assert first.parent == package_root(config, posting['id'])
    assert existing_package.find(config.applications_root, posting['id'], posting['company'], posting['title'])[0]['next_version'] == 'v003'
    assert json.loads((first / 'package.json').read_text()) == {'schemaVersion': 1, 'jobId': posting['id'], 'version': 'v001', 'state': 'preparation_only'}


def test_concurrent_revisions_are_unique(tmp_path):
    config = workspace(tmp_path)
    posting = {'id': 'ats:synthetic:2', 'company': 'Synthetic', 'title': 'Engineer'}
    with ThreadPoolExecutor(max_workers=4) as pool:
        paths = list(pool.map(lambda _: existing_package.reserve_package(config, posting, new_version=True), range(4)))
    assert {p.name for p in paths} == {'v001', 'v002', 'v003', 'v004'}


def test_applied_during_generation_cannot_be_replaced_or_assert_submission(tmp_path, monkeypatch):
    config = workspace(tmp_path)
    db = sqlite3.connect(':memory:')
    db.execute('CREATE TABLE jobs(id TEXT,application_status TEXT,application_status_source TEXT,application_status_updated_at TEXT)')
    db.execute("INSERT INTO jobs VALUES('ats:synthetic:2','needs_materials','slack','before')")
    existing_package.reserve_package(config, {'id': 'ats:synthetic:2', 'company': 'Synthetic', 'title': 'Engineer'})
    db.execute("UPDATE jobs SET application_status='applied',application_status_source='slack',application_status_updated_at='user-confirmed'")
    statements = []
    def run(sql, instance_config_path):
        assert instance_config_path == config.instance_config_path
        statements.append(sql)
        cursor = db.execute(sql)
        rows = [dict(zip([d[0] for d in cursor.description], row)) for row in cursor.fetchall()] if cursor.description else []
        return json.dumps([{'results': rows, 'success': True, 'meta': {'changes': db.execute('SELECT changes()').fetchone()[0]}}])
    monkeypatch.setattr(jobs_queue, '_run_wrangler', run)
    with pytest.raises(jobs_queue.StatusMovedError):
        jobs_queue.set_status('ats:synthetic:2', 'materials_ready', config.instance_config_path)
    assert db.execute('SELECT application_status,application_status_updated_at FROM jobs').fetchone() == ('applied', 'user-confirmed')
    assert all('submitted_at' not in sql and 'file_version' not in sql for sql in statements)


def test_queue_targets_selected_database_and_rejects_wrong_binding(tmp_path, monkeypatch):
    config = workspace(tmp_path)
    generated = config.workspace_root / '.setup/generated'
    generated.mkdir(parents=True)
    toml = generated / 'wrangler.unbounded.toml'
    toml.write_text('[[d1_databases]]\nbinding="DB"\ndatabase_name="synthetic-db"\ndatabase_id="synthetic-id"\n')
    selected = config.workspace_root / '.setup/dependencies/node_modules/wrangler/bin/wrangler.js'
    selected.parent.mkdir(parents=True)
    selected.write_text('// synthetic intercepted executable')
    # The clean release has no checkout node_modules; only private bootstrap dependencies exist.
    monkeypatch.setattr(jobs_queue, 'REPO_ROOT', tmp_path / 'clean-release-without-dependencies')
    invocations = []
    def run(args, **kwargs):
        invocations.append((args, kwargs))
        return type('Result', (), {'returncode': 0, 'stdout': '[{"results": [],"success":true}]', 'stderr': ''})()
    monkeypatch.setattr(jobs_queue.subprocess, 'run', run)
    assert jobs_queue.list_needs_materials(config.instance_config_path) == []
    args, kw = invocations[0]
    assert args[1] == str(selected)
    assert 'synthetic-db' in args and str(toml) in args
    assert kw['env']['HOME'] == jobs_queue.os.environ['HOME']
    assert kw['timeout'] == jobs_queue.WRANGLER_TIMEOUT_SECONDS
    assert kw['cwd'] == str(config.workspace_root)
    toml.write_text('[[d1_databases]]\nbinding="DB"\ndatabase_name="wrong"\ndatabase_id="wrong"\n')
    with pytest.raises(ValueError): jobs_queue.list_needs_materials(config.instance_config_path)
    assert len(invocations) == 1


def test_provider_failure_envelope_never_reports_readiness_success():
    failed = json.dumps([{'success': False, 'results': [], 'meta': {'changes': 1}, 'errors': [{'message': 'synthetic rejection'}]}])
    with pytest.raises(RuntimeError, match='unsuccessful'): jobs_queue._changes(failed)


def test_conflicting_recorded_id_never_falls_back_to_company_title(tmp_path):
    folder = tmp_path / 'Synthetic_Company_Engineering_Lead/v001'
    folder.mkdir(parents=True)
    (folder / 'posting.json').write_text(json.dumps({'id': 'ats:synthetic:different-job'}))
    assert existing_package.find(tmp_path, 'ats:synthetic:requested-job', 'Synthetic Company', 'Engineering Lead') == []


def test_nested_selected_instance_resolves_own_workspace_configuration(tmp_path):
    config = workspace(tmp_path)
    generated = config.workspace_root / '.setup/generated'
    generated.mkdir(parents=True)
    (generated / 'wrangler.unbounded.toml').write_text('[[d1_databases]]\nbinding="DB"\ndatabase_name="synthetic-db"\ndatabase_id="synthetic-id"\n')
    nested = config.workspace_root / 'config/instance.json'
    nested.parent.mkdir()
    nested.write_bytes(config.instance_config_path.read_bytes())
    data = json.loads((config.workspace_root/'materials.json').read_text())
    data['instanceConfigPath'] = 'config/instance.json'
    (config.workspace_root/'materials.json').write_text(json.dumps(data))
    root, _, database, _ = jobs_queue._queue_target(nested)
    assert root == config.workspace_root and database == 'synthetic-db'


def test_repeat_does_not_overwrite_approved_manifest(tmp_path):
    config = workspace(tmp_path)
    posting = {'id':'synthetic:one', 'company':'Synthetic', 'title':'Lead'}
    package = existing_package.reserve_package(config, posting)
    manifest = package/'package.json'
    approved = {'schemaVersion':1, 'jobId':posting['id'], 'version':'v001', 'state':'approved', 'reviewReceipt':'synthetic-receipt'}
    manifest.write_text(json.dumps(approved))
    assert existing_package.reserve_package(config, posting) == package
    assert json.loads(manifest.read_text()) == approved


def test_opaque_job_id_case_is_not_a_duplicate(tmp_path):
    folder = tmp_path/'Synthetic_Engineer/v001'
    folder.mkdir(parents=True)
    (folder/'posting.json').write_text(json.dumps({'id':'ats:synthetic:AbC'}))
    assert existing_package.find(tmp_path, 'ats:synthetic:abc', 'Synthetic', 'Engineer') == []


def test_package_discovery_rejects_links_outside_selected_applications(tmp_path):
    apps, outside = tmp_path/'apps', tmp_path/'outside'
    apps.mkdir()
    (outside/'v001').mkdir(parents=True)
    (outside/'v001/posting.json').write_text(json.dumps({'id':'synthetic:one'}))
    (apps/'Synthetic').symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match='outside'): existing_package.find(apps, 'synthetic:one', 'Synthetic', 'Lead')


@pytest.mark.parametrize('new_version', [False, True])
def test_reservation_blocks_exact_id_legacy_duplicate(tmp_path, new_version):
    config = workspace(tmp_path)
    posting = {'id':'synthetic:legacy:one', 'company':'Synthetic Company', 'title':'Operations Lead'}
    legacy = config.applications_root/'Synthetic_Company_Operations_Lead/v001'
    legacy.mkdir(parents=True)
    (legacy/'posting.json').write_text(json.dumps(posting))
    assert existing_package.find(config.applications_root, posting['id'], posting['company'], posting['title'])
    with pytest.raises(ValueError, match='existing package.*explicit resolution'):
        existing_package.reserve_package(config, posting, new_version=new_version)
    assert not package_root(config, posting['id']).exists()


def test_repeated_reservation_refuses_manifest_leaf_escape(tmp_path):
    config = workspace(tmp_path)
    posting = {'id':'synthetic:one', 'company':'Synthetic', 'title':'Lead'}
    package = existing_package.reserve_package(config, posting)
    external = tmp_path/'manifest.json'
    external.write_bytes((package/'package.json').read_bytes())
    (package/'package.json').unlink()
    (package/'package.json').symlink_to(external)
    with pytest.raises(ValueError, match='inside'):
        existing_package.reserve_package(config, posting)


def test_name_only_duplicate_requires_resolution_under_reservation(tmp_path):
    config = workspace(tmp_path)
    posting = {'id':'synthetic:legacy:one', 'company':'Synthetic Company', 'title':'Operations Lead'}
    (config.applications_root/'Synthetic_Company_Operations_Lead/v001').mkdir(parents=True)
    with pytest.raises(ValueError, match='explicit resolution'): existing_package.reserve_package(config, posting)
    assert not package_root(config, posting['id']).exists()
