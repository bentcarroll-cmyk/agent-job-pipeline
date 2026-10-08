// Shared core guards are usable before private TypeScript dependencies exist.
export {isOutside,guardedPath,setupDirectory,setupPath,validateSetupTree,withWorkspaceLock,atomicPrivateWrite} from './core-guards.mjs';
import {setupPath,withWorkspaceLock,atomicPrivateWrite} from './core-guards.mjs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {SetupReceipt} from './types';
import {SetupError} from './types';
function validateReceipt(value: SetupReceipt): void {
    if (value.schemaVersion !== 1 || !/^[-a-z0-9]{1,63}$/.test(value.instanceId) ||
        !['preflight', 'workspace', 'profile', 'accounts', 'resources', 'preview', 'activation'].includes(value.stage) ||
        !['pending', 'complete', 'blocked'].includes(value.status) || !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
        !value.resourceIds || Object.values(value.resourceIds).some(v => typeof v !== 'string') ||
        !(value.errorCode === null || /^[A-Z0-9_]+$/.test(value.errorCode)))
        throw new SetupError('INVALID_SETUP_RECEIPT');
}
export async function loadSetupState(root: string): Promise<readonly SetupReceipt[]> {
    try {
        const values: SetupReceipt[] = JSON.parse(await readFile(await setupPath(root, 'state.json'), 'utf8'));
        if (!Array.isArray(values))
            throw new SetupError('INVALID_SETUP_STATE');
        values.forEach(validateReceipt);
        return values;
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT')
            return [];
        throw e;
    }
}
/** For orchestration already holding the workspace lock. */
export async function saveLockedReceipt(root: string, receipt: SetupReceipt): Promise<void> {
    validateReceipt(receipt);
    const prior = await loadSetupState(root);
    if (prior.some(r => r.instanceId !== receipt.instanceId))
        throw new SetupError('INSTANCE_MISMATCH');
    const next = [...prior];
    const i = next.findIndex(r => r.stage === receipt.stage);
    if (i < 0)
        next.push(receipt);
    else
        next[i] = receipt;
    await atomicPrivateWrite(root, join(root, '.setup/state.json'), JSON.stringify(next, null, 2) + '\n');
}
export async function saveSetupReceipt(root: string, receipt: SetupReceipt): Promise<void> { await withWorkspaceLock(root, () => saveLockedReceipt(root, receipt)); }
