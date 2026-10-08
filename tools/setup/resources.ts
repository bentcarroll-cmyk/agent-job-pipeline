import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { parseInstanceDraft, parseInstanceConfig } from '../../src/config/instance';
import type { InstanceDraft, InstanceConfig } from '../../src/config/types';
import { SetupError, type ResourceAdapter, type ResourceKind, type ResourceRecord } from './types';
import { atomicPrivateWrite, setupDirectory, setupPath } from './state';
import { assertProvisionedBindingSize } from './render-config';
import { hashBytes } from './preflight';
export const migrationIds = ['ledger', 'unbounded', 'lifecycle', 'discovery-controls', 'discovery-coverage', 'discovery-query', 'discovery-alias', 'discovery-candidates', 'discovery-fixed-candidates', 'durable-manual-intake', 'release-receipts', 'radar', 'candidate-config', 'fixed-baseline'] as const;
const kinds: ResourceKind[] = ['database', 'gateway', 'fixed_worker', 'unbounded_worker'];
export type ResourceIntent = Omit<ResourceRecord, 'id'> & {
    id: string | null;
    phase: 'planned' | 'started' | 'complete';
};
export type ResourcePlan = {
    schemaVersion: 1;
    instance: InstanceDraft;
    intents: ResourceIntent[];
};
export async function loadResourcePlan(root: string): Promise<ResourcePlan> {
    const plan = JSON.parse(await readFile(await setupPath(root, 'resources.json'), 'utf8')) as ResourcePlan;
    const instance = parseInstanceDraft(plan.instance);
    if (plan.schemaVersion !== 1 || !Array.isArray(plan.intents) || plan.intents.length !== 4)
        throw new SetupError('INVALID_RESOURCE_PLAN');
    const prefix = instance.cloudflare.databaseName.slice(0, -3);
    if (!/^ajp-[a-f0-9]{32}$/.test(prefix))
        throw new SetupError('OWNERSHIP_INTENT_REQUIRED');
    for (const kind of kinds) {
        const matching = plan.intents.filter(i => i.kind === kind);
        const i = matching[0];
        if (matching.length !== 1 || i.name !== resourceName(instance, kind) || !i.name.startsWith(prefix + '-') || i.instanceId !== instance.instanceId || i.accountId !== instance.cloudflare.accountId || !['planned', 'started', 'complete'].includes(i.phase) || (i.id !== null && typeof i.id !== 'string'))
            throw new SetupError('INVALID_RESOURCE_PLAN');
    }
    return plan;
}
async function savePlan(root: string, plan: ResourcePlan) { await setupDirectory(root); await atomicPrivateWrite(root, join(root, '.setup/resources.json'), JSON.stringify(plan, null, 2) + '\n'); }
export async function createResourcePlan(root: string, raw: InstanceDraft): Promise<ResourcePlan> {
    const instance = parseInstanceDraft(raw);
    try {
        const prior = await loadResourcePlan(root);
        if (prior.instance.instanceId !== instance.instanceId || prior.instance.cloudflare.accountId !== instance.cloudflare.accountId)
            throw new SetupError('INSTANCE_MISMATCH');
        const databaseId = prior.intents.find(i => i.kind === 'database')?.id ?? null;
        if (instance.cloudflare.databaseId !== null && (instance.cloudflare.databaseId !== databaseId || kinds.some(kind => resourceName(instance, kind) !== resourceName(prior.instance, kind))))
            throw new SetupError('RESOURCE_ID_CHANGED');
        prior.instance = parseInstanceDraft({ ...instance, cloudflare: { ...prior.instance.cloudflare, databaseId } });
        await savePlan(root, prior);
        return prior;
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
            throw e;
    }
    if (instance.cloudflare.databaseId !== null)
        throw new SetupError('OWNERSHIP_INTENT_REQUIRED');
    // 128 random bits, generated here and persisted before the first provider call.
    const prefix = `ajp-${Buffer.from(randomBytes(16)).toString('hex')}`;
    const draft = parseInstanceDraft({ ...instance, cloudflare: { ...instance.cloudflare, databaseName: `${prefix}-db`, fixedWorkerName: `${prefix}-fixed`, unboundedWorkerName: `${prefix}-open`, gatewayId: `${prefix}-ai` } });
    const plan: ResourcePlan = { schemaVersion: 1, instance: draft, intents: kinds.map(kind => ({ kind, id: null, phase: 'planned', name: resourceName(draft, kind), instanceId: draft.instanceId, accountId: draft.cloudflare.accountId })) };
    await savePlan(root, plan);
    return plan;
}
function resourceName(instance: InstanceDraft, kind: ResourceKind): string { return ({ database: instance.cloudflare.databaseName, gateway: instance.cloudflare.gatewayId, fixed_worker: instance.cloudflare.fixedWorkerName, unbounded_worker: instance.cloudflare.unboundedWorkerName })[kind]; }
function checkRecord(instance: InstanceDraft, kind: ResourceKind, record: ResourceRecord): void {
    if (record.kind !== kind || record.name !== resourceName(instance, kind) || record.instanceId !== instance.instanceId || record.accountId !== instance.cloudflare.accountId)
        throw new SetupError('RESOURCE_OWNERSHIP_CONFLICT');
}
export async function verifyResources(instance: InstanceConfig, adapter: ResourceAdapter): Promise<void> {
    parseInstanceConfig(instance);
    assertProvisionedBindingSize(instance);
    for (const kind of kinds) {
        const found = (await adapter.list(kind, instance.cloudflare.accountId)).filter(r => r.name === resourceName(instance, kind));
        if (found.length === 0)
            throw new SetupError('RESOURCE_MISSING');
        if (found.length !== 1)
            throw new SetupError('RESOURCE_AMBIGUOUS');
        checkRecord(instance, kind, found[0]);
        const read = await adapter.read(kind, found[0].id, instance.cloudflare.accountId);
        if (!read)
            throw new SetupError('RESOURCE_MISSING');
        checkRecord(instance, kind, read);
        if (kind === 'database' && read.id !== instance.cloudflare.databaseId)
            throw new SetupError('RESOURCE_ID_CHANGED');
    }
}
export async function ensureResources(raw: InstanceDraft, adapter: ResourceAdapter): Promise<InstanceConfig> {
    const instance = parseInstanceDraft(raw);
    assertProvisionedBindingSize(instance);
    let databaseId = instance.cloudflare.databaseId;
    for (const kind of kinds) {
        const records = (await adapter.list(kind, instance.cloudflare.accountId)).filter(r => r.name === resourceName(instance, kind));
        if (records.length > 1)
            throw new SetupError('RESOURCE_AMBIGUOUS');
        let record = records[0];
        if (!record) {
            if (kind === 'database' && databaseId)
                throw new SetupError('RESOURCE_MISSING');
            record = await adapter.create({ kind, name: resourceName(instance, kind), instanceId: instance.instanceId, accountId: instance.cloudflare.accountId });
        }
        checkRecord(instance, kind, record);
        const verified = await adapter.read(kind, record.id, instance.cloudflare.accountId);
        if (!verified)
            throw new SetupError('RESOURCE_MISSING');
        checkRecord(instance, kind, verified);
        if (kind === 'database') {
            if (databaseId && databaseId !== record.id)
                throw new SetupError('RESOURCE_ID_CHANGED');
            databaseId = record.id;
        }
    }
    const config = parseInstanceConfig({ ...instance, cloudflare: { ...instance.cloudflare, databaseId } });
    const result = await adapter.applyMigrations({ databaseId: config.cloudflare.databaseId, accountId: config.cloudflare.accountId, migrationIds });
    if (migrationIds.some(id => !result.appliedIds.includes(id)))
        throw new SetupError('MIGRATION_INCOMPLETE');
    return config;
}
export type SqlResult = {
    results: Record<string, unknown>[];
    meta: {
        changes: number;
    };
};
export interface SetupDatabase {
    batch(queries: readonly {
        sql: string;
        params?: unknown[];
    }[]): Promise<SqlResult[]>;
}
export function localSetupDatabase(db: D1Database): SetupDatabase { return { batch: async (queries) => (await db.batch(queries.map(q => db.prepare(q.sql).bind(...(q.params ?? []))))).map(r => ({ results: r.results as Record<string, unknown>[], meta: { changes: r.meta.changes } })) }; }
const metadataDDL = [`CREATE TABLE IF NOT EXISTS setup_instance_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1),instance_id TEXT NOT NULL,account_id TEXT NOT NULL,database_id TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS setup_migrations (id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,source_sha256 TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode IN ('represented','applied')),applied_at TEXT NOT NULL)`];
export async function migrationManifest(releaseRoot: string) {
    return Promise.all(migrationIds.map(async (id) => { const sql = await readFile(join(releaseRoot, `schema.${id}-migration.sql`), 'utf8'); return { id, sql, sha256: hashBytes(sql) }; }));
}
function statements(sql: string): string[] {
    // Restricted checked-in release DDL: reject unsupported parsing constructs instead of corrupting SQL.
    if (/\/\*|CREATE\s+TRIGGER/i.test(sql))
        throw new SetupError('UNSUPPORTED_MIGRATION_SQL');
    return sql.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean);
}
export async function applySchema(db: SetupDatabase, identity: {
    instanceId: string;
    accountId: string;
    databaseId: string;
}, releaseRoot: string): Promise<{
    appliedIds: readonly string[];
}> {
    const manifest = await migrationManifest(releaseRoot);
    const rootSQL = await readFile(join(releaseRoot, 'schema.sql'), 'utf8');
    const source = hashBytes(JSON.stringify({ root: hashBytes(rootSQL), migrations: manifest.map(m => [m.id, m.sha256]) }));
    const [tables] = await db.batch([{ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name!='d1_migrations'" }]);
    if (tables.results.length === 0) {
        const receipt = manifest.map(m => ({ sql: 'INSERT INTO setup_migrations (id,sha256,source_sha256,mode,applied_at) VALUES (?,?,?,?,?)', params: [m.id, m.sha256, source, 'represented', new Date().toISOString()] }));
        // DDL, ownership marker and represented receipts commit or roll back together.
        await db.batch([...statements(rootSQL).map(sql => ({ sql })), ...metadataDDL.map(sql => ({ sql })), { sql: 'INSERT INTO setup_instance_identity VALUES (1,?,?,?)', params: [identity.instanceId, identity.accountId, identity.databaseId] }, ...receipt]);
    }
    await verifyDatabaseOwner(db, identity);
    const [saved] = await db.batch([{ sql: 'SELECT id,sha256 FROM setup_migrations' }]);
    const receipts = new Map(saved.results.map(r => [String(r.id), String(r.sha256)]));
    if ([...receipts.keys()].some(id => !manifest.some(m => m.id === id)))
        throw new SetupError('UNKNOWN_MIGRATION_RECEIPT');
    for (const m of manifest) {
        if (receipts.has(m.id)) {
            if (receipts.get(m.id) !== m.sha256)
                throw new SetupError('MIGRATION_HASH_CHANGED');
            continue;
        }
        await db.batch([...statements(m.sql).map(sql => ({ sql })), { sql: 'INSERT INTO setup_migrations (id,sha256,source_sha256,mode,applied_at) VALUES (?,?,?,?,?)', params: [m.id, m.sha256, source, 'applied', new Date().toISOString()] }]);
    }
    return { appliedIds: manifest.map(m => m.id) };
}
export async function verifyDatabaseOwner(db: SetupDatabase, identity: {
    instanceId: string;
    accountId: string;
    databaseId: string;
}): Promise<void> {
    let rows: SqlResult[];
    try {
        rows = await db.batch([{ sql: 'SELECT instance_id,account_id,database_id FROM setup_instance_identity WHERE singleton=1' }]);
    }
    catch {
        throw new SetupError('DATABASE_OWNERSHIP_UNVERIFIED');
    }
    const row = rows[0].results[0];
    if (!row || row.instance_id !== identity.instanceId || row.account_id !== identity.accountId || row.database_id !== identity.databaseId)
        throw new SetupError('DATABASE_OWNERSHIP_CONFLICT');
}
/** Same account/name intent protocol as the real adapter; faults model uncertain transport and committed prefixes. */
export class FakeResourceAdapter implements ResourceAdapter {
    records: ResourceRecord[] = [];
    applied: string[] = [];
    loseCreateResponse: ResourceKind | null = null;
    failAfterMigration: number | null = null;
    constructor(private root: string, private plan: ResourcePlan) { }
    async list(kind: ResourceKind, accountId: string) { return this.records.filter(r => r.kind === kind && r.accountId === accountId); }
    async read(kind: ResourceKind, id: string, accountId: string) {
        const record = this.records.find(r => r.kind === kind && r.id === id && r.accountId === accountId) ?? null;
        if (record) {
            const intent = this.plan.intents.find(i => i.kind === kind && i.name === record.name && i.accountId === accountId && i.instanceId === record.instanceId);
            if (intent?.phase === 'started') {
                intent.id = record.id;
                intent.phase = 'complete';
                await savePlan(this.root, this.plan);
            }
            else if (intent?.id && intent.id !== record.id)
                throw new SetupError('RESOURCE_ID_CHANGED');
        }
        return record;
    }
    async create(input: Omit<ResourceRecord, 'id'>) {
        const intent = this.plan.intents.find(i => i.kind === input.kind && i.name === input.name && i.accountId === input.accountId && i.instanceId === input.instanceId);
        if (!intent)
            throw new SetupError('OWNERSHIP_INTENT_REQUIRED');
        if (intent.phase !== 'planned')
            throw new SetupError(intent.id ? 'RESOURCE_MISSING' : 'RESOURCE_CREATION_UNCERTAIN');
        intent.phase = 'started';
        await savePlan(this.root, this.plan);
        const record = { ...input, id: input.kind === 'gateway' ? input.name : randomUUID() };
        this.records.push(record);
        if (this.loseCreateResponse === input.kind) {
            this.loseCreateResponse = null;
            throw new SetupError('RESOURCE_CREATION_UNCERTAIN');
        }
        intent.id = record.id;
        intent.phase = 'complete';
        await savePlan(this.root, this.plan);
        return record;
    }
    async applyMigrations(input: {
        databaseId: string;
        accountId: string;
        migrationIds: readonly string[];
    }) {
        // A fresh database initializes root DDL and every represented receipt atomically.
        if (this.applied.length === 0) {
            this.applied = [...input.migrationIds];
            if (this.failAfterMigration !== null) {
                this.failAfterMigration = null;
                throw new SetupError('MIGRATION_INTERRUPTED');
            }
            return { appliedIds: [...this.applied] };
        }
        for (const id of input.migrationIds) {
        if (this.applied.includes(id))
            continue;
        this.applied.push(id);
        if (this.failAfterMigration === this.applied.length) {
            this.failAfterMigration = null;
            throw new SetupError('MIGRATION_INTERRUPTED');
        }
    } return { appliedIds: [...this.applied] }; }
}
/** Provider HTTP is explicit and injected; never reads ambient credentials or local Wrangler login. */
export type ProviderRequest = (path: string, method: 'GET' | 'POST', body?: unknown) => Promise<{
    result: any;
    result_info?: {
        total_pages?: number;
    };
} | null>;
export function cloudflareRequest(token: string): ProviderRequest {
    return async (path, method, body) => {
        const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (response.status === 404)
            return null;
        if (!response.ok)
            throw new SetupError('PROVIDER_REQUEST_FAILED');
        const value = await response.json() as any;
        if (!value.success)
            throw new SetupError('PROVIDER_REQUEST_FAILED');
        return value;
    };
}
/** Wrangler supplies offline build validation; documented account APIs supply metadata-only resources and transactional D1 batches. */
export class WranglerResourceAdapter implements ResourceAdapter {
    constructor(private root: string, private plan: ResourcePlan, private request: ProviderRequest, private releaseRoot: string) { assertProvisionedBindingSize(plan.instance); }
    private path(kind: ResourceKind, accountId: string) { if (accountId !== this.plan.instance.cloudflare.accountId)
        throw new SetupError('ACCOUNT_MISMATCH'); return `/accounts/${accountId}/${kind === 'database' ? 'd1/database' : kind === 'gateway' ? 'ai-gateway/gateways' : 'workers/workers'}`; }
    private record(kind: ResourceKind, accountId: string, value: any): ResourceRecord {
        const name = kind === 'gateway' ? value.id : value.name;
        const id = kind === 'database' ? value.uuid : value.id;
        if (typeof name !== 'string' || typeof id !== 'string')
            throw new SetupError('PROVIDER_IDENTITY_INVALID');
        const intent = this.plan.intents.find(i => i.kind === kind && i.name === name && i.accountId === accountId);
        if (intent?.id && intent.id !== id)
            throw new SetupError('RESOURCE_ID_CHANGED');
        return { kind, id, name, accountId, instanceId: intent && intent.phase !== 'planned' ? intent.instanceId : '' };
    }
    async list(kind: ResourceKind, accountId: string): Promise<ResourceRecord[]> {
        const records: ResourceRecord[] = [];
        for (let page = 1; page <= 1000; page++) {
            const result = await this.request(`${this.path(kind, accountId)}?page=${page}&per_page=50`, 'GET');
            if (!result || !Array.isArray(result.result))
                throw new SetupError('PROVIDER_LIST_INVALID');
            records.push(...result.result.map(v => this.record(kind, accountId, v)));
            if (result.result_info?.total_pages !== undefined ? page >= result.result_info.total_pages : result.result.length < 50)
                return records;
        }
        throw new SetupError('PROVIDER_LIST_LIMIT');
    }
    async read(kind: ResourceKind, id: string, accountId: string) {
        const result = await this.request(`${this.path(kind, accountId)}/${encodeURIComponent(id)}`, 'GET');
        if (!result)
            return null;
        const record = this.record(kind, accountId, result.result);
        const intent = this.plan.intents.find(i => i.kind === kind && i.name === record.name && i.accountId === accountId);
        if (intent?.phase === 'started') {
            intent.id = record.id;
            intent.phase = 'complete';
            await savePlan(this.root, this.plan);
        }
        return record;
    }
    async create(input: Omit<ResourceRecord, 'id'>): Promise<ResourceRecord> {
        const intent = this.plan.intents.find(i => i.kind === input.kind && i.name === input.name && i.accountId === input.accountId && i.instanceId === input.instanceId);
        if (!intent)
            throw new SetupError('OWNERSHIP_INTENT_REQUIRED');
        if (intent.phase !== 'planned')
            throw new SetupError(intent.id ? 'RESOURCE_MISSING' : 'RESOURCE_CREATION_UNCERTAIN');
        // A collision observed before this exact intent starts is foreign, not recoverable.
        if ((await this.list(input.kind, input.accountId)).some(r => r.name === input.name))
            throw new SetupError('RESOURCE_OWNERSHIP_CONFLICT');
        intent.phase = 'started';
        await savePlan(this.root, this.plan);
        const body = input.kind === 'database' ? { name: input.name } : input.kind === 'gateway' ? { id: input.name, cache_invalidate_on_update: true, cache_ttl: 0, collect_logs: false, rate_limiting_interval: 60, rate_limiting_limit: 0, rate_limiting_technique: 'fixed' } : { name: input.name, subdomain: { enabled: false, previews_enabled: false } };
        let result;
        try {
            result = await this.request(this.path(input.kind, input.accountId), 'POST', body);
        }
        catch {
            throw new SetupError('RESOURCE_CREATION_UNCERTAIN');
        }
        if (!result)
            throw new SetupError('RESOURCE_CREATION_UNCERTAIN');
        const record = this.record(input.kind, input.accountId, result.result);
        intent.id = record.id;
        intent.phase = 'complete';
        await savePlan(this.root, this.plan);
        return record;
    }
    database(databaseId: string, accountId: string): SetupDatabase {
        return { batch: async (queries) => {
                if (!this.plan.intents.some(i => i.kind === 'database' && i.phase === 'complete' && i.id === databaseId))
                    throw new SetupError('DATABASE_OWNERSHIP_UNVERIFIED');
                const response = await this.request(`${this.path('database', accountId)}/${encodeURIComponent(databaseId)}/query`, 'POST', { batch: queries });
                if (!response || !Array.isArray(response.result) || response.result.some((r: any) => !r.success))
                    throw new SetupError('DATABASE_QUERY_FAILED');
                return response.result;
            } };
    }
    async applyMigrations(input: {
        databaseId: string;
        accountId: string;
        migrationIds: readonly string[];
    }) { if (JSON.stringify(input.migrationIds) !== JSON.stringify(migrationIds))
        throw new SetupError('MIGRATION_MANIFEST_MISMATCH'); return applySchema(this.database(input.databaseId, input.accountId), { instanceId: this.plan.instance.instanceId, ...input }, this.releaseRoot); }
}
