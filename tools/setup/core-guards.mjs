import { mkdir, open, rename, unlink, lstat, realpath, readdir } from 'node:fs/promises';
import { join, dirname, relative, isAbsolute, sep, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
export class SetupError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'SetupError';
    }
}
export function isOutside(base, target) {
    const rel = relative(base, target);
    return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
}
/** Validate every existing component before creating anything; owned destinations cannot be links. */
export async function guardedPath(root, path, kind, create = false) {
    const base = await realpath(root);
    const target = isOutside(base, resolve(path)) ? resolve(base, relative(resolve(root), resolve(path))) : resolve(path);
    if (target === base || isOutside(base, target))
        throw new SetupError('UNSAFE_SETUP_PATH');
    const segments = relative(base, target).split(sep);
    let current = base;
    for (let i = 0; i < segments.length; i++) {
        current = join(current, segments[i]);
        const directory = i < segments.length - 1 || kind === 'directory';
        let info;
        try {
            info = await lstat(current);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            if (directory && create) {
                await mkdir(current, { mode: 0o700 });
                info = await lstat(current);
            }
            else
                continue;
        }
        if (info && (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())))
            throw new SetupError('UNSAFE_SETUP_PATH');
    }
    return target;
}
export async function setupDirectory(root) {
    const path = join(root, '.setup');
    // Keep the public top-level error while guarding all parents and nested destinations too.
    try {
        await guardedPath(root, path, 'directory', true);
    }
    catch (error) {
        if (error instanceof SetupError)
            throw new SetupError('UNSAFE_SETUP_DIRECTORY');
        throw error;
    }
    if ((await lstat(path)).mode & 0o077)
        throw new SetupError('UNSAFE_SETUP_DIRECTORY');
    return path;
}
export async function setupPath(root, relativePath, kind = 'file', create = false) {
    const base = await setupDirectory(root);
    const target = resolve(base, relativePath);
    if (target === base || isOutside(base, target))
        throw new SetupError('UNSAFE_SETUP_PATH');
    return guardedPath(root, target, kind, create);
}
/** Before subprocesses, inspect all existing mutable content, including dependency cache links. */
export async function validateSetupTree(root) {
    const base = await realpath(await setupDirectory(root));
    async function visit(path) {
        const info = await lstat(path);
        if (info.isSymbolicLink()) {
            let target;
            try {
                target = await realpath(path);
            }
            catch {
                throw new SetupError('UNSAFE_SETUP_PATH');
            }
            if (isOutside(base, target))
                throw new SetupError('UNSAFE_SETUP_PATH');
            return; // Every target is also visited by its physical path under base.
        }
        if (info.isDirectory()) {
            for (const name of await readdir(path))
                await visit(join(path, name));
        }
        else if (!info.isFile())
            throw new SetupError('UNSAFE_SETUP_PATH');
    }
    await visit(base);
}
/** Never steals a lock: a crashed process needs explicit operator recovery after verifying it stopped. */
export async function withWorkspaceLock(root, operation) {
    const path = await setupPath(root, 'lock');
    let handle;
    try {
        handle = await open(path, 'wx', 0o600);
    }
    catch (e) {
        if (e.code === 'EEXIST')
            throw new SetupError('SETUP_LOCKED');
        throw e;
    }
    try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
        await handle.sync();
        return await operation();
    }
    finally {
        await handle.close();
        await unlink(path);
    }
}
export async function atomicPrivateWrite(root, path, data) {
    path = await guardedPath(root, path, 'file');
    const temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try {
        await file.writeFile(data);
        await file.sync();
        await file.close();
        await rename(temp, path);
        const directory = await open(dirname(path), 'r');
        try {
            await directory.sync();
        }
        finally {
            await directory.close();
        }
    }
    catch (e) {
        await file.close().catch(() => { });
        await unlink(temp).catch(() => { });
        throw e;
    }
}
async function canonicalFuture(path) {
    try {
        return await realpath(path);
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
        return join(await canonicalFuture(dirname(path)), path.slice(dirname(path).length + 1));
    }
}
export async function assertWorkspace(root, sources) {
    if (!isAbsolute(root))
        throw new SetupError('ABSOLUTE_WORKSPACE_REQUIRED');
    const actual = await canonicalFuture(resolve(root));
    for (const source of sources) {
        const base = await canonicalFuture(resolve(source));
        if (!isOutside(base, actual))
            throw new SetupError('WORKSPACE_INSIDE_SOURCE');
    }
    return actual;
}
export async function privatePath(root, path) {
    const base = await realpath(root);
    const target = await realpath(resolve(root, path));
    const rel = relative(base, target);
    if (!rel || isOutside(base, target))
        throw new SetupError('PATH_OUTSIDE_WORKSPACE');
    return target;
}

/** Locked Wrangler prefers legacy global state over XDG; inspect its entry only. */
export async function assertWranglerIsolation(userHome = homedir()) {
    try { await lstat(join(userHome, '.wrangler')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw new SetupError('AMBIENT_WRANGLER_CONFIG_UNISOLATED');
}
/** Explicit credential only; no inherited config, auth, proxy, telemetry or log settings. */
export async function isolatedWranglerEnvironment(root, token) {
    if (typeof token !== 'string' || !token.trim()) throw new SetupError('EXPLICIT_PROVIDER_TOKEN_REQUIRED');
    await assertWranglerIsolation();
    await validateSetupTree(root);
    return { PATH: process.env.PATH, HOME: process.env.HOME,
        XDG_CONFIG_HOME: await setupPath(root, 'xdg', 'directory', true),
        XDG_CACHE_HOME: await setupPath(root, 'xdg-cache', 'directory', true),
        WRANGLER_CACHE_DIR: await setupPath(root, 'wrangler-cache', 'directory', true),
        WRANGLER_LOG_PATH: await setupPath(root, 'wrangler-logs', 'directory', true),
        TMPDIR: await setupPath(root, 'tmp', 'directory', true),
        CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_AUTH_USE_KEYRING: 'false',
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', WRANGLER_SEND_METRICS: 'false',
        WRANGLER_SEND_ERROR_REPORTS: 'false', DO_NOT_TRACK: '1', CI: 'true' };
}
