import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, realpath, readdir, lstat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { packageRelease } from './package-release';
import { verifyRelease } from './verify-release';
import { sha256, untar, validateFiles, safePath } from './release-format';
import { scanPublicHistory, scanPublicTree } from './privacy-scan';
export const REQUIRED_CHECKS = ['local-verification', 'materials-and-visual-review', 'codex-installation', 'claude-installation', 'bounded-live-discovery', 'signed-slack-callbacks', 'gmail-readonly-recovery', 'test-resource-cleanup', 'hosted-ci'] as const;
type CheckName = typeof REQUIRED_CHECKS[number];
type Check = {
    name: CheckName;
    status: 'passed' | 'pending' | 'failed';
    candidateSha: string;
    evidenceSha256: string | null;
};
export type Candidate = {
    schemaVersion: 1;
    channel: 'stable' | 'beta';
    version: 'v0.1.0' | 'v0.1.0-beta.1';
    repository: 'bentcarroll-cmyk/agent-job-pipeline';
    candidateSha: string;
    rootSha: string;
    lineageSha256: string;
    parentReceiptSha256: string | null;
    treeSha: string;
    manifestSha256: string;
    archiveSha256: string;
    installationResultsSha256: string;
    releaseNotesSha256: string;
    licenseSha256: string;
    platforms: [
        'macos-arm64'
    ];
    checks: Check[];
};
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
function fail(code: string): never { throw new Error(code); }
const hex = (value: unknown, length: number) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
function validateChecks(checks: unknown, sha: string): asserts checks is Check[] {
    if (!Array.isArray(checks) || checks.length !== REQUIRED_CHECKS.length || new Set(checks.map(c => c?.name)).size !== REQUIRED_CHECKS.length)
        fail('CHECK_EVIDENCE_INVALID');
    for (const name of REQUIRED_CHECKS) {
        const c = checks.find(c => c?.name === name);
        if (!c || !['passed', 'pending', 'failed'].includes(c.status) || c.candidateSha !== sha || (c.status === 'passed' ? !hex(c.evidenceSha256, 64) : c.evidenceSha256 !== null && !hex(c.evidenceSha256, 64)))
            fail('CHECK_EVIDENCE_INVALID');
    }
}
const RELEASE_VERSIONS = { stable: 'v0.1.0', beta: 'v0.1.0-beta.1' } as const;
const BETA_REQUIRED_CHECKS: readonly CheckName[] = ['local-verification', 'materials-and-visual-review', 'hosted-ci'];
function releaseVersion(channel: unknown): Candidate['version'] {
    if (channel !== 'stable' && channel !== 'beta') fail('RELEASE_CHANNEL_INVALID');
    return RELEASE_VERSIONS[channel];
}
function assertPackageVersion(root: string, version: string, commit = 'HEAD'): void {
    let value: unknown;
    try { value = JSON.parse(git(root, 'show', `${commit}:package.json`)).version; }
    catch { fail('RELEASE_CHANNEL_VERSION_MISMATCH'); }
    if (value !== version.slice(1)) fail('RELEASE_CHANNEL_VERSION_MISMATCH');
}
async function inspectRoot(root: string) {
    if (git(root, 'status', '--porcelain', '--untracked-files=all'))
        fail('CANDIDATE_DIRTY');
    const lineage = git(root, 'rev-list', '--reverse', '--parents', 'HEAD').split('\n').map(line => line.split(' '));
    const refs = git(root, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').map(line => line.split(' '));
    if (git(root, 'rev-parse', '--is-shallow-repository') !== 'false' || refs.some(([name, sha]) => !['refs/heads/main', 'refs/remotes/origin/main'].includes(name) || !lineage.some(([commit]) => commit === sha)) ||
        git(root, 'rev-list', '--all', '--count') !== String(lineage.length) ||
        lineage.some((entry, i) => i === 0 ? entry.length !== 1 : entry.length !== 2 || entry[1] !== lineage[i - 1][0]))
        fail('PUBLIC_LINEAGE_INVALID');
    // Each historical tree must obey its OWN explicit manifest. Never execute historical code.
    for (const [commit] of lineage) {
        let files: unknown;
        try { const manifest = JSON.parse(git(root, 'show', `${commit}:.release/public-manifest.json`));
            if (manifest.schemaVersion !== 1) fail('MANIFEST_TREE_MISMATCH'); files = manifest.files;
        } catch { fail('MANIFEST_TREE_MISMATCH'); }
        if (!Array.isArray(files) || !files.includes('.release/public-manifest.json') || !files.every(p => typeof p === 'string' && safePath(p)) || new Set(files.map(p => p.toLowerCase())).size !== files.length)
            fail('MANIFEST_TREE_MISMATCH');
        const entries = git(root, 'ls-tree', '-r', '-z', commit).split('\0').filter(Boolean).map(record => record.split('\t'));
        if (entries.some(([header]) => !/^100(?:644|755) blob [a-f0-9]{40}$/.test(header)) ||
            JSON.stringify(entries.map(([, path]) => path).sort()) !== JSON.stringify([...files].sort())) fail('MANIFEST_TREE_MISMATCH');
    }
    if (git(root, 'symbolic-ref', '--short', 'HEAD') !== 'main')
        fail('CANDIDATE_BRANCH_INVALID');
    const raw = await readFile(join(root, '.release/public-manifest.json'));
    const manifest = JSON.parse(raw.toString());
    validateFiles(manifest.files);
    const actual = git(root, 'ls-files', '-z').split('\0').filter(Boolean).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...manifest.files].sort()))
        fail('MANIFEST_TREE_MISMATCH');
    if ((await scanPublicTree(root)).length || (await scanPublicHistory(root)).length)
        fail('PRIVACY_VERIFICATION_FAILED');
    return { rootSha: lineage[0][0], lineageSha256: sha256(JSON.stringify(lineage.map(([sha]) => sha))), candidateSha: git(root, 'rev-parse', 'HEAD'), treeSha: git(root, 'rev-parse', 'HEAD^{tree}'), manifestSha256: sha256(raw) };
}
export async function prepare(args: {
    root: string;
    output: string;
    evidence: string;
    channel?: 'stable' | 'beta';
    predecessor?: { receiptPath: string; approval: string };
}): Promise<Candidate> {
    const root = await realpath(args.root), output = join(await realpath(dirname(resolve(args.output))), basename(args.output));
    const rel = relative(root, output);
    if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)))
        fail('OUTPUT_MUST_BE_EXTERNAL');
    const state = await inspectRoot(root);
    const channel = args.channel ?? 'stable';
    const version = releaseVersion(channel);
    assertPackageVersion(root, version);
    let parentReceiptSha256: string | null = null;
    if (state.candidateSha !== state.rootSha) {
        if (!args.predecessor) fail('PREDECESSOR_REVIEW_REQUIRED');
        const bytes = await readFile(args.predecessor.receiptPath);
        const previous: Candidate = JSON.parse(bytes.toString());
        const review = JSON.parse(await readFile(args.predecessor.approval, 'utf8'));
        if (review.schemaVersion !== 1 || review.approved !== true || review.candidateReceiptSha256 !== sha256(bytes) || !Number.isFinite(Date.parse(review.reviewedAt))) fail('CANDIDATE_REVIEW_STALE');
        const parent = git(root, 'rev-parse', 'HEAD^');
        const ancestors = git(root, 'rev-list', '--reverse', parent).split('\n');
        const tracked = git(root, 'for-each-ref', '--format=%(objectname)', 'refs/remotes/origin/main');
        if (tracked && tracked !== parent && tracked !== state.candidateSha) fail('PREDECESSOR_BINDING_INVALID');
        if (previous.channel !== channel || previous.version !== version || previous.schemaVersion !== 1 || previous.repository !== 'bentcarroll-cmyk/agent-job-pipeline' || previous.candidateSha !== parent || previous.rootSha !== state.rootSha || previous.lineageSha256 !== sha256(JSON.stringify(ancestors)) || previous.treeSha !== git(root, 'rev-parse', `${parent}^{tree}`) || previous.manifestSha256 !== sha256(execFileSync('git', ['-C', root, 'show', `${parent}:.release/public-manifest.json`]))) fail('PREDECESSOR_BINDING_INVALID');
        assertPackageVersion(root, previous.version, parent);
        parentReceiptSha256 = sha256(bytes);
    } else if (args.predecessor) fail('PREDECESSOR_BINDING_INVALID');
    const evidence = JSON.parse(await readFile(args.evidence, 'utf8'));
    if (evidence.schemaVersion !== 1)
        fail('CHECK_EVIDENCE_INVALID');
    validateChecks(evidence.checks, state.candidateSha);
    await mkdir(output, { recursive: true, mode: 0o700 });
    if ((await lstat(output)).isSymbolicLink() || (await readdir(output)).length)
        fail('OUTPUT_MUST_BE_FRESH');
    const archive = await packageRelease(root, join(root, '.release/public-manifest.json'), output);
    if (!(await verifyRelease(archive.archive)).passed)
        fail('ARCHIVE_VERIFICATION_FAILED');
    const hash = async (p: string) => sha256(await readFile(join(root, p)));
    const candidate: Candidate = { schemaVersion: 1, channel, version, repository: 'bentcarroll-cmyk/agent-job-pipeline', ...state, parentReceiptSha256, archiveSha256: archive.sha256, installationResultsSha256: await hash('docs/installation-results.md'), releaseNotesSha256: await hash('docs/release-notes.md'), licenseSha256: await hash('LICENSE'), platforms: ['macos-arm64'], checks: evidence.checks };
    await writeFile(join(output, 'candidate.json'), JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return candidate;
}
export async function assertPublishable(args: {
    root: string;
    receiptPath: string;
    approval: string;
}): Promise<Candidate> {
    const bytes = await readFile(args.receiptPath);
    const c: Candidate = JSON.parse(bytes.toString());
    const approval = JSON.parse(await readFile(args.approval, 'utf8'));
    if (approval.schemaVersion !== 1 || approval.approved !== true || approval.candidateReceiptSha256 !== sha256(bytes) || !Number.isFinite(Date.parse(approval.reviewedAt)))
        fail('CANDIDATE_REVIEW_STALE');
    if (c.schemaVersion !== 1 || !['stable', 'beta'].includes(c.channel) || c.version !== RELEASE_VERSIONS[c.channel] || c.repository !== 'bentcarroll-cmyk/agent-job-pipeline' || !hex(c.candidateSha, 40) || JSON.stringify(c.platforms) !== JSON.stringify(['macos-arm64']))
        fail('CANDIDATE_RECEIPT_INVALID');
    if (git(args.root, 'rev-parse', 'HEAD') !== c.candidateSha)
        fail('CANDIDATE_MOVED');
    assertPackageVersion(args.root, c.version);
    validateChecks(c.checks, c.candidateSha);
    const required = c.channel === 'beta' ? BETA_REQUIRED_CHECKS : REQUIRED_CHECKS;
    if (c.checks.some(check => check.status === 'failed' || (required.includes(check.name) && check.status !== 'passed')))
        fail('REQUIRED_CHECK_NOT_PASSED');
    const state = await inspectRoot(args.root);
    const archive = join(resolve(args.receiptPath, '..'), 'agent-job-pipeline.tar.gz');
    if (!(await verifyRelease(archive)).passed)
        fail('ARCHIVE_VERIFICATION_FAILED');
    const raw = await readFile(archive);
    if (state.rootSha !== c.rootSha || state.lineageSha256 !== c.lineageSha256 || (state.rootSha === state.candidateSha ? c.parentReceiptSha256 !== null : !hex(c.parentReceiptSha256, 64)) || state.treeSha !== c.treeSha || state.manifestSha256 !== c.manifestSha256 || sha256(raw) !== c.archiveSha256)
        fail('CANDIDATE_CONTENT_MISMATCH');
    const files = untar(gunzipSync(raw));
    for (const [path, bytes] of files) {
        if (path === 'RELEASE-METADATA.json')
            continue;
        const committed = execFileSync('git', ['-C', args.root, 'show', `${c.candidateSha}:${path}`], { maxBuffer: 64 * 1024 * 1024 });
        if (bytes.length !== committed.length || !bytes.every((byte, index) => byte === committed[index]))
            fail('ARCHIVE_TREE_MISMATCH');
    }
    for (const [path, hash] of [['LICENSE', c.licenseSha256], ['docs/installation-results.md', c.installationResultsSha256], ['docs/release-notes.md', c.releaseNotesSha256]])
        if (sha256(files.get(path)!) !== hash)
            fail('CANDIDATE_CONTENT_MISMATCH');
    return c;
}
/** The caller supplies GitHub's observed checks, never local success guesses. */
export function validateHostedChecks(value: unknown, sha: string): void {
    const payload = value as {
        check_runs?: {
            name: string;
            head_sha: string;
            status: string;
            conclusion: string | null;
            app?: {
                slug: string;
            };
        }[];
        total_count?: number;
    };
    const checks = payload?.check_runs;
    if (!Array.isArray(checks) || payload.total_count !== checks.length || !checks.length)
        fail('HOSTED_CHECKS_PENDING');
    const required = checks.filter(c => c.name === 'macos-local-runtime' && c.app?.slug === 'github-actions');
    if (!required.length || checks.some(c => c.head_sha !== sha || c.status !== 'completed' || c.conclusion !== 'success'))
        fail('HOSTED_CHECKS_NOT_PASSED');
}
const gh = (...args: string[]) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
const api = (path: string) => JSON.parse(gh('api', path));
export async function publish(args: {
    root: string;
    receiptPath: string;
    approval: string;
}): Promise<{
    url: string;
    candidateSha: string;
    archiveSha256: string;
}> {
    const c = await assertPublishable(args);
    const repo = c.repository;
    const base = `repos/${repo}`;
    const remote = api(base);
    // Staging is separate and controller-reviewed. Never create/adopt/push a development checkout here.
    if (remote.full_name !== repo || remote.private !== true || remote.default_branch !== 'main')
        fail('PRIVATE_STAGING_REQUIRED');
    let tagCreated = false;
    const verifyRemote = () => {
        const refs = api(`${base}/git/matching-refs/`);
        const expected = tagCreated ? ['refs/heads/main', `refs/tags/${c.version}`] : ['refs/heads/main'];
        if (!Array.isArray(refs) || refs.length !== expected.length || new Set(refs.map(r => r.ref)).size !== expected.length || refs.some(r => !expected.includes(r.ref) || r.object?.type !== 'commit' || r.object.sha !== c.candidateSha))
            fail('REMOTE_REFS_UNREVIEWED');
        if (api(`${base}/git/ref/heads/main`).object.sha !== c.candidateSha)
            fail('REMOTE_CANDIDATE_MOVED');
        validateHostedChecks(api(`${base}/commits/${c.candidateSha}/check-runs?per_page=100&filter=latest`), c.candidateSha);
    };
    const releaseInventory = () => api(`${base}/releases?per_page=100`);
    const requireEmptyReleases = () => {
        const releases = releaseInventory();
        if (!Array.isArray(releases) || releases.length !== 0)
            fail('REMOTE_RELEASE_INVENTORY_UNREVIEWED');
    };
    verifyRemote();
    requireEmptyReleases();
    // Recheck local bindings and all inventory immediately before the first remote mutation.
    await assertPublishable(args);
    verifyRemote();
    requireEmptyReleases();
    const archive = join(resolve(args.receiptPath, '..'), 'agent-job-pipeline.tar.gz');
    const expectedAssets = [
        { name: 'agent-job-pipeline.tar.gz', bytes: await readFile(archive) },
        { name: 'agent-job-pipeline.tar.gz.sha256', bytes: await readFile(archive + '.sha256') },
    ];
    const releaseNotes = await readFile(join(args.root, 'docs/release-notes.md'), 'utf8');
    const prerelease = c.channel === 'beta';
    const hasExpectedMetadata = (r: { tag_name: string; name: string; body: string; prerelease: boolean }) => r.tag_name === c.version && r.name === c.version && r.body === releaseNotes && r.prerelease === prerelease;
    gh('api', `${base}/git/refs`, '--method', 'POST', '-f', `ref=refs/tags/${c.version}`, '-f', `sha=${c.candidateSha}`);
    tagCreated = true;
    // Bind the identity returned by creation; never adopt a release found later by tag/name.
    const created = JSON.parse(gh('api', `${base}/releases`, '--method', 'POST', '-f', `tag_name=${c.version}`, '-f', `name=${c.version}`, '-F', 'draft=true', '-F', `prerelease=${prerelease}`, '-f', `make_latest=${prerelease ? 'false' : 'true'}`, '-F', `body=@${join(args.root, 'docs/release-notes.md')}`));
    if (!Number.isSafeInteger(created.id) || created.id <= 0 || !hasExpectedMetadata(created) || created.draft !== true)
        fail('REMOTE_RELEASE_INVENTORY_UNREVIEWED');
    const releaseId: number = created.id;
    gh('release', 'upload', c.version, '--repo', repo, archive, archive + '.sha256');
    let assetIds: readonly number[] | undefined;
    const verifyInventory = (draft: boolean) => {
        // With exactly one release and two assets, a full first page is sufficient:
        // any additional inventory (including a release without a Git tag) fails closed.
        const releases = releaseInventory();
        if (!Array.isArray(releases) || releases.length !== 1 || releases[0].id !== releaseId || !hasExpectedMetadata(releases[0]) || releases[0].draft !== draft)
            fail('REMOTE_RELEASE_INVENTORY_UNREVIEWED');
        const release = releases[0];
        const assets = api(`${base}/releases/${releaseId}/assets?per_page=100`);
        const validateAssets = (items: { name: string; id: number }[]) => {
            if (!Array.isArray(items) || items.length !== expectedAssets.length || new Set(items.map(a => a.id)).size !== expectedAssets.length || new Set(items.map(a => a.name)).size !== expectedAssets.length || items.some(a => !Number.isSafeInteger(a.id) || a.id <= 0 || !expectedAssets.some(e => e.name === a.name)))
                fail('REMOTE_ASSET_INVENTORY_UNREVIEWED');
            return expectedAssets.map(e => items.find(a => a.name === e.name)!.id);
        };
        const ids = validateAssets(assets);
        const listedIds = validateAssets(release.assets);
        if (ids.some((id, i) => id !== listedIds[i] || (assetIds !== undefined && id !== assetIds[i])))
            fail('REMOTE_ASSET_INVENTORY_UNREVIEWED');
        if (!assetIds) assetIds = Object.freeze(ids);
        for (const [i, expected] of expectedAssets.entries()) {
            const bytes = execFileSync('gh', ['api', `${base}/releases/assets/${assetIds[i]}`, '-H', 'Accept: application/octet-stream'], { maxBuffer: 128 * 1024 * 1024 });
            if (bytes.length !== expected.bytes.length || bytes.some((byte, offset) => byte !== expected.bytes[offset]) || sha256(bytes) !== sha256(expected.bytes))
                fail('REMOTE_ASSET_CONTENT_MISMATCH');
        }
        return release;
    };
    verifyInventory(true);
    verifyRemote();
    await assertPublishable(args);
    verifyInventory(true);
    gh('repo', 'edit', repo, '--visibility', 'public', '--accept-visibility-change-consequences');
    verifyInventory(true);
    gh('api', `${base}/releases/${releaseId}`, '--method', 'PATCH', '-F', 'draft=false', '-F', `prerelease=${prerelease}`, '-f', `make_latest=${prerelease ? 'false' : 'true'}`);
    verifyRemote();
    const final = verifyInventory(false);
    if (api(base).private !== false || api(`${base}/git/ref/tags/${c.version}`).object.sha !== c.candidateSha)
        fail('PUBLIC_READBACK_MISMATCH');
    const receipt = { url: final.html_url, candidateSha: c.candidateSha, archiveSha256: c.archiveSha256 };
    await writeFile(join(resolve(args.receiptPath, '..'), 'publication.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return receipt;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const [command, ...rest] = process.argv.slice(2);
        const options = new Map<string, string>();
        for (let i = 0; i < rest.length; i += 2) {
            if (!rest[i].startsWith('--') || !rest[i + 1] || options.has(rest[i]))
                fail('USAGE');
            options.set(rest[i], rest[i + 1]);
        }
        const need = (name: string) => options.get(name) ?? fail('USAGE');
        if (command === 'prepare')
            console.log(JSON.stringify(await prepare({ root: need('--root'), output: need('--output'), evidence: need('--evidence'), channel: (options.get('--channel') ?? 'stable') as Candidate['channel'], ...(options.has('--previous-candidate') || options.has('--previous-approval') ? { predecessor: { receiptPath: need('--previous-candidate'), approval: need('--previous-approval') } } : {}) })));
        else if (command === 'publish')
            console.log(JSON.stringify(await publish({ root: need('--root'), receiptPath: need('--candidate'), approval: need('--approval') })));
        else
            fail('USAGE');
    }
    catch (error) {
        const message = error instanceof Error ? error.message : '';
        console.error(/^[A-Z][A-Z_]+$/.test(message) ? message : 'RELEASE_OPERATION_FAILED');
        process.exitCode = 1;
    }
}
