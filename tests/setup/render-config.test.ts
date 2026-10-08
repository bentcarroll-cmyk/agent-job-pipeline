import { Buffer } from 'node:buffer';
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { candidateCriteriaVersion } from '../../src/config/candidate';
import { configureEnv } from '../../src/config/env';
import { encodeCandidateBinding, renderConfig } from '../../tools/setup/render-config';
import { CHICAGO_OPERATIONS } from '../fixtures/candidates';
const instance = JSON.parse(readFileSync(new URL('../../examples/instance.json', import.meta.url), 'utf8'));
it('renders explicit empty crons and authoritative preview projection', async () => { const result = await renderConfig(instance, CHICAGO_OPERATIONS, 'fixed', '/tmp/synthetic/src/index.ts', 'preview'); expect(result.text).toContain('crons = []'); const env = await configureEnv({ ...result.bindings, SLACK_ALLOWED_USER_ID: '', SHADOW_MODE: 'false', AI_GATEWAY_ID: 'foreign' }); expect(env.instance.shadowMode).toBe(true); expect(env.SHADOW_MODE).toBe('true'); expect(env.SLACK_ALLOWED_USER_ID).toBe(instance.slack.allowedUserId); expect(env.AI_GATEWAY_ID).toBe(instance.cloudflare.gatewayId); expect(env.RADAR_MODE).toBe('off'); });
it('losslessly compresses a large approved source bank and verifies every hash after decode', async () => { const c = structuredClone(CHICAGO_OPERATIONS); c.search.openWebPhrases = Array.from({ length: 250 }, (_, i) => `operations leader ${i} Chicago manufacturing transformation`); c.approval.configSha256 = await candidateCriteriaVersion(c); const binding = encodeCandidateBinding(c); expect(Buffer.byteLength(binding)).toBeLessThanOrEqual(5120); expect(binding).toMatch(/^gzip:/); const loaded = await configureEnv({ CANDIDATE_CONFIG: binding, INSTANCE_CONFIG: JSON.stringify(instance) }); expect(loaded.runtime.candidate).toEqual(c); c.approval.configSha256 = 'a'.repeat(64); await expect(configureEnv({ CANDIDATE_CONFIG: encodeCandidateBinding(c), INSTANCE_CONFIG: JSON.stringify(instance) })).rejects.toThrow(/approval/i); });
it('rejects uncompressible provider oversize and malformed data without echoing input', async () => { const c = structuredClone(CHICAGO_OPERATIONS); c.search.openWebPhrases = [Buffer.from(randomBytes(9000)).toString('hex')]; expect(() => encodeCandidateBinding(c)).toThrow('CANDIDATE_BINDING_TOO_LARGE'); await expect(configureEnv({ CANDIDATE_CONFIG: 'gzip:secret-invalid!', INSTANCE_CONFIG: JSON.stringify(instance) })).rejects.toThrow('INVALID_CANDIDATE_BINDING'); });
it('operational projection uses instance modes while explicit lifecycle test/off can only restrict live writes', async () => { const enabled = { ...instance, lifecycle: { ...instance.lifecycle, enabled: true }, schedule: { ...instance.schedule, lifecycleLocalTime: '10:00' }, screeningMode: 'evidence', manualScreeningMode: 'evidence' }; const { bindings } = await renderConfig(enabled, CHICAGO_OPERATIONS, 'unbounded', '/tmp/synthetic.ts', 'operational'); const actual = await configureEnv({ ...bindings, SCREENING_MODE: 'legacy', MANUAL_SCREENING_MODE: 'legacy', SLACK_ALLOWED_USER_ID: '' }); expect(actual.LIFECYCLE_MODE).toBe('live'); expect(actual.SCREENING_MODE).toBe('evidence'); expect(actual.MANUAL_SCREENING_MODE).toBe('evidence'); expect((await configureEnv({ ...bindings, LIFECYCLE_MODE: 'test' })).LIFECYCLE_MODE).toBe('test'); expect((await configureEnv({ ...bindings, LIFECYCLE_MODE: 'off' })).LIFECYCLE_MODE).toBe('off'); });

it.each(['fixed', 'unbounded'] as const)('emits one UTC dispatcher tick only for operational %s config', async kind => {
  const operational = await renderConfig(instance, CHICAGO_OPERATIONS, kind, '/tmp/synthetic.ts', 'operational');
  expect(operational.text).toContain('crons = ["*/5 * * * *"]');
  const shadow = await renderConfig({ ...instance, shadowMode: true }, CHICAGO_OPERATIONS, kind, '/tmp/synthetic.ts', 'operational');
  expect(shadow.text).toContain('crons = []');
});
it('refuses generated Workflow names exceeding the provider limit', async () => {
  const invalid = { ...instance, cloudflare: { ...instance.cloudflare, unboundedWorkerName: 'x'.repeat(63) } };
  await expect(renderConfig(invalid, CHICAGO_OPERATIONS, 'unbounded', '/tmp/synthetic.ts', 'operational')).rejects.toThrow('WORKFLOW_NAME_TOO_LONG');
});
