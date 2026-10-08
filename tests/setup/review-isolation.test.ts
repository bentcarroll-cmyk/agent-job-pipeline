import { it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, symlink, writeFile, readFile, rm, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const calls = vi.hoisted(() => [] as Array<{
    args: string[];
    options: any;
}>);
vi.mock('node:child_process', () => ({ execFile: Object.assign(() => { }, { [Symbol.for('nodejs.util.promisify.custom')]: async (_file: string, args: string[], options: any) => { calls.push({ args, options }); return { stdout: '3.12.14\n', stderr: '' }; } }) }));
import { assertWorkspace, privatePath, prepareDependencies } from '../../tools/setup/preflight';
import { dryRunBuild, previewWorkspace, releaseRoot, assertWranglerIsolation } from '../../tools/setup/cli';
import { loadRuntimeConfig } from '../../src/config/candidate';
import { CHICAGO_OPERATIONS } from '../fixtures/candidates';
import { createResourcePlan, ensureResources, FakeResourceAdapter, loadResourcePlan, WranglerResourceAdapter, verifyResources } from '../../tools/setup/resources';
import { validateSetupTree, atomicPrivateWrite, loadSetupState } from '../../tools/setup/state';
const roots: string[] = [];
afterEach(async () => { calls.length = 0; for (const r of roots.splice(0))
    await rm(r, { recursive: true, force: true }); });
async function root() { const r = await mkdtemp(join(tmpdir(), 'setup-review-')); roots.push(r); return realpath(r); }
async function instance() { return JSON.parse(await readFile(new URL('../../examples/instance.json', import.meta.url), 'utf8')); }
it('I1 rejects two-dot child segments and aliases but permits private two-dot files', async () => { const r = await root(); const source = join(r, 'source'); await mkdir(source); await symlink(source, join(r, 'alias')); for (const p of [join(source, '..private'), join(r, 'alias', '..private')])
    await expect(assertWorkspace(p, [source])).rejects.toThrow('WORKSPACE_INSIDE_SOURCE'); await writeFile(join(r, '..private'), 'synthetic'); expect(await privatePath(r, '..private')).toContain('..private'); });
it.each(['generated', 'build/fixed', 'wrangler-cache', 'dependencies'])('I2 rejects external nested directory %s before writes or subprocesses', async (name) => { const r = await root(), outside = await root(); await mkdir(join(r, '.setup', name.split('/').slice(0, -1).join('/')), { recursive: true, mode: 0o700 }); await symlink(outside, join(r, '.setup', name)); const config = await instance(); if (name === 'generated')
    await expect(previewWorkspace(r, config, await loadRuntimeConfig(CHICAGO_OPERATIONS), async () => { })).rejects.toThrow('UNSAFE_SETUP_PATH');
else if (name === 'dependencies')
    await expect(prepareDependencies(r, releaseRoot, '/synthetic/python')).rejects.toThrow('UNSAFE_SETUP_PATH');
else
    await expect(dryRunBuild(r, join(r, '.setup/config.toml'), 'fixed')).rejects.toThrow('UNSAFE_SETUP_PATH'); expect(calls).toHaveLength(0); expect(await readdir(outside)).toEqual([]); });
it.each(['dependencies/package.json', 'npmrc', 'state.json'])('I2 rejects external setup file %s without overwriting it', async (name) => { const r = await root(), outside = await root(); await mkdir(join(r, '.setup', name.split('/').slice(0, -1).join('/')), { recursive: true, mode: 0o700 }); const file = join(outside, 'protected'); await writeFile(file, 'protected'); await symlink(file, join(r, '.setup', name)); await expect(prepareDependencies(r, releaseRoot, '/synthetic/python')).rejects.toThrow('UNSAFE_SETUP_PATH'); expect(await readFile(file, 'utf8')).toBe('protected'); expect(calls).toHaveLength(0); });
it('I3 preserves HOME and isolates offline Wrangler config/cache/auth in the actual subprocess', async () => { const r = await root(); await mkdir(join(r, '.setup'), { mode: 0o700 }); const config = join(r, '.setup/config.toml'); await writeFile(config, 'synthetic'); await dryRunBuild(r, config, 'fixed'); const { options, args } = calls[0]; expect(options.env.HOME).toBe(process.env.HOME); expect(options.env.WRANGLER_CACHE_DIR).toBe(join(r, '.setup/wrangler-cache')); expect(options.env.WRANGLER_LOG_PATH).toBe(join(r, '.setup/wrangler-logs')); expect(options.env.CLOUDFLARE_API_TOKEN).toBe('offline-build-no-provider-authorization'); expect(args).toContain('--env-file'); expect(options.env.WRANGLER_SEND_ERROR_REPORTS).toBe('false'); });
it('I3 preserves HOME for dependency subprocesses and disables ambient npm/pip config', async () => { const r = await root(); await prepareDependencies(r, releaseRoot, '/synthetic/python').catch(() => { }); expect(calls.length).toBeGreaterThan(2); for (const { options } of calls) {
    expect(options.env.HOME).toBe(process.env.HOME);
    expect(options.env.PIP_CONFIG_FILE).toBe('/dev/null');
    expect(options.env.NPM_CONFIG_GLOBALCONFIG).toBe(join(r, '.setup/npm-globalrc'));
} expect(calls.some(c => c.args.includes('--copies'))).toBe(true); expect(calls.some(c => c.args.includes('--cache-dir'))).toBe(true); });
it('I4 rejects generated-name plus UUID binding growth before any provider action on fresh and resumed plans', async () => { const r = await root(); const raw = await instance(); raw.cloudflare.databaseId = null; raw.radar.topics = ['x']; raw.radar.topics[0] = 'x'.repeat(5100 - Buffer.byteLength(JSON.stringify(raw)) + 1); expect(Buffer.byteLength(JSON.stringify(raw))).toBe(5100); const plan = await createResourcePlan(r, raw); for (const p of [plan, await loadResourcePlan(r)]) {
    const adapter = new FakeResourceAdapter(r, p);
    const list = vi.spyOn(adapter, 'list');
    await expect(ensureResources(p.instance, adapter)).rejects.toThrow('INSTANCE_BINDING_TOO_LARGE');
    expect(list).not.toHaveBeenCalled();
    expect(adapter.records).toHaveLength(0);
} });
it('I3 fails closed when Wrangler legacy config would override private XDG without reading it', async () => { const r = await root(); await mkdir(join(r, '.wrangler')); await writeFile(join(r, '.wrangler', 'metrics.json'), 'do not read'); await expect(assertWranglerIsolation(r)).rejects.toThrow('AMBIENT_WRANGLER_CONFIG_UNISOLATED'); expect(calls).toHaveLength(0); });
it('I2 permits contained dependency executable links but rejects direct linked writes and state reads', async () => { const r = await root(); await mkdir(join(r, '.setup/dependencies/bin'), { recursive: true, mode: 0o700 }); const file = join(r, '.setup/dependencies/bin/tool'); await writeFile(file, 'synthetic'); const link = join(r, '.setup/dependencies/tool'); await symlink('bin/tool', link); await validateSetupTree(r); await expect(atomicPrivateWrite(r, link, 'changed')).rejects.toThrow('UNSAFE_SETUP_PATH'); await symlink(file, join(r, '.setup/state.json')); await expect(loadSetupState(r)).rejects.toThrow('UNSAFE_SETUP_PATH'); expect(await readFile(file, 'utf8')).toBe('synthetic'); });
it('I4 validates oversized operational readbacks and direct real adapter construction before provider access', async () => { const r = await root(); const raw = await instance(); raw.radar.topics = ['x'.repeat(5200)]; const request = vi.fn(); expect(() => new WranglerResourceAdapter(r, { schemaVersion: 1, instance: raw, intents: [] }, request, releaseRoot)).toThrow('INSTANCE_BINDING_TOO_LARGE'); const adapter = new FakeResourceAdapter(r, { schemaVersion: 1, instance: raw, intents: [] }); const list = vi.spyOn(adapter, 'list'); await expect(verifyResources(raw, adapter)).rejects.toThrow('INSTANCE_BINDING_TOO_LARGE'); expect(list).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled(); });
