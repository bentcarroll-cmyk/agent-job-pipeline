import { it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, realpath, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { assertWorkspace, loadApprovedProfile, checkCapabilities } from '../../tools/setup/preflight';
import { CHICAGO_OPERATIONS } from '../fixtures/candidates';
const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0))
    await rm(r, { recursive: true, force: true }); });
async function root() { const r = await mkdtemp(join(tmpdir(), 'setup-check-')); roots.push(r); return r; }
it('rejects checkout descendants and symlink aliases before creating files', async () => { const r = await root(); const source = join(r, 'source'); await mkdir(source); await symlink(source, join(r, 'alias')); await expect(assertWorkspace(join(r, 'alias', 'private'), [source])).rejects.toThrow('WORKSPACE_INSIDE_SOURCE'); await expect(assertWorkspace(source, [source])).rejects.toThrow('WORKSPACE_INSIDE_SOURCE'); expect(await assertWorkspace(join(r, 'private'), [source])).toBe(join(await realpath(r), 'private')); });
it('rehashes actual readable bytes and rejects changed candidate approval', async () => { const r = await root(); const readable = 'Synthetic reviewed criteria\n'; const c = structuredClone(CHICAGO_OPERATIONS); c.approval.readableSha256 = createHash('sha256').update(readable).digest('hex'); await writeFile(join(r, 'criteria.md'), readable); await writeFile(join(r, 'candidate.json'), JSON.stringify(c)); expect((await loadApprovedProfile(r)).criteriaVersion).toBe(c.approval.configSha256); await writeFile(join(r, 'criteria.md'), readable + 'changed'); await expect(loadApprovedProfile(r)).rejects.toThrow('READABLE_APPROVAL_MISMATCH'); await writeFile(join(r, 'criteria.md'), readable); c.search.openWebPhrases = [...c.search.openWebPhrases, 'changed']; await writeFile(join(r, 'candidate.json'), JSON.stringify(c)); await expect(loadApprovedProfile(r)).rejects.toThrow(/approval/i); });
it('reports missing Node, Python, document and font capabilities explicitly', async () => { const report = await checkCapabilities({ node: '18.1.0', python: '3.10.0', documents: false, fonts: false, platform: 'darwin' }); expect(report).toEqual(['NODE_22_REQUIRED', 'PYTHON_312_REQUIRED', 'DOCUMENT_CAPABILITY_MISSING', 'FONT_CAPABILITY_MISSING']); });

it('material lock pins every measured transitive dependency and retains direct intent',async()=>{const lock=await readFile(new URL('../../tools/materials/requirements-macos-py312.lock',import.meta.url),'utf8');const entries=lock.split(/\n/).filter(line=>line&&!line.startsWith('#'));expect(entries.length).toBeGreaterThan(10);expect(entries.every(line=>/^[a-zA-Z0-9_.-]+==[a-zA-Z0-9_.-]+$/.test(line))).toBe(true);const direct=(await readFile(new URL('../../tools/materials/requirements.txt',import.meta.url),'utf8')).trim().split(/\n/);for(const item of direct)expect(entries).toContain(item);expect(entries.some(line=>/yaml|skill/i.test(line))).toBe(false);});
