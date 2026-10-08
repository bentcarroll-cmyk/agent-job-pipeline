import { Buffer } from 'node:buffer';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { loadRuntimeConfig } from '../../src/config/candidate';
import { parseInstanceConfig } from '../../src/config/instance';
import type { CandidateConfig, InstanceConfig, InstanceDraft } from '../../src/config/types';
import { DISPATCHER_CRON } from '../../src/config/schedule';
import { SetupError } from './types';
export function encodeCandidateBinding(candidate: CandidateConfig): string {
    const raw = JSON.stringify(candidate);
    if (Buffer.byteLength(raw) > 256 * 1024)
        throw new SetupError('CANDIDATE_DECODED_TOO_LARGE');
    const value = Buffer.byteLength(raw) <= 5120 ? raw : `gzip:${Buffer.from(gzipSync(raw)).toString('base64')}`;
    if (Buffer.byteLength(value) > 5120)
        throw new SetupError('CANDIDATE_BINDING_TOO_LARGE');
    return value;
}
export async function renderConfig(raw: InstanceConfig, candidate: CandidateConfig, kind: 'fixed' | 'unbounded', entry: string, mode: 'preview' | 'operational', privateAnthropicEntry?: string) {
    const instance = parseInstanceConfig(mode === 'preview' ? { ...raw, shadowMode: true, radar: { ...raw.radar, enabled: false } } : raw);
    assertGeneratedWorkflowNames(instance);
    await loadRuntimeConfig(candidate);
    const bindings = { CANDIDATE_CONFIG: encodeCandidateBinding(candidate), INSTANCE_CONFIG: JSON.stringify(instance), LIFECYCLE_MODE: !instance.lifecycle.enabled ? "off" : mode === "preview" ? "test" : "live" };
    if (Object.values(bindings).some(v => Buffer.byteLength(v) > 5120))
        throw new SetupError('INSTANCE_BINDING_TOO_LARGE');
    const template = await readFile(new URL(`../../templates/wrangler.${kind}.toml`, import.meta.url), 'utf8');
    const replacements: Record<string, string> = {
        // Operational rendering is called only after reviewed activation/CAS in the CLI.
        CRONS: JSON.stringify(mode === 'operational' && !instance.shadowMode ? [DISPATCHER_CRON] : []),
        LIFECYCLEMODE: JSON.stringify(bindings.LIFECYCLE_MODE),
        LIFECYCLE: JSON.stringify(`${instance.cloudflare.unboundedWorkerName}-lifecycle`),
        INTAKE: JSON.stringify(`${instance.cloudflare.unboundedWorkerName}-intake`),
        RADAR: JSON.stringify(`${instance.cloudflare.unboundedWorkerName}-radar`),
        NAME: JSON.stringify(kind === 'fixed' ? instance.cloudflare.fixedWorkerName : instance.cloudflare.unboundedWorkerName),
        ENTRY: JSON.stringify(entry), ACCOUNT: JSON.stringify(instance.cloudflare.accountId),
        DBNAME: JSON.stringify(instance.cloudflare.databaseName), DBID: JSON.stringify(instance.cloudflare.databaseId),
        CANDIDATE: JSON.stringify(bindings.CANDIDATE_CONFIG), INSTANCE: JSON.stringify(bindings.INSTANCE_CONFIG),
        WORKFLOW: JSON.stringify(`${kind === 'fixed' ? instance.cloudflare.fixedWorkerName : instance.cloudflare.unboundedWorkerName}-flow`)
    };
    const alias = kind === 'unbounded' && privateAnthropicEntry ? `\n[alias]\n\"@anthropic-ai/sdk\" = ${JSON.stringify(privateAnthropicEntry)}\n` : '';
    return { bindings, instance, text: template.replace(/\{\{([A-Z]+)\}\}/g, (_, key: string) => replacements[key]) + alias };
}

/** D1 IDs are schema-bounded UUIDs. Generated names must already be persisted in the supplied plan. */
export function assertProvisionedBindingSize(raw: InstanceDraft): void {
    const instance = parseInstanceConfig({ ...raw, cloudflare: { ...raw.cloudflare,
        databaseId: raw.cloudflare.databaseId ?? '00000000-0000-0000-0000-000000000000' } });
    assertGeneratedWorkflowNames(instance);
    for (const value of [instance, { ...instance, shadowMode: true, radar: { ...instance.radar, enabled: false } }])
        if (Buffer.byteLength(JSON.stringify(value)) > 5120) throw new SetupError('INSTANCE_BINDING_TOO_LARGE');
}

function assertGeneratedWorkflowNames(instance: InstanceConfig): void {
    const names = [`${instance.cloudflare.fixedWorkerName}-flow`, ...['flow', 'lifecycle', 'intake', 'radar'].map(suffix => `${instance.cloudflare.unboundedWorkerName}-${suffix}`)];
    if (names.some(name => name.length > 64)) throw new SetupError('WORKFLOW_NAME_TOO_LONG');
}
