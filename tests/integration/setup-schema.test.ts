import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it, expect, afterEach } from 'vitest';
import { createDatabase } from './harness';
import { applySchema, localSetupDatabase, migrationManifest, migrationIds } from '../../tools/setup/resources';
const active:Array<Awaited<ReturnType<typeof createDatabase>>>=[];afterEach(async()=>{for(const db of active.splice(0))await db.dispose();});
const releaseRoot=new URL('../..',import.meta.url).pathname;
const identity={instanceId:'synthetic',accountId:'a'.repeat(32),databaseId:'00000000-0000-4000-8000-000000000000'};
it('fresh complete schema represents every migration atomically and never repeats ALTER on resume',async()=>{const h=await createDatabase();active.push(h);const db=localSetupDatabase(h.db);await applySchema(db,identity,releaseRoot);await applySchema(db,identity,releaseRoot);expect((await h.db.prepare('SELECT id,mode FROM setup_migrations').all()).results).toEqual(migrationIds.map(id=>({id,mode:'represented'})));expect((await h.db.prepare('PRAGMA table_info(jobs)').all()).results.filter(r=>r.name==='criteria_version')).toHaveLength(1);await expect(applySchema(db,{...identity,instanceId:'foreign'},releaseRoot)).rejects.toThrow('DATABASE_OWNERSHIP_CONFLICT');});
it('atomic upgrade commit survives a lost response without reapplying ALTER or modifying application evidence',async()=>{const h=await createDatabase();active.push(h);const db=localSetupDatabase(h.db);await applySchema(db,identity,releaseRoot);await h.db.batch([h.db.prepare("DELETE FROM setup_migrations WHERE id='candidate-config'"),h.db.prepare('DROP TABLE candidate_run_configs'),h.db.prepare('DROP TABLE candidate_active_configs'),h.db.prepare('ALTER TABLE jobs DROP COLUMN criteria_version')]);await h.db.prepare("INSERT INTO known_applications(id,employer,title,status) VALUES (1,'Synthetic','Leader','applied')").run();let lost=false;const faulty={batch:async(q:Parameters<typeof db.batch>[0])=>{const result=await db.batch(q);if(q.some(s=>s.sql.includes('ALTER TABLE jobs ADD COLUMN criteria_version'))&&!lost){lost=true;throw new Error('lost response');}return result;}};await expect(applySchema(faulty,identity,releaseRoot)).rejects.toThrow('lost response');await applySchema(db,identity,releaseRoot);expect(await h.db.prepare("SELECT mode FROM setup_migrations WHERE id='candidate-config'").first()).toEqual({mode:'applied'});expect(await h.db.prepare('SELECT status,applied_at FROM known_applications WHERE id=1').first()).toEqual({status:'applied',applied_at:null});});
it('failed migration rolls back ALTER and its receipt together',async()=>{const h=await createDatabase();active.push(h);const db=localSetupDatabase(h.db);await applySchema(db,identity,releaseRoot);await h.db.batch([h.db.prepare("DELETE FROM setup_migrations WHERE id='candidate-config'"),h.db.prepare('ALTER TABLE jobs DROP COLUMN criteria_version')]);const faulty={batch:(q:Parameters<typeof db.batch>[0])=>db.batch(q.some(s=>s.sql.includes('ALTER TABLE jobs ADD COLUMN criteria_version'))?[...q,{sql:'INSERT INTO missing_table VALUES (1)'}]:q)};await expect(applySchema(faulty,identity,releaseRoot)).rejects.toThrow();expect((await h.db.prepare('PRAGMA table_info(jobs)').all()).results.some(r=>r.name==='criteria_version')).toBe(false);expect(await h.db.prepare("SELECT id FROM setup_migrations WHERE id='candidate-config'").first()).toBeNull();await applySchema(db,identity,releaseRoot);});
it('refuses preexisting databases without exact setup provenance',async()=>{const h=await createDatabase();active.push(h);await h.db.prepare('CREATE TABLE unrelated(id TEXT)').run();await expect(applySchema(localSetupDatabase(h.db),identity,releaseRoot)).rejects.toThrow('DATABASE_OWNERSHIP_UNVERIFIED');});

it('adds fixed baseline receipt to an owned upgrade without rewriting earlier hashes',async()=>{
 const h=await createDatabase();active.push(h);const db=localSetupDatabase(h.db);await applySchema(db,identity,releaseRoot);
 await h.db.batch([h.db.prepare("DELETE FROM setup_migrations WHERE id='fixed-baseline'"),h.db.prepare("DROP TABLE fixed_baselines")]);
 const prior=(await h.db.prepare("SELECT * FROM setup_migrations ORDER BY id").all()).results;
 await applySchema(db,identity,releaseRoot);await applySchema(db,identity,releaseRoot);
 expect((await h.db.prepare("SELECT * FROM setup_migrations WHERE id!='fixed-baseline' ORDER BY id").all()).results).toEqual(prior);
 expect(await h.db.prepare("SELECT mode FROM setup_migrations WHERE id='fixed-baseline'").first()).toEqual({mode:'applied'});
});

it('rejects a changed prerelease comment hash without rewriting any owned receipt or application',async()=>{
 const prior=await mkdtemp(join(tmpdir(),'synthetic-prerelease-schema-'));
 try {
  for(const file of ['schema.sql',...migrationIds.map(id=>`schema.${id}-migration.sql`)]){
   const bytes=await readFile(join(releaseRoot,file),'utf8');await writeFile(join(prior,file),(file==='schema.ledger-migration.sql'?'-- Fabricated earlier prerelease comment.\n':'')+bytes);
  }
  const h=await createDatabase();active.push(h);const db=localSetupDatabase(h.db);await applySchema(db,identity,prior);
  await h.db.prepare("INSERT INTO known_applications(id,employer,title,status) VALUES (1,'Synthetic','Operator','applied')").run();
  const receipts=(await h.db.prepare('SELECT * FROM setup_migrations ORDER BY id').all()).results;
  const applications=(await h.db.prepare('SELECT * FROM known_applications').all()).results;
  await expect(applySchema(db,identity,releaseRoot)).rejects.toThrow('MIGRATION_HASH_CHANGED');
  expect((await h.db.prepare('SELECT * FROM setup_migrations ORDER BY id').all()).results).toEqual(receipts);
  expect((await h.db.prepare('SELECT * FROM known_applications').all()).results).toEqual(applications);
 } finally {await rm(prior,{recursive:true,force:true});}
});
