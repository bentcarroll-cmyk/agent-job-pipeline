import { it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {
        constructor(_ctx: unknown, public env: unknown) { }
    } }));
import fixed, { AgentWorkflow } from '../../src/index';
import unbounded, { UnboundedAgentWorkflow } from '../../src/unbounded/index';
import { ManualIntakeWorkflow } from '../../src/intake/workflow';
import { LifecycleWorkflow } from '../../src/lifecycle/workflow';
import { RadarWorkflow } from '../../src/radar/workflow';
import { renderConfig } from '../../tools/setup/render-config';
import { CHICAGO_OPERATIONS } from '../fixtures/candidates';
const instance = JSON.parse(readFileSync(new URL('../../examples/instance.json', import.meta.url), 'utf8'));
it.each([AgentWorkflow, UnboundedAgentWorkflow, ManualIntakeWorkflow, LifecycleWorkflow, RadarWorkflow])('preview projection blocks real workflow entry before provider or ledger operations', async (Worker) => { const { bindings } = await renderConfig(instance, CHICAGO_OPERATIONS, 'unbounded', '/tmp/synthetic.ts', 'preview'); const worker = new Worker({} as any, bindings as any); await expect(worker.run({ instanceId: 'synthetic', payload: {} } as any, {} as any)).resolves.toBeDefined(); });
it('preview HTTP and scheduled entry points cannot trigger operations or Slack actions', async () => { const { bindings } = await renderConfig(instance, CHICAGO_OPERATIONS, 'unbounded', '/tmp/synthetic.ts', 'preview'); for (const entry of [fixed, unbounded]) {
    expect((await entry.fetch(new Request('https://example.test/slack/actions', { method: 'POST' }), bindings as any, {} as any)).status).toBe(503);
    await expect(entry.scheduled({ cron: 'synthetic' } as any, bindings as any)).resolves.toBeUndefined();
} });
it('disabled lifecycle cannot launch a manual workflow despite a legacy live flag', async () => {
  const {bindings}=await renderConfig(instance,CHICAGO_OPERATIONS,'unbounded','/tmp/synthetic.ts','operational');
  const result=await unbounded.fetch(new Request('https://example.test/?workflow=lifecycle',{method:'POST',headers:{authorization:'Bearer synthetic'}}),{...bindings,TRIGGER_SECRET:'synthetic',LIFECYCLE_MODE:'live'} as any,{} as any);
  expect(result.status).toBe(403);
});
