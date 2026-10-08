export class SetupError extends Error {code: string; constructor(code: string);}
export function isOutside(base: string, target: string): boolean;
export function guardedPath(root: string, path: string, kind: 'file'|'directory', create?: boolean): Promise<string>;
export function setupDirectory(root: string): Promise<string>;
export function setupPath(root: string, relativePath: string, kind?: 'file'|'directory', create?: boolean): Promise<string>;
export function validateSetupTree(root: string): Promise<void>;
export function withWorkspaceLock<T>(root: string, operation: () => Promise<T>): Promise<T>;
export function atomicPrivateWrite(root: string, path: string, data: string|Buffer): Promise<void>;
export function assertWorkspace(root: string, sources: readonly string[]): Promise<string>;
export function privatePath(root: string, path: string): Promise<string>;
export function assertWranglerIsolation(userHome?: string): Promise<void>;
export function isolatedWranglerEnvironment(root: string, token: string): Promise<NodeJS.ProcessEnv & {TMPDIR: string}>;
