import { it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSetupState, saveSetupReceipt, withWorkspaceLock } from '../../tools/setup/state';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true }); });
async function workspace() { const p = await mkdtemp(join(tmpdir(), 'setup-state-')); roots.push(p); return p; }
const receipt = { schemaVersion: 1 as const, instanceId: 'synthetic', stage: 'preflight' as const, status: 'complete' as const, fingerprint: 'a'.repeat(64), resourceIds: {}, errorCode: null };
it('persists private atomic receipts and replaces only the same stage', async () => { const root = await workspace(); await saveSetupReceipt(root, receipt); await saveSetupReceipt(root, { ...receipt, stage: 'workspace' }); await saveSetupReceipt(root, { ...receipt, status: 'blocked', errorCode: 'CAPABILITY_MISSING' }); expect(await loadSetupState(root)).toHaveLength(2); expect((await loadSetupState(root))[0].status).toBe('blocked'); expect((await stat(join(root, '.setup/state.json'))).mode & 0o777).toBe(0o600); expect(JSON.parse(await readFile(join(root, '.setup/state.json'), 'utf8'))).toHaveLength(2); });
it('rejects duplicate setup processes without stealing the active lock', async () => { const root = await workspace(); await withWorkspaceLock(root, async () => { await expect(withWorkspaceLock(root, async () => { })).rejects.toThrow('SETUP_LOCKED'); }); await withWorkspaceLock(root, async () => { }); });
it('rejects receipt drift across instance identities', async () => { const root = await workspace(); await saveSetupReceipt(root, receipt); await expect(saveSetupReceipt(root, { ...receipt, instanceId: 'other' })).rejects.toThrow('INSTANCE_MISMATCH'); });
