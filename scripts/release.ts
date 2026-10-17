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
    schemaVersion: 2;
    channel: 'stable' | 'beta';
    version: string;
    repository: 'bentcarroll-cmyk/agent-job-pipeline';
    // The published release this one follows; null for the first release.
    previousRelease: { version: string; sha: string } | null;
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
const hex = (value: unknown, length: number): value is string => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
function validateChecks(checks: unknown, sha: string): asserts checks is Check[] {
    if (!Array.isArray(checks) || checks.length !== REQUIRED_CHECKS.length || new Set(checks.map(c => c?.name)).size !== REQUIRED_CHECKS.length)
        fail('CHECK_EVIDENCE_INVALID');
    for (const name of REQUIRED_CHECKS) {
        const c = checks.find(c => c?.name === name);
        if (!c || !['passed', 'pending', 'failed'].includes(c.status) || c.candidateSha !== sha || (c.status === 'passed' ? !hex(c.evidenceSha256, 64) : c.evidenceSha256 !== null && !hex(c.evidenceSha256, 64)))
            fail('CHECK_EVIDENCE_INVALID');
    }
}
const BETA_REQUIRED_CHECKS: readonly CheckName[] = ['local-verification', 'materials-and-visual-review', 'hosted-ci'];
// vMAJOR.MINOR.PATCH for stable, with -beta.N for beta.
const VERSION = /^v(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-beta\.([1-9]\d{0,5}))?$/;
const versionKey = (version: string) => {
    const m = VERSION.exec(version) ?? fail('RELEASE_VERSION_INVALID');
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])];
};
const channelOf = (version: string): Candidate['channel'] => (versionKey(version)[3] === Infinity ? 'stable' : 'beta');
// A beta sorts before the stable release of the same number.
function newer(version: string, than: string): boolean {
    const a = versionKey(version), b = versionKey(than);
    const i = a.findIndex((n, j) => n !== b[j]);
    return i >= 0 && a[i] > b[i];
}
// The channel is chosen deliberately and must agree with the committed package version.
function releaseVersion(root: string, channel: unknown): string {
    if (channel !== 'stable' && channel !== 'beta') fail('RELEASE_CHANNEL_INVALID');
    let value: unknown;
    try { value = JSON.parse(git(root, 'show', 'HEAD:package.json')).version; }
    catch { fail('RELEASE_CHANNEL_VERSION_MISMATCH'); }
    const version = `v${value}`;
    if (typeof value !== 'string' || !VERSION.test(version) || channelOf(version) !== channel) fail('RELEASE_CHANNEL_VERSION_MISMATCH');
    return version;
}
const isAncestor = (root: string, sha: string, of: string) => {
    try { execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', sha, of], { stdio: 'ignore' }); return true; }
    catch { return false; }
};
// A release that follows a published one names it: an earlier commit of this
// lineage whose committed package carries that older version.
function bindPreviousRelease(root: string, value: unknown, version: string, candidateSha: string): { version: string; sha: string } {
    const v = value as { version?: unknown; sha?: unknown } | null;
    if (!v || typeof v.version !== 'string' || !VERSION.test(v.version) || !hex(v.sha, 40) || !newer(version, v.version) ||
        v.sha === candidateSha || !isAncestor(root, v.sha, candidateSha))
        fail('PREVIOUS_RELEASE_INVALID');
    let packaged: unknown;
    try { packaged = JSON.parse(git(root, 'show', `${v.sha}:package.json`)).version; }
    catch { fail('PREVIOUS_RELEASE_INVALID'); }
    if (packaged !== v.version.slice(1)) fail('PREVIOUS_RELEASE_INVALID');
    return { version: v.version, sha: v.sha };
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
    // A correction of the reviewed, unpublished candidate at HEAD^.
    predecessor?: { receiptPath: string; approval: string };
    // The published release a new version follows.
    previousRelease?: { version: string; sha: string };
}): Promise<Candidate> {
    const root = await realpath(args.root), output = join(await realpath(dirname(resolve(args.output))), basename(args.output));
    const rel = relative(root, output);
    if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)))
        fail('OUTPUT_MUST_BE_EXTERNAL');
    const state = await inspectRoot(root);
    const channel = args.channel ?? 'stable';
    const version = releaseVersion(root, channel);
    let parentReceiptSha256: string | null = null;
    let previousRelease: Candidate['previousRelease'] = null;
    if (args.predecessor && args.previousRelease) fail('PREDECESSOR_BINDING_INVALID');
    if (args.previousRelease) previousRelease = bindPreviousRelease(root, args.previousRelease, version, state.candidateSha);
    else if (state.candidateSha !== state.rootSha) {
        if (!args.predecessor) fail('PREDECESSOR_REVIEW_REQUIRED');
        const bytes = await readFile(args.predecessor.receiptPath);
        const previous: Candidate = JSON.parse(bytes.toString());
        const review = JSON.parse(await readFile(args.predecessor.approval, 'utf8'));
        if (review.schemaVersion !== 1 || review.approved !== true || review.candidateReceiptSha256 !== sha256(bytes) || !Number.isFinite(Date.parse(review.reviewedAt))) fail('CANDIDATE_REVIEW_STALE');
        const parent = git(root, 'rev-parse', 'HEAD^');
        const ancestors = git(root, 'rev-list', '--reverse', parent).split('\n');
        const tracked = git(root, 'for-each-ref', '--format=%(objectname)', 'refs/remotes/origin/main');
        if (tracked && tracked !== parent && tracked !== state.candidateSha) fail('PREDECESSOR_BINDING_INVALID');
        if (previous.channel !== channel || previous.version !== version || previous.schemaVersion !== 2 || !('previousRelease' in previous) || previous.repository !== 'bentcarroll-cmyk/agent-job-pipeline' || previous.candidateSha !== parent || previous.rootSha !== state.rootSha || previous.lineageSha256 !== sha256(JSON.stringify(ancestors)) || previous.treeSha !== git(root, 'rev-parse', `${parent}^{tree}`) || previous.manifestSha256 !== sha256(execFileSync('git', ['-C', root, 'show', `${parent}:.release/public-manifest.json`]))) fail('PREDECESSOR_BINDING_INVALID');
        assertPackageVersion(root, previous.version, parent);
        // A correction keeps the release its predecessor follows.
        if (previous.previousRelease !== null) previousRelease = bindPreviousRelease(root, previous.previousRelease, version, state.candidateSha);
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
    const candidate: Candidate = { schemaVersion: 2, channel, version, repository: 'bentcarroll-cmyk/agent-job-pipeline', previousRelease, ...state, parentReceiptSha256, archiveSha256: archive.sha256, installationResultsSha256: await hash('docs/installation-results.md'), releaseNotesSha256: await hash('docs/release-notes.md'), licenseSha256: await hash('LICENSE'), platforms: ['macos-arm64'], checks: evidence.checks };
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
    if (c.schemaVersion !== 2 || !['stable', 'beta'].includes(c.channel) || typeof c.version !== 'string' || !VERSION.test(c.version) || channelOf(c.version) !== c.channel || !('previousRelease' in c) || c.repository !== 'bentcarroll-cmyk/agent-job-pipeline' || !hex(c.candidateSha, 40) || JSON.stringify(c.platforms) !== JSON.stringify(['macos-arm64']))
        fail('CANDIDATE_RECEIPT_INVALID');
    if (git(args.root, 'rev-parse', 'HEAD') !== c.candidateSha)
        fail('CANDIDATE_MOVED');
    assertPackageVersion(args.root, c.version);
    if (c.previousRelease !== null) bindPreviousRelease(args.root, c.previousRelease, c.version, c.candidateSha);
    validateChecks(c.checks, c.candidateSha);
    const required = c.channel === 'beta' ? BETA_REQUIRED_CHECKS : REQUIRED_CHECKS;
    if (c.checks.some(check => check.status === 'failed' || (required.includes(check.name) && check.status !== 'passed')))
        fail('REQUIRED_CHECK_NOT_PASSED');
    const state = await inspectRoot(args.root);
    const archive = join(resolve(args.receiptPath, '..'), 'agent-job-pipeline.tar.gz');
    if (!(await verifyRelease(archive)).passed)
        fail('ARCHIVE_VERIFICATION_FAILED');
    const raw = await readFile(archive);
    // A later commit is reviewed either as a correction of the candidate before
    // it (a parent receipt) or as a new version after a published release.
    const reviewed = state.rootSha === state.candidateSha
        ? c.parentReceiptSha256 === null && c.previousRelease === null
        : hex(c.parentReceiptSha256, 64) || (c.parentReceiptSha256 === null && c.previousRelease !== null);
    if (state.rootSha !== c.rootSha || state.lineageSha256 !== c.lineageSha256 || !reviewed || state.treeSha !== c.treeSha || state.manifestSha256 !== c.manifestSha256 || sha256(raw) !== c.archiveSha256)
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
    // A first release is staged privately and made public here. A later release
    // goes to the already public repository, whose visibility it never changes.
    // Never create/adopt/push a development checkout here.
    const followUp = c.previousRelease !== null;
    if (remote.full_name !== repo || remote.default_branch !== 'main')
        fail('REMOTE_REPOSITORY_UNREVIEWED');
    if (!followUp && remote.private !== true)
        fail('PRIVATE_STAGING_REQUIRED');
    if (followUp && remote.private !== false)
        fail('PUBLIC_REPOSITORY_REQUIRED');
    type Release = { id: number; tag_name: string; name: string; body: string; draft: boolean; prerelease: boolean; target_commitish?: string; html_url: string; assets: { id: number; name: string }[] };
    const releaseInventory = (): Release[] => {
        const releases = api(`${base}/releases?per_page=100`);
        // A full page may hide more; fail closed.
        if (!Array.isArray(releases) || releases.length >= 100)
            fail('REMOTE_RELEASE_INVENTORY_UNREVIEWED');
        return releases;
    };
    // The releases already published, as first observed: none before a first
    // release; otherwise older published versions, including the one this
    // release follows. They must stay exactly as they are.
    const prior = releaseInventory();
    if (!followUp ? prior.length !== 0
        : prior.some(r => !Number.isSafeInteger(r.id) || r.draft !== false || typeof r.tag_name !== 'string' || r.name !== r.tag_name || !VERSION.test(r.tag_name) ||
            !newer(c.version, r.tag_name) || r.prerelease !== (channelOf(r.tag_name) === 'beta') ||
            !Array.isArray(r.assets) || r.assets.some(a => !Number.isSafeInteger(a?.id) || typeof a?.name !== 'string')) ||
          new Set(prior.map(r => r.tag_name)).size !== prior.length ||
          // The release followed is the newest published one.
          !prior.some(r => r.tag_name === c.previousRelease!.version) || prior.some(r => newer(r.tag_name, c.previousRelease!.version)))
        fail('REMOTE_RELEASE_INVENTORY_UNREVIEWED');
    const snapshot = (releases: Release[]) => JSON.stringify(releases.map(r => [r.id, r.tag_name, r.name, r.body, r.draft, r.prerelease,
        Array.isArray(r.assets) ? r.assets.map(a => [a?.id, a?.name]).sort() : null]).sort());
    const priorSnapshot = snapshot(prior);
    const requirePriorReleases = (releases: Release[]) => {
        if (snapshot(releases) !== priorSnapshot)
            fail('REMOTE_RELEASE_INVENTORY_UNREVIEWED');
    };
    let tagCreated = false;
    // Each earlier release's tag, as first observed on an earlier commit of this lineage.
    const priorTags = new Map(prior.map(r => [`refs/tags/${r.tag_name}`, r.tag_name]));
    const priorTagShas = new Map<string, string>();
    const verifyRemote = () => {
        const refs = api(`${base}/git/matching-refs/`);
        const expected = 1 + prior.length + (tagCreated ? 1 : 0);
        if (!Array.isArray(refs) || refs.length !== expected || new Set(refs.map(r => r.ref)).size !== expected)
            fail('REMOTE_REFS_UNREVIEWED');
        for (const r of refs) {
            const sha = r.object?.sha;
            if (r.object?.type !== 'commit')
                fail('REMOTE_REFS_UNREVIEWED');
            if (r.ref === 'refs/heads/main' || (tagCreated && r.ref === `refs/tags/${c.version}`)) {
                if (sha !== c.candidateSha) fail('REMOTE_REFS_UNREVIEWED');
                continue;
            }
            const tag = priorTags.get(r.ref);
            const known = priorTagShas.get(r.ref);
            if (!tag || !hex(sha, 40) || (known ? sha !== known : sha === c.candidateSha || !isAncestor(args.root, sha, c.candidateSha)) ||
                (tag === c.previousRelease?.version && sha !== c.previousRelease.sha))
                fail('REMOTE_REFS_UNREVIEWED');
            priorTagShas.set(r.ref, sha);
        }
        if (api(`${base}/git/ref/heads/main`).object.sha !== c.candidateSha)
            fail('REMOTE_CANDIDATE_MOVED');
        validateHostedChecks(api(`${base}/commits/${c.candidateSha}/check-runs?per_page=100&filter=latest`), c.candidateSha);
    };
    verifyRemote();
    // Recheck local bindings and all inventory immediately before the first remote mutation.
    await assertPublishable(args);
    verifyRemote();
    requirePriorReleases(releaseInventory());
    const archive = join(resolve(args.receiptPath, '..'), 'agent-job-pipeline.tar.gz');
    const expectedAssets = [
        { name: 'agent-job-pipeline.tar.gz', bytes: await readFile(archive) },
        { name: 'agent-job-pipeline.tar.gz.sha256', bytes: await readFile(archive + '.sha256') },
    ];
    const releaseNotes = await readFile(join(args.root, 'docs/release-notes.md'), 'utf8');
    const prerelease = c.channel === 'beta';
    const hasExpectedMetadata = (r: Release) => r.tag_name === c.version && r.name === c.version && r.body === releaseNotes && r.prerelease === prerelease &&
        (!followUp || r.target_commitish === c.candidateSha);
    // A first release tags the candidate in its private staging repository
    // first. A later release's repository is already public, so its draft
    // targets the candidate and GitHub creates the tag only when the draft is
    // published: a refusal before then leaves at most an unpublished draft.
    if (!followUp) {
        gh('api', `${base}/git/refs`, '--method', 'POST', '-f', `ref=refs/tags/${c.version}`, '-f', `sha=${c.candidateSha}`);
        tagCreated = true;
    }
    // Bind the identity returned by creation; never adopt a release found later by tag/name.
    const created = JSON.parse(gh('api', `${base}/releases`, '--method', 'POST', '-f', `tag_name=${c.version}`, ...(followUp ? ['-f', `target_commitish=${c.candidateSha}`] : []), '-f', `name=${c.version}`, '-F', 'draft=true', '-F', `prerelease=${prerelease}`, '-f', `make_latest=${prerelease ? 'false' : 'true'}`, '-F', `body=@${join(args.root, 'docs/release-notes.md')}`));
    if (!Number.isSafeInteger(created.id) || created.id <= 0 || !hasExpectedMetadata(created) || created.draft !== true)
        fail('REMOTE_RELEASE_INVENTORY_UNREVIEWED');
    const releaseId: number = created.id;
    gh('release', 'upload', c.version, '--repo', repo, archive, archive + '.sha256');
    let assetIds: readonly number[] | undefined;
    const verifyInventory = (draft: boolean) => {
        // Exactly this release beside the unchanged earlier ones: any other
        // inventory (including a release without a Git tag) fails closed.
        const releases = releaseInventory();
        const mine = releases.filter(r => r.id === releaseId);
        if (mine.length !== 1 || !hasExpectedMetadata(mine[0]) || mine[0].draft !== draft)
            fail('REMOTE_RELEASE_INVENTORY_UNREVIEWED');
        requirePriorReleases(releases.filter(r => r.id !== releaseId));
        const release = mine[0];
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
    if (!followUp)
        gh('repo', 'edit', repo, '--visibility', 'public', '--accept-visibility-change-consequences');
    else if (api(base).private !== false)
        fail('PUBLIC_REPOSITORY_REQUIRED');
    verifyInventory(true);
    // Refs, main and hosted checks once more, immediately before the release is published.
    verifyRemote();
    gh('api', `${base}/releases/${releaseId}`, '--method', 'PATCH', '-F', 'draft=false', '-F', `prerelease=${prerelease}`, '-f', `make_latest=${prerelease ? 'false' : 'true'}`);
    tagCreated = true;
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
            console.log(JSON.stringify(await prepare({ root: need('--root'), output: need('--output'), evidence: need('--evidence'), channel: (options.get('--channel') ?? 'stable') as Candidate['channel'],
                ...(options.has('--previous-candidate') || options.has('--previous-approval') ? { predecessor: { receiptPath: need('--previous-candidate'), approval: need('--previous-approval') } } : {}),
                ...(options.has('--previous-release') || options.has('--previous-release-sha') ? { previousRelease: { version: need('--previous-release'), sha: need('--previous-release-sha') } } : {}) })));
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
