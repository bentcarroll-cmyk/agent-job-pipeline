import { readFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseInstanceDraft, parseInstanceConfig } from '../../src/config/instance';
import { activateCandidateConfig, readActiveCandidateConfig } from '../../src/config/run-context';
import type { InstanceConfig, RuntimeConfig } from '../../src/config/types';
import { SetupError, type ResourceAdapter, type SetupStage } from './types';
import { loadSetupState, saveLockedReceipt, withWorkspaceLock, atomicPrivateWrite, setupPath } from './state';
import { assertWorkspace, privatePath, loadApprovedProfile, hashBytes, prepareDependencies, probeDependencies } from './preflight';
import { createResourcePlan, loadResourcePlan, ensureResources, verifyResources, WranglerResourceAdapter, cloudflareRequest, verifyDatabaseOwner, type SetupDatabase } from './resources';
import { renderConfig, encodeCandidateBinding, assertProvisionedBindingSize } from './render-config';
const exec = promisify(execFile);
export const releaseRoot = fileURLToPath(new URL('../..', import.meta.url));
export type ActivationExpected = {
    instanceId: string;
    instanceSha256: string;
    criteriaVersion: string;
    readableSha256: string;
    resourceIds: Record<string, string>;
    expectedRevision: number | null;
};
export type ActivationReview = ActivationExpected & {
    externalQuiesced: boolean;
    receiptsReconciled: boolean;
    evidence: string;
    reviewedAt: string;
};
export function validateActivationReview(review: ActivationReview, expected: ActivationExpected): void {
    for (const key of Object.keys(expected) as (keyof ActivationExpected)[])
        if (JSON.stringify(review[key]) !== JSON.stringify(expected[key]))
            throw new SetupError('ACTIVATION_REVIEW_CHANGED');
    if (!review.externalQuiesced || !review.receiptsReconciled || typeof review.evidence !== 'string' || review.evidence.trim().length < 20 || !Number.isFinite(Date.parse(review.reviewedAt)) || Date.now() - Date.parse(review.reviewedAt) > 60 * 60 * 1000 || Date.parse(review.reviewedAt) > Date.now() + 60000)
        throw new SetupError('CUTOVER_NOT_REVIEWED');
}
/** Narrow adapter reuses the reviewed active-config CAS implementation unchanged. */
function activeDatabase(db: SetupDatabase): D1Database {
    return { prepare: (sql: string) => { const statement = (params: unknown[]) => ({ bind: (...values: unknown[]) => statement(values), run: async () => { const [result] = await db.batch([{ sql, params }]); return result; }, first: async () => { const [result] = await db.batch([{ sql, params }]); return result.results[0] ?? null; } }); return statement([]); } } as unknown as D1Database;
}
export async function assertDrained(db: SetupDatabase): Promise<void> {
    const checks = [
        { sql: 'SELECT COUNT(*) AS n FROM discovery_run_leases WHERE expires_at>?', params: [Date.now()] },
        { sql: "SELECT COUNT(*) AS n FROM manual_intake_deliveries WHERE state IN ('sending','unknown')" },
        { sql: 'SELECT COUNT(*) AS n FROM discovery_delivery_attempts a LEFT JOIN discovery_run_delivery_resolutions r ON a.run_id=r.run_id AND a.intent_id=r.intent_id WHERE r.intent_id IS NULL' },
    ];
    const rows = await db.batch(checks);
    if (rows.some(r => Number(r.results[0]?.n) !== 0))
        throw new SetupError('DELIVERY_NOT_DRAINED');
}
export async function activateReviewed(root: string, raw: InstanceConfig, runtime: RuntimeConfig, adapter: ResourceAdapter, db: SetupDatabase, review: ActivationReview): Promise<number> {
    const instance = parseInstanceConfig(raw);
    await verifyResources(instance, adapter);
    await verifyDatabaseOwner(db, { instanceId: instance.instanceId, accountId: instance.cloudflare.accountId, databaseId: instance.cloudflare.databaseId });
    const actual = await loadApprovedProfile(root);
    if (actual.criteriaVersion !== runtime.criteriaVersion)
        throw new SetupError('ACTIVATION_REVIEW_CHANGED');
    const plan = await loadResourcePlan(root);
    const resourceIds = Object.fromEntries(plan.intents.map(i => [i.kind, i.id ?? '']));
    if (Object.values(resourceIds).some(v => !v))
        throw new SetupError('RESOURCE_ID_UNVERIFIED');
    const expected = { instanceId: instance.instanceId, instanceSha256: hashBytes(JSON.stringify(instance)), criteriaVersion: actual.criteriaVersion, readableSha256: actual.candidate.approval.readableSha256, resourceIds, expectedRevision: review.expectedRevision };
    validateActivationReview(review, expected);
    await assertDrained(db);
    const fingerprint = hashBytes(JSON.stringify(review));
    const path = await setupPath(root, 'activation-intent.json');
    let prior: {
        fingerprint: string;
        expectedRevision: number | null;
        criteriaVersion: string;
    } | null = null;
    try {
        prior = JSON.parse(await readFile(path, 'utf8'));
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
            throw e;
    }
    const active = await readActiveCandidateConfig(activeDatabase(db), instance.instanceId);
    if (prior?.fingerprint === fingerprint && active?.revision === (review.expectedRevision ?? 0) + 1 && active.criteriaVersion === actual.criteriaVersion)
        return active.revision;
    if ((active?.revision ?? null) !== review.expectedRevision)
        throw new SetupError('ACTIVE_REVISION_CHANGED');
    await atomicPrivateWrite(root, path, JSON.stringify({ fingerprint, expectedRevision: review.expectedRevision, criteriaVersion: actual.criteriaVersion }) + '\n');
    // No retry with a newly observed revision. On an uncertain result the next invocation reconciles the exact intent.
    return activateCandidateConfig(activeDatabase(db), instance.instanceId, actual, review.expectedRevision);
}
export {assertWranglerIsolation} from './core-guards.mjs';
import {isolatedWranglerEnvironment} from './core-guards.mjs';
export async function dryRunBuild(root: string, config: string, kind: string): Promise<void> {
    // Explicit invalid credentials bypass stored authorization in offline builds only.
    const env = await isolatedWranglerEnvironment(root, 'offline-build-no-provider-authorization');
    const output = await setupPath(root, `build/${kind}`, 'directory', true);
    const safeConfig = await setupPath(root, relative(join(root, '.setup'), config));
    const envFile = await setupPath(root, 'wrangler.env');
    await atomicPrivateWrite(root, envFile, '');
    const cli = await setupPath(root, 'dependencies/node_modules/wrangler/bin/wrangler.js');
    try {
        await exec(process.execPath, [cli, 'deploy', '--dry-run', '--config', safeConfig, '--outdir', output, '--env-file', envFile], { cwd: root, env, maxBuffer: 2 * 1024 * 1024 });
    }
    catch {
        throw new SetupError('OFFLINE_BUILD_FAILED');
    }
}
export async function previewWorkspace(root: string, instance: InstanceConfig, runtime: RuntimeConfig, build = dryRunBuild) {
    const directory = await setupPath(root, 'generated', 'directory', true);
    for (const kind of ['fixed', 'unbounded'] as const) {
        const entry = join(releaseRoot, kind === 'fixed' ? 'src/index.ts' : 'src/unbounded/index.ts');
        const result = await renderConfig(instance, runtime.candidate, kind, entry, 'preview', await setupPath(root, 'dependencies/node_modules/@anthropic-ai/sdk/index.mjs'));
        const path = join(directory, `wrangler.${kind}.toml`);
        await atomicPrivateWrite(root, path, result.text);
        await build(root, path, kind);
    }
    await atomicPrivateWrite(root, join(root, '.setup/preview.json'), JSON.stringify({ schemaVersion: 1, instanceSha256: hashBytes(JSON.stringify(instance)), criteriaVersion: runtime.criteriaVersion, readableSha256: runtime.candidate.approval.readableSha256, checkedAt: new Date().toISOString(), checks: ['approved-profile', 'bounded-bindings', 'offline-fixed-build', 'offline-unbounded-build'], livePreview: false }) + '\n');
}
function parseArguments(argv: string[]) {
    const [command, ...flags] = argv;
    if (!['check', 'status', 'resources', 'preview', 'activate'].includes(command))
        throw new SetupError('SETUP_COMMAND_REQUIRED');
    const args: Record<string, string> = {};
    for (let i = 0; i < flags.length; i += 2) {
        if (!/^--(workspace|instance|python|review|provider-writes)$/.test(flags[i]) || !flags[i + 1] || flags[i + 1].startsWith('--'))
            throw new SetupError('INVALID_SETUP_ARGUMENT');
        args[flags[i].slice(2)] = flags[i + 1];
    }
    if (!args.workspace || !args.instance || !isAbsolute(args.workspace) || !isAbsolute(args.instance))
        throw new SetupError('ABSOLUTE_WORKSPACE_AND_INSTANCE_REQUIRED');
    return { command, args };
}
export async function main(argv = process.argv.slice(2)): Promise<string> {
    const { command, args } = parseArguments(argv);
    // This extraction's protected source sibling is a location boundary, never opened for data.
    const workspace = await assertWorkspace(args.workspace, [releaseRoot, resolve(releaseRoot, '../glm-agent-pipeline')]);
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const instancePath = await privatePath(workspace, args.instance);
    return withWorkspaceLock(workspace, async () => {
        const raw = parseInstanceDraft(JSON.parse(await readFile(instancePath, 'utf8')));
        const receipts = await loadSetupState(workspace);
        if (receipts.some(r => r.instanceId !== raw.instanceId))
            throw new SetupError('INSTANCE_MISMATCH');
        if (command === 'status')
            return JSON.stringify(receipts.map(r => ({ stage: r.stage, status: r.status, errorCode: r.errorCode })));
        const runtime = await loadApprovedProfile(workspace);
        encodeCandidateBinding(runtime.candidate);
        if (new TextEncoder().encode(JSON.stringify(raw)).length > 5120)
            throw new SetupError('INSTANCE_BINDING_TOO_LARGE');
        const fingerprint = hashBytes(JSON.stringify({ instance: raw, candidate: runtime.candidate }));
        const receipt = (stage: SetupStage, status: 'pending' | 'complete' | 'blocked', resourceIds: Record<string, string> = {}, errorCode: string | null = null) => saveLockedReceipt(workspace, { schemaVersion: 1, instanceId: raw.instanceId, stage, status, fingerprint, resourceIds, errorCode });
        const stage: SetupStage = command === 'check' ? 'preflight' : command === 'activate' ? 'activation' : command as SetupStage;
        await receipt(stage, 'pending');
        try {
            if (command === 'check') {
                if (!args.python || !isAbsolute(args.python))
                    throw new SetupError('EXPLICIT_PYTHON_EXECUTABLE_REQUIRED');
                const capabilities = await prepareDependencies(workspace, releaseRoot, args.python);
                await atomicPrivateWrite(workspace, join(workspace, '.setup/capabilities.json'), JSON.stringify(capabilities) + '\n');
                await receipt('workspace', 'complete');
                await receipt('profile', 'complete');
            }
            else {
                await probeDependencies(workspace, releaseRoot);
                if (command === 'preview') {
                    await previewWorkspace(workspace, parseInstanceConfig(raw), runtime);
                }
                else {
                    if (args['provider-writes'] !== 'approved')
                        throw new SetupError('EXPLICIT_PROVIDER_ACTION_REQUIRED');
                    // An explicitly supplied token is used only for this selected account. No login/config discovery.
                    const token = process.env.CLOUDFLARE_API_TOKEN;
                    if (!token)
                        throw new SetupError('EXPLICIT_PROVIDER_TOKEN_REQUIRED');
                    const plan = command === 'resources' ? await createResourcePlan(workspace, raw) : await loadResourcePlan(workspace);
                    assertProvisionedBindingSize(plan.instance);
                    const adapter = new WranglerResourceAdapter(workspace, plan, cloudflareRequest(token), releaseRoot);
                    if (command === 'resources') {
                        const instance = await ensureResources(plan.instance, adapter);
                        await atomicPrivateWrite(workspace, instancePath, JSON.stringify(instance, null, 2) + '\n');
                        await receipt('accounts', 'complete');
                    }
                    else {
                        const instance = parseInstanceConfig(raw);
                        const db = adapter.database(instance.cloudflare.databaseId, instance.cloudflare.accountId);
                        await verifyResources(instance, adapter);
                        await verifyDatabaseOwner(db, { instanceId: instance.instanceId, accountId: instance.cloudflare.accountId, databaseId: instance.cloudflare.databaseId });
                        const active = await readActiveCandidateConfig(activeDatabase(db), instance.instanceId);
                        const expected: ActivationExpected = { instanceId: instance.instanceId, instanceSha256: hashBytes(JSON.stringify(instance)), criteriaVersion: runtime.criteriaVersion, readableSha256: runtime.candidate.approval.readableSha256, resourceIds: Object.fromEntries(plan.intents.map(i => [i.kind, i.id ?? ''])), expectedRevision: active?.revision ?? null };
                        if (!args.review) {
                            await atomicPrivateWrite(workspace, join(workspace, '.setup/activation-review.json'), JSON.stringify({ ...expected, externalQuiesced: false, receiptsReconciled: false, evidence: '', reviewedAt: '' }, null, 2) + '\n');
                            throw new SetupError('ACTIVATION_REVIEW_REQUIRED');
                        }
                        const preview = JSON.parse(await readFile(await setupPath(workspace, 'preview.json'), 'utf8'));
                        if (preview.instanceSha256 !== expected.instanceSha256 || preview.criteriaVersion !== expected.criteriaVersion || preview.readableSha256 !== expected.readableSha256)
                            throw new SetupError('PREVIEW_STALE');
                        const review = JSON.parse(await readFile(await privatePath(workspace, args.review), 'utf8')) as ActivationReview;
                        await activateReviewed(workspace, instance, runtime, adapter, db, review);
                        // Reviewed operational configs emit approved dispatch ticks; deployment remains a separate action.
                        for (const kind of ['fixed', 'unbounded'] as const) {
                            const rendered = await renderConfig(instance, runtime.candidate, kind, join(releaseRoot, kind === 'fixed' ? 'src/index.ts' : 'src/unbounded/index.ts'), 'operational', await setupPath(workspace, 'dependencies/node_modules/@anthropic-ai/sdk/index.mjs'));
                            await atomicPrivateWrite(workspace, join(workspace, '.setup/generated', `wrangler.${kind}.operational.toml`), rendered.text);
                        }
                    }
                }
            }
            let ids: Record<string, string> = {};
            try {
                ids = Object.fromEntries((await loadResourcePlan(workspace)).intents.filter(i => i.id).map(i => [i.kind, i.id!]));
            }
            catch { }
            await receipt(stage, 'complete', ids);
            return `${command}: complete${command === 'preview' ? ' (offline profile and build checks; no live preview)' : ''}`;
        }
        catch (e) {
            const code = e instanceof SetupError ? e.code : 'SETUP_OPERATION_FAILED';
            await receipt(stage, 'blocked', {}, code);
            throw new SetupError(code);
        }
    });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().then(result => process.stdout.write(result + '\n'), error => { process.stderr.write((error instanceof SetupError ? error.code : 'SETUP_OPERATION_FAILED') + '\n'); process.exitCode = 1; });
}
