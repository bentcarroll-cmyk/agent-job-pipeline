import { afterEach, beforeEach, expect, it } from "vitest";
import { createDatabase, loadSchema } from "./harness";
import { acquireLease, fencedBatch, LeaseLostError, releaseLease, renewLease } from "../../src/operations/leases";
let db: D1Database, dispose: () => Promise<void>;
beforeEach(async () => { ({ db, dispose } = await createDatabase()); await loadSchema(db, "root"); });
afterEach(async () => { await dispose(); });
it("shares an owned lease on replay while preventing another run in the same pipeline", async () => {
  const fixed = await acquireLease(db, "fixed_boards", "instance-fixed-slot");
  expect(fixed).toMatchObject({ owner: "instance-fixed-slot", fence: 1 });
  expect(await acquireLease(db, "fixed_boards", "instance-fixed-slot")).toEqual(fixed);
  expect(await acquireLease(db, "fixed_boards", "another-slot")).toBeNull();
  expect(await acquireLease(db, "unbounded_discovery", "instance-discovery-slot")).toMatchObject({ owner: "instance-discovery-slot", fence: 1 });
});
it("prevents stale renewal and finalization from releasing a successor lease", async () => {
  const old = (await acquireLease(db, "fixed_boards", "old-slot"))!;
  await db.prepare("UPDATE discovery_run_leases SET expires_at=0 WHERE pipeline='fixed_boards'").run();
  const next = (await acquireLease(db, "fixed_boards", "new-slot"))!;
  expect(next.fence).toBe(2);
  await expect(renewLease(db, old)).rejects.toBeInstanceOf(LeaseLostError);
  await releaseLease(db, old);
  expect(await acquireLease(db, "fixed_boards", "other-slot")).toBeNull();
});
it("rolls back writes under a superseded fence", async () => {
  const old = (await acquireLease(db, "fixed_boards", "old-slot"))!;
  await db.prepare("UPDATE discovery_run_leases SET expires_at=0 WHERE pipeline='fixed_boards'").run();
  await acquireLease(db, "fixed_boards", "new-slot");
  await expect(fencedBatch(db, old, [db.prepare("INSERT INTO search_rotation (id,next_phrase_index) VALUES (1,99)")])).rejects.toBeInstanceOf(LeaseLostError);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM search_rotation WHERE id=1").first()).toEqual({ n: 0 });
});
