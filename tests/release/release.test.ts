import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { prepare, assertPublishable, REQUIRED_CHECKS, validateHostedChecks } from '../../scripts/release';
import { packageRelease } from '../../scripts/package-release';
import { sha256 } from '../../scripts/release-format';
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0))
    await rm(r, { recursive: true, force: true }); });
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
async function fixture(channel: 'stable' | 'beta' = 'stable') {
    const base = await mkdtemp(join(tmpdir(), 'synthetic-publish-'));
    roots.push(base);
    const root = join(base, 'root');
    await mkdir(root);
    const manifest = JSON.parse(await readFile(new URL('../../.release/public-manifest.json', import.meta.url), 'utf8'));
    for (const p of manifest.files) {
        await mkdir(join(root, p, '..'), { recursive: true });
        await writeFile(join(root, p), 'synthetic content');
    }
    await writeFile(join(root, '.release/public-manifest.json'), JSON.stringify(manifest));
    await writeFile(join(root, 'package.json'), JSON.stringify({version:channel==='beta'?'0.1.0-beta.1':'0.1.0'}));
    git(root, 'init', '-b', 'main');
    git(root, 'add', '.');
    git(root, '-c', 'user.name=Synthetic Release', '-c', 'user.email=release@example.invalid', 'commit', '-m', 'Initial release');
    const sha = git(root, 'rev-parse', 'HEAD');
    const evidence = join(base, 'evidence.json');
    await writeFile(evidence, JSON.stringify({ schemaVersion: 1, checks: REQUIRED_CHECKS.map(name => ({ name, status: 'passed', candidateSha: sha, evidenceSha256: 'a'.repeat(64) })) }));
    const output = join(base, 'out');
    const receipt = await prepare({ root, output, evidence, channel } as any);
    const receiptPath = join(output, 'candidate.json');
    const approval = join(base, 'approval.json');
    await writeFile(approval, JSON.stringify({ schemaVersion: 1, approved: true, candidateReceiptSha256: sha256(await readFile(receiptPath)), reviewedAt: '2026-10-08T12:00:00Z' }));
    return { base, root, sha, evidence, output, receipt, receiptPath, approval };
}
it('binds exact archive, fresh Git tree, platform and results to a reviewable candidate', async () => {
    const f = await fixture();
    expect(f.receipt.version).toBe('v0.1.0');
    expect(f.receipt.candidateSha).toBe(f.sha);
    expect(f.receipt.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(f.receipt.platforms).toEqual(['macos-arm64']);
    await expect(assertPublishable(f)).resolves.toMatchObject({ candidateSha: f.sha });
});
it.each(['pending', 'failed'])('refuses %s required checks even with reviewed receipt', async (status) => {
    const f = await fixture();
    const e = JSON.parse(await readFile(f.evidence, 'utf8'));
    e.checks[0].status = status;
    await writeFile(f.evidence, JSON.stringify(e));
    await prepare({ root: f.root, output: join(f.base, 'next'), evidence: f.evidence });
    f.receiptPath = join(f.base, 'next', 'candidate.json');
    await writeFile(f.approval, JSON.stringify({ schemaVersion: 1, approved: true, candidateReceiptSha256: sha256(await readFile(f.receiptPath)), reviewedAt: '2026-10-08T12:00:00Z' }));
    await expect(assertPublishable(f)).rejects.toThrow('REQUIRED_CHECK_NOT_PASSED');
});
it('refuses a moved candidate HEAD before publication', async () => { const f = await fixture(); git(f.root, '-c', 'user.name=Synthetic Release', '-c', 'user.email=release@example.invalid', 'commit', '--allow-empty', '-m', 'Moved'); await expect(assertPublishable(f)).rejects.toThrow('CANDIDATE_MOVED'); });
it('refuses changed archive bytes despite an old approval', async () => { const f = await fixture(); await writeFile(join(f.output, 'agent-job-pipeline.tar.gz'), 'changed'); await expect(assertPublishable(f)).rejects.toThrow('ARCHIVE_VERIFICATION_FAILED'); });
it('refuses modified candidate receipts without renewed immutable review', async () => { const f = await fixture(); const receipt = JSON.parse(await readFile(f.receiptPath, 'utf8')); receipt.checks[0].evidenceSha256 = 'b'.repeat(64); await writeFile(f.receiptPath, JSON.stringify(receipt)); await expect(assertPublishable(f)).rejects.toThrow('CANDIDATE_REVIEW_STALE'); });
it('rejects stale or missing check evidence at prepare', async () => { const f = await fixture(); const e = JSON.parse(await readFile(f.evidence, 'utf8')); e.checks[0].candidateSha = 'b'.repeat(40); await writeFile(f.evidence, JSON.stringify(e)); await expect(prepare({ root: f.root, output: join(f.base, 'next'), evidence: f.evidence })).rejects.toThrow('CHECK_EVIDENCE_INVALID'); });
it('rejects source history and extra untracked files rather than publishing them', async () => { const f = await fixture(); await writeFile(join(f.root, 'unexpected.txt'), 'synthetic'); await expect(prepare({ root: f.root, output: join(f.base, 'next'), evidence: f.evidence })).rejects.toThrow('CANDIDATE_DIRTY'); });
it('rejects an archive checksum binding changed inside an independently reapproved receipt', async () => { const f = await fixture(); const receipt = JSON.parse(await readFile(f.receiptPath, 'utf8')); receipt.archiveSha256 = 'b'.repeat(64); await writeFile(f.receiptPath, JSON.stringify(receipt)); await writeFile(f.approval, JSON.stringify({ schemaVersion: 1, approved: true, candidateReceiptSha256: sha256(await readFile(f.receiptPath)), reviewedAt: '2026-10-08T12:00:00Z' })); await expect(assertPublishable(f)).rejects.toThrow('CANDIDATE_CONTENT_MISMATCH'); });
it.each(['queued', 'failure', 'wrong-sha', 'absent', 'truncated', 'wrong-app'])('refuses hosted CI %s', kind => {
    const sha = 'a'.repeat(40);
    const check = { name: 'macos-local-runtime', head_sha: sha, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } };
    if (kind === 'queued')
        check.status = 'queued';
    if (kind === 'failure')
        check.conclusion = 'failure';
    if (kind === 'wrong-sha')
        check.head_sha = 'b'.repeat(40);
    if (kind === 'wrong-app')
        check.app.slug = 'synthetic-app';
    const checks = kind === 'absent' ? [] : [check];
    expect(() => validateHostedChecks({ total_count: kind === 'truncated' ? 101 : checks.length, check_runs: checks }, sha)).toThrow();
});
it('accepts observed matching completed successful GitHub Actions checks', () => expect(() => validateHostedChecks({ total_count: 1, check_runs: [{ name: 'macos-local-runtime', head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }] }, 'a'.repeat(40))).not.toThrow());
it('rejects a valid rehashed archive whose content differs from the committed candidate', async () => {
    const f = await fixture();
    const original = await readFile(join(f.root, 'README.md'));
    await writeFile(join(f.root, 'README.md'), 'different synthetic archive content');
    const archive = await packageRelease(f.root, join(f.root, '.release/public-manifest.json'), f.output);
    await writeFile(join(f.root, 'README.md'), original);
    const c = JSON.parse(await readFile(f.receiptPath, 'utf8'));
    c.archiveSha256 = archive.sha256;
    await writeFile(f.receiptPath, JSON.stringify(c));
    await writeFile(f.approval, JSON.stringify({ schemaVersion: 1, approved: true, candidateReceiptSha256: sha256(await readFile(f.receiptPath)), reviewedAt: '2026-10-08T12:00:00Z' }));
    await expect(assertPublishable(f)).rejects.toThrow('ARCHIVE_TREE_MISMATCH');
});
it('preserves an existing candidate output instead of overwriting reviewed assets', async () => { const f = await fixture(); await expect(prepare({ root: f.root, output: f.output, evidence: f.evidence })).rejects.toThrow('OUTPUT_MUST_BE_FRESH'); expect(sha256(await readFile(join(f.output, 'agent-job-pipeline.tar.gz')))).toBe(f.receipt.archiveSha256); });
it.each(['clean', 'foreign-ref', 'extra-asset', 'wrong-checksum', 'tag-deleted-release', 'missing-asset', 'duplicate-asset', 'late-asset', 'replaced-release', 'final-extra-release', 'edited-notes', 'replaced-asset', 'missing-release', 'duplicate-release', 'beta-clean', 'beta-created-stable', 'beta-late-stable', 'beta-final-stable'])('keeps publication limited to reviewed remote inventory: %s', async (kind) => {
    const f = await fixture(kind.startsWith('beta-')?'beta':'stable');
    const bin = join(f.base, 'bin'); await mkdir(bin);
    const transport = join(bin, 'gh');
    await writeFile(join(f.base, 'remote.json'), JSON.stringify({sha:f.sha, private:true, tagged:false, draft:null, calls:[],extraRef:kind==='foreign-ref',kind,version:f.receipt.version,beta:kind.startsWith('beta-'),inventoryReads:0}));
    await writeFile(transport, `#!/usr/bin/env node
const fs=require('fs'),p=require('path'),dir=process.env.SYNTHETIC_GH_DIR;
const path=p.join(dir,'remote.json'),state=JSON.parse(fs.readFileSync(path)),a=process.argv.slice(2);
state.calls.push(a);let result=null;
const assets=()=>{
 const list=[{name:'agent-job-pipeline.tar.gz',id:1},{name:'agent-job-pipeline.tar.gz.sha256',id:2}];
 if(state.kind==='extra-asset'||(state.kind==='late-asset'&&state.inventoryReads>=4))list.push({name:'UNREVIEWED.txt',id:3});
 if(state.kind==='missing-asset')list.pop();
 if(state.kind==='duplicate-asset')list[1]={...list[0]};
 if(state.kind==='replaced-asset'&&state.inventoryReads>=4)list[1].id=99;
 return list;
};
const release=()=>({id:state.kind==='replaced-release'&&state.inventoryReads>=4?99:10,tag_name:state.version,name:state.version,prerelease:state.beta&&!(state.kind==='beta-created-stable'||(state.kind==='beta-late-stable'&&state.inventoryReads>=4)||(state.kind==='beta-final-stable'&&state.draft===false)),body:state.kind==='edited-notes'&&state.inventoryReads>=4?'UNREVIEWED prose':'synthetic content',draft:state.draft,html_url:'https://example.invalid/release/v0.1.0',assets:assets()});
const unrelated=()=>({id:20,tag_name:'deleted-tag',draft:false,assets:[{name:'UNREVIEWED.txt',id:30}]});
if(a[0]==='api'){
 const q=a[1],base='repos/bentcarroll-cmyk/agent-job-pipeline';
 if(q===base)result={full_name:'bentcarroll-cmyk/agent-job-pipeline',private:state.private,default_branch:'main'};
 else if(q===base+'/git/ref/heads/main')result={object:{sha:state.sha}};
 else if(q.includes('/check-runs?'))result={total_count:1,check_runs:[{name:'macos-local-runtime',head_sha:state.sha,status:'completed',conclusion:'success',app:{slug:'github-actions'}}]};
 else if(q===base+'/git/matching-refs/')result=[{ref:'refs/heads/main',object:{type:'commit',sha:state.sha}},...(state.tagged?[{ref:'refs/tags/'+state.version,object:{type:'commit',sha:state.sha}}]:[]),...(state.extraRef?[{ref:'refs/heads/unreviewed',object:{type:'commit',sha:'b'.repeat(40)}}]:[])];
 else if(q.includes('/git/matching-refs/'))result=state.tagged?[{ref:'refs/tags/'+state.version}]:[];
 else if(q===base+'/releases?per_page=100'){state.inventoryReads++;result=state.draft===null?[]:[release()];if(state.inventoryReads>=3&&state.kind==='missing-release')result=[];if(state.inventoryReads>=3&&state.kind==='duplicate-release')result.push(release());if(state.kind==='tag-deleted-release'||(state.kind==='final-extra-release'&&state.draft===false))result.push(unrelated());}
 else if(q===base+'/releases'&&a.includes('POST')){if(!state.private||!state.tagged||!a.includes('draft=true'))process.exit(24);if(state.beta&&(!a.includes('prerelease=true')||!a.includes('make_latest=false')))process.exit(29);state.draft=true;result=release();}
 else if(q===base+'/releases/10'&&a.includes('PATCH')){if(state.private||!a.includes('draft=false')||(state.beta&&(!a.includes('prerelease=true')||!a.includes('make_latest=false'))))process.exit(29);state.draft=false;result=release();}
 else if(q===base+'/releases/10/assets?per_page=100')result=assets();
 else if(q===base+'/git/refs'&&a.includes('POST')){if(!a.includes('sha='+state.sha))process.exit(22);state.tagged=true;result={};}
 else if(q===base+'/git/ref/tags/'+state.version)result={object:{sha:state.sha}};
 else if(q===base+'/releases/tags/'+state.version){if(state.draft!==false)process.exit(44);result=release();}
 else if(q===base+'/releases/assets/1'){fs.writeFileSync(path,JSON.stringify(state));process.stdout.write(fs.readFileSync(p.join(dir,'out','agent-job-pipeline.tar.gz')));process.exit(0);}
 else if(q===base+'/releases/assets/2'){fs.writeFileSync(path,JSON.stringify(state));process.stdout.write(state.kind==='wrong-checksum'?'wrong checksum bytes':fs.readFileSync(p.join(dir,'out','agent-job-pipeline.tar.gz.sha256')));process.exit(0);}
 else process.exit(23);
}else if(a[0]==='release'&&a[1]==='create'){if(!state.private||!a.includes('--draft')||!a.includes('--verify-tag'))process.exit(24);state.draft=true;result={};}
else if(a[0]==='release'&&a[1]==='upload'){if(state.draft!==true)process.exit(28);result={};}
else if(a[0]==='repo'&&a[1]==='edit'){if(!state.tagged||state.draft!==true)process.exit(25);state.private=false;result={};}
else if(a[0]==='release'&&a[1]==='edit'){if(state.private)process.exit(26);state.draft=false;result={};}
else process.exit(27);
fs.writeFileSync(path,JSON.stringify(state));process.stdout.write(JSON.stringify(result));
`, {mode:0o755});
    vi.stubEnv('SYNTHETIC_GH_DIR',f.base);vi.stubEnv('PATH',bin+':'+process.env.PATH);
    try {
        const {publish}=await import('../../scripts/release');
        if(kind==='foreign-ref'){await expect(publish(f)).rejects.toThrow('REMOTE_REFS_UNREVIEWED');expect(JSON.parse(await readFile(join(f.base,'remote.json'),'utf8'))).toMatchObject({private:true,tagged:false,draft:null});return;}
        if(kind!=='clean'&&kind!=='beta-clean'){
            const code=kind==='wrong-checksum'?'REMOTE_ASSET_CONTENT_MISMATCH':kind==='tag-deleted-release'||kind==='replaced-release'||kind==='final-extra-release'||kind==='edited-notes'||kind==='missing-release'||kind==='duplicate-release'||kind.startsWith('beta-')?'REMOTE_RELEASE_INVENTORY_UNREVIEWED':'REMOTE_ASSET_INVENTORY_UNREVIEWED';
            await expect(publish(f)).rejects.toThrow(code);
            const remote=JSON.parse(await readFile(join(f.base,'remote.json'),'utf8'));
            expect(remote.private).toBe(kind!=='final-extra-release'&&kind!=='beta-final-stable');
            if(kind==='tag-deleted-release')expect(remote).toMatchObject({tagged:false,draft:null});
            expect(remote.calls.some((a:string[])=>a.includes('DELETE')||a.includes('--clobber'))).toBe(false);
            await expect(readFile(join(f.output,'publication.json'))).rejects.toThrow();
            return;
        }
        await expect(publish(f)).resolves.toMatchObject({candidateSha:f.sha,archiveSha256:f.receipt.archiveSha256});
        const remote=JSON.parse(await readFile(join(f.base,'remote.json'),'utf8'));
        expect(remote).toMatchObject({private:false,tagged:true,draft:false});
        expect(JSON.parse(await readFile(join(f.output,'publication.json'),'utf8'))).toMatchObject({candidateSha:f.sha});
    } finally {vi.unstubAllEnvs();}
}, 90000);

it('stages reviewed public A then corrected B by normal fast-forward with renewed evidence and review', async()=>{
 const f=await fixture(); const remote=join(f.base,'staged.git');git(f.root,'init','--bare',remote);
 git(f.root,'remote','add','origin',remote);git(f.root,'push','origin','main:main');
 await writeFile(join(f.root,'README.md'),'Reviewed synthetic correction');git(f.root,'add','.');git(f.root,'-c','user.name=Synthetic Release','-c','user.email=release@example.invalid','commit','-m','Correct public source');
 const b=git(f.root,'rev-parse','HEAD'); const output=join(f.base,'revision');
 const predecessor={receiptPath:f.receiptPath,approval:f.approval};
 await expect(prepare({root:f.root,output,evidence:f.evidence,predecessor} as any)).rejects.toThrow('CHECK_EVIDENCE_INVALID');
 const e=JSON.parse(await readFile(f.evidence,'utf8'));for(const check of e.checks)check.candidateSha=b;await writeFile(f.evidence,JSON.stringify(e));
 await expect(prepare({root:f.root,output,evidence:f.evidence})).rejects.toThrow('PREDECESSOR_REVIEW_REQUIRED');
 const next=await prepare({root:f.root,output,evidence:f.evidence,predecessor} as any);
 expect(next).toMatchObject({rootSha:f.sha,candidateSha:b,parentReceiptSha256:sha256(await readFile(f.receiptPath))});
 const receiptPath=join(output,'candidate.json');await expect(assertPublishable({...f,receiptPath})).rejects.toThrow('CANDIDATE_REVIEW_STALE');
 await writeFile(f.approval,JSON.stringify({schemaVersion:1,approved:true,candidateReceiptSha256:sha256(await readFile(receiptPath)),reviewedAt:'2026-10-08T12:00:00Z'}));
 await expect(assertPublishable({...f,receiptPath})).resolves.toMatchObject({candidateSha:b});
 git(f.root,'push','origin','main:main');expect(git(remote,'rev-parse','main')).toBe(b);expect(git(remote,'rev-list','--all','--count')).toBe('2');
 expect(()=>validateHostedChecks({total_count:1,check_runs:[{name:'macos-local-runtime',head_sha:f.sha,status:'completed',conclusion:'success',app:{slug:'github-actions'}}]},b)).toThrow('HOSTED_CHECKS_NOT_PASSED');
}, 90000);
it.each(['unmanifested','private','merge','extra-ref'])('rejects %s ancestry even when the current tree is clean',async kind=>{
 const f=await fixture();const commit=(message:string)=>git(f.root,'-c','user.name=Synthetic Release','-c','user.email=release@example.invalid','commit','-am',message);
 if(kind==='extra-ref')git(f.root,'branch','unreviewed');
 else if(kind==='merge') {git(f.root,'checkout','-b','side');await writeFile(join(f.root,'README.md'),'side');commit('side');git(f.root,'checkout','main');await writeFile(join(f.root,'LICENSE'),'main');commit('main');git(f.root,'-c','user.name=Synthetic Release','-c','user.email=release@example.invalid','merge','--no-ff','side','-m','Merge');git(f.root,'branch','-D','side');}
 else {const path=kind==='private'?'README.md':'UNREVIEWED.txt';await writeFile(join(f.root,path),kind==='private'?'someone@'+'personalmail.com':'synthetic');git(f.root,'add','.');commit('Earlier source');if(kind==='private')await writeFile(join(f.root,path),'synthetic content');else git(f.root,'rm',path);commit('Clean current source');}
 await expect(prepare({root:f.root,output:join(f.base,'revision'),evidence:f.evidence,predecessor:{receiptPath:f.receiptPath,approval:f.approval}} as any)).rejects.toThrow(kind==='private'?'PRIVACY_VERIFICATION_FAILED':kind==='unmanifested'?'MANIFEST_TREE_MISMATCH':'PUBLIC_LINEAGE_INVALID');
});

async function reviewReceipt(f: Awaited<ReturnType<typeof fixture>>, c: any) {
 await writeFile(f.receiptPath,JSON.stringify(c));
 await writeFile(f.approval,JSON.stringify({schemaVersion:1,approved:true,candidateReceiptSha256:sha256(await readFile(f.receiptPath)),reviewedAt:'2026-10-08T12:00:00Z'}));
}
it('beta permits honest pending live acceptance while stable retains every required check',async()=>{
 for(const channel of ['stable','beta'] as const){
  const f=await fixture(channel);const c=JSON.parse(await readFile(f.receiptPath,'utf8'));
  for(const check of c.checks)if(!['local-verification','materials-and-visual-review','hosted-ci'].includes(check.name)){check.status='pending';check.evidenceSha256=null;}
  await reviewReceipt(f,c);
  if(channel==='beta')await expect(assertPublishable(f)).resolves.toMatchObject({channel:'beta',version:'v0.1.0-beta.1',checks:expect.arrayContaining([expect.objectContaining({name:'gmail-readonly-recovery',status:'pending'})])});
  else await expect(assertPublishable(f)).rejects.toThrow('REQUIRED_CHECK_NOT_PASSED');
 }
},60000);
it.each(['local-verification','materials-and-visual-review','hosted-ci','gmail-readonly-recovery'])('beta refuses missing mandatory evidence or a known failure: %s',async name=>{
 const f=await fixture('beta');const c=JSON.parse(await readFile(f.receiptPath,'utf8'));c.checks.find((x:any)=>x.name===name).status=name==='gmail-readonly-recovery'?'failed':'pending';await reviewReceipt(f,c);
 await expect(assertPublishable(f)).rejects.toThrow('REQUIRED_CHECK_NOT_PASSED');
});
it('beta channel is deliberate and bound to package version and independent review',async()=>{
 const f=await fixture('beta');
 await expect(prepare({root:f.root,output:join(f.base,'wrong-channel'),evidence:f.evidence})).rejects.toThrow('RELEASE_CHANNEL_VERSION_MISMATCH');
 const c=JSON.parse(await readFile(f.receiptPath,'utf8'));c.channel='stable';await writeFile(f.receiptPath,JSON.stringify(c));await expect(assertPublishable(f)).rejects.toThrow('CANDIDATE_REVIEW_STALE');
 await reviewReceipt(f,c);await expect(assertPublishable(f)).rejects.toThrow('CANDIDATE_RECEIPT_INVALID');
 c.version='v0.1.0';await reviewReceipt(f,c);await expect(assertPublishable(f)).rejects.toThrow('RELEASE_CHANNEL_VERSION_MISMATCH');
});
