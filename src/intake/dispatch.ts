import type { DispatchSummary, WorkflowControl } from "./types";
import { finishManualDelivery } from "./delivery-store";

type DispatchRow = { id: string; state: string; stage: string; workflow_generation: number;
  workflow_id: string; next_attempt_at: number; dispatch_count: number };
const FINAL = new Set(["delivered", "already_tracked", "held", "delivery_unknown"]);
const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000];
const ACTIVE = new Set(["queued", "running", "waiting"]);
const MAX_RECOVERY_GENERATION = 3;

function backoff(attempt: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempt - 1, 0), BACKOFF_MS.length - 1)];
}

async function read(db: D1Database, requestId: string): Promise<DispatchRow | null> {
  return db.prepare(`SELECT id,state,stage,workflow_generation,workflow_id,
    next_attempt_at,dispatch_count FROM manual_intake_requests WHERE id=?`)
    .bind(requestId).first<DispatchRow>();
}

async function observed(db: D1Database, row: DispatchRow, nowMs: number,
  failureCode: string | null, delayMs: number): Promise<void> {
  await db.prepare(`UPDATE manual_intake_requests SET dispatch_count=dispatch_count+1,
    next_attempt_at=?,failure_code=?,updated_at=?
    WHERE id=? AND workflow_generation=? AND state=? AND stage=? AND state NOT IN
      ('delivered','already_tracked','held','delivery_unknown')`)
    .bind(nowMs + delayMs, failureCode, new Date(nowMs).toISOString(), row.id,
      row.workflow_generation, row.state, row.stage).run();
}

async function unknown(db: D1Database, row: DispatchRow, nowMs: number): Promise<"unknown"> {
  await observed(db, row, nowMs, "dispatch_unknown", backoff(row.dispatch_count + 1));
  return "unknown";
}

async function recover(db: D1Database, row: DispatchRow, nowMs: number): Promise<"created" | "exists" | "deferred" | "unknown" | "exhausted"> {
  const delivery = await db.prepare(`SELECT id,state FROM manual_intake_deliveries WHERE request_id=?`)
    .bind(row.id).first<{id:string;state:string}>();
  if (delivery?.state === "sending") {
    await finishManualDelivery(db, delivery.id, row.workflow_generation,
      { kind: "unknown", code: "workflow_interrupted" }, new Date(nowMs).toISOString());
    return "deferred";
  }
  if (delivery?.state === "unknown") {
    await db.prepare(`UPDATE manual_intake_requests SET state='delivery_unknown',stage='deliver',
      failure_code='delivery_receipt_unknown',updated_at=?
      WHERE id=? AND workflow_generation=? AND state NOT IN ('delivered','held')`)
      .bind(new Date(nowMs).toISOString(), row.id, row.workflow_generation).run();
    return "deferred";
  }
  if (row.workflow_generation >= MAX_RECOVERY_GENERATION) {
    await db.prepare(`UPDATE manual_intake_requests SET state='held',
      failure_code='recovery_exhausted',updated_at=?
      WHERE id=? AND workflow_generation=? AND state NOT IN ('delivered','already_tracked')`)
      .bind(new Date(nowMs).toISOString(), row.id, row.workflow_generation).run();
    return "exhausted";
  }
  const nextGeneration = row.workflow_generation + 1;
  const result = await db.prepare(`UPDATE manual_intake_requests SET workflow_generation=?,
    workflow_id=?,dispatch_count=0,next_attempt_at=0,failure_code=NULL,
    updated_at=? WHERE id=? AND workflow_generation=? AND state NOT IN
      ('delivered','already_tracked','held','delivery_unknown')`)
    .bind(nextGeneration, `intake-${row.id}-g${nextGeneration}`,
      new Date(nowMs).toISOString(), row.id, row.workflow_generation).run();
  if (!result.meta.changes) return "deferred";
  return "created";
}

export async function dispatchIntake(db: D1Database, control: WorkflowControl,
  requestId: string, nowMs: number): Promise<"created" | "exists" | "deferred" | "unknown"> {
  if (!/^[a-f0-9]{64}$/.test(requestId) || !Number.isFinite(nowMs)) throw new Error("Invalid intake dispatch");
  let row = await read(db, requestId);
  if (!row || FINAL.has(row.state) || row.next_attempt_at > nowMs) return "deferred";
  if (row.dispatch_count > 0) {
    let current: Awaited<ReturnType<WorkflowControl["status"]>> = "unknown";
    try { current = await control.status(row.workflow_id); }
    catch { /* Same-ID create below is safe even when status cannot be read. */ }
    if (ACTIVE.has(current)) {
      await observed(db, row, nowMs, null, 300_000);
      return "exists";
    }
    if (current === "errored" || current === "terminated" || current === "complete") {
      const outcome = await recover(db, row, nowMs);
      if (outcome !== "created") return "deferred";
      row = await read(db, requestId);
      if (!row) return "deferred";
    }
  }
  try {
    await control.create({ id: row.workflow_id,
      params: { requestId: row.id, generation: row.workflow_generation } });
    await observed(db, row, nowMs, null, 300_000);
    return "created";
  } catch {
    let current: Awaited<ReturnType<WorkflowControl["status"]>>;
    try { current = await control.status(row.workflow_id); }
    catch { return unknown(db, row, nowMs); }
    if (ACTIVE.has(current)) {
      await observed(db, row, nowMs, null, 300_000);
      return "exists";
    }
    return unknown(db, row, nowMs);
  }
}

export async function reconcileIntakes(db: D1Database, control: WorkflowControl,
  nowMs: number, limit = 20): Promise<DispatchSummary> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid intake batch limit");
  const exhaustedBefore = (await db.prepare(`SELECT COUNT(*) AS n FROM manual_intake_requests
    WHERE state='held' AND failure_code='recovery_exhausted'`)
    .first<{n:number}>())?.n ?? 0;
  const rows = (await db.prepare(`SELECT id FROM manual_intake_requests
    WHERE state IN ('accepted','resolving','fetching','saved','screening','ready',
      'delivering','retry_wait') AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT ?`)
    .bind(nowMs, limit).all<{id:string}>()).results;
  const summary: DispatchSummary = { examined: rows.length, created: 0, alreadyRunning: 0,
    deferred: 0, unknown: 0, exhausted: 0 };
  for (const row of rows) {
    const outcome = await dispatchIntake(db, control, row.id, nowMs);
    if (outcome === "created") summary.created++;
    else if (outcome === "exists") summary.alreadyRunning++;
    else if (outcome === "unknown") summary.unknown++;
    else summary.deferred++;
  }
  summary.exhausted = (await db.prepare(`SELECT COUNT(*) AS n FROM manual_intake_requests
    WHERE state='held' AND failure_code='recovery_exhausted'`)
    .first<{n:number}>())?.n ?? 0;
  summary.exhausted = Math.max(0, summary.exhausted - exhaustedBefore);
  return summary;
}

export function workflowControl(workflow: Workflow): WorkflowControl {
  return {
    async create(input) { return { id: (await workflow.create(input)).id }; },
    async status(id) {
      try {
        const value = (await (await workflow.get(id)).status()).status;
        if (value === "paused" || value === "waitingForPause" || value === "rollingBack") return "waiting";
        return value;
      }
      catch { return "unknown"; }
    },
  };
}
