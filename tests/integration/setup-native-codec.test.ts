import { it,expect } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {join} from 'node:path';
import {Buffer} from 'node:buffer';
import {gzipSync} from 'node:zlib';
import {CHICAGO_OPERATIONS} from '../fixtures/candidates';
import {candidateCriteriaVersion} from '../../src/config/candidate';
import {encodeCandidateBinding,renderConfig} from '../../tools/setup/render-config';
it('roundtrips approved full policy and native Worker gzip decoder with generated bindings',async()=>{
  const root=await mkdtemp(join(tmpdir(),'native-codec-'));let mf:Miniflare|undefined;
  try{
    const c=structuredClone(CHICAGO_OPERATIONS);c.search.openWebPhrases=Array.from({length:200},(_,i)=>`operations manufacturing ${i} Chicago`);c.approval.configSha256=await candidateCriteriaVersion(c);
    const instance=JSON.parse(await readFile(new URL('../../examples/instance.json',import.meta.url),'utf8'));
    const {bindings}=await renderConfig(instance,c,'fixed','/tmp/example.ts','preview');
    const bundle=await build({stdin:{contents:`import {configureEnv} from ${JSON.stringify(new URL('../../src/config/env.ts',import.meta.url).pathname)};export default {async fetch(req,env){try {const loaded=await configureEnv({...env,CANDIDATE_CONFIG:await req.text()||env.CANDIDATE_CONFIG});return Response.json({candidate:loaded.runtime.candidate,version:loaded.runtime.criteriaVersion,shadow:loaded.SHADOW_MODE,user:loaded.SLACK_ALLOWED_USER_ID});}catch {return new Response('INVALID_CONFIG',{status:400});}}};`,resolveDir:root},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
    mf=new Miniflare({host:'127.0.0.1',port:0,cf:false,telemetry:{enabled:false},resourcePersistencePath:join(root,'storage'),resourceTmpPath:join(root,'tmp'),workers:[{config:{type:'worker',name:'codec',compatibilityDate:'2026-09-01',manifest:{mainModule:'index.mjs',modulesRoot:root,modules:{'index.mjs':{type:'esm',contents:bundle.outputFiles[0].text}}},env:Object.fromEntries(Object.entries(bindings).map(([k,value])=>[k,{type:'text',value}])),exports:{}},dev:{rootPath:root,unsafeRegisterWorker:false}}]});
    const response=await mf.dispatchFetch('http://localhost',{method:'POST'});expect(response.status).toBe(200);expect(await response.json()).toEqual({candidate:c,version:c.approval.configSha256,shadow:'true',user:instance.slack.allowedUserId});
    const changed=structuredClone(c);changed.search.openWebPhrases=['changed'];expect((await mf.dispatchFetch('http://localhost',{method:'POST',body:encodeCandidateBinding(changed)})).status).toBe(400);
    const bomb='gzip:'+Buffer.from(gzipSync('a'.repeat(300000))).toString('base64');expect((await mf.dispatchFetch('http://localhost',{method:'POST',body:bomb})).status).toBe(400);
  }finally{await mf?.dispose();await rm(root,{recursive:true,force:true});}
});
