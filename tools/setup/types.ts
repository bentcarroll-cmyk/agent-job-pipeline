export type SetupStage = 'preflight' | 'workspace' | 'profile' | 'accounts' | 'resources' | 'preview' | 'activation';
export type SetupReceipt = {
    schemaVersion: 1;
    instanceId: string;
    stage: SetupStage;
    status: 'pending' | 'complete' | 'blocked';
    fingerprint: string;
    resourceIds: Record<string, string>;
    errorCode: string | null;
};
export type ResourceKind = 'database' | 'fixed_worker' | 'unbounded_worker' | 'gateway';
export type ResourceRecord = {
    kind: ResourceKind;
    id: string;
    name: string;
    instanceId: string;
    accountId: string;
};
export interface ResourceAdapter {
    list(kind: ResourceKind, accountId: string): Promise<readonly ResourceRecord[]>;
    create(input: Omit<ResourceRecord, 'id'>): Promise<ResourceRecord>;
    read(kind: ResourceKind, id: string, accountId: string): Promise<ResourceRecord | null>;
    applyMigrations(input: {
        databaseId: string;
        accountId: string;
        migrationIds: readonly string[];
    }): Promise<{
        appliedIds: readonly string[];
    }>;
}
export {SetupError} from './core-guards.mjs';
