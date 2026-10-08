import { fencedBatch, type DiscoveryLease } from "../operations/leases";
import { observedUrl } from "./observe";
import type { ResolutionResult } from "./types";

export type AliasEvidence = {
  alias: string;
  ownerJobId: string;
  employerKey: string;
  requisitionId: string;
  sourceUrl: string;
  verifiedAt: string;
  // The exact resolver result that established these aliases. A bare URL and
  // reused requisition are not proof of common job ownership.
  resolution?: ResolutionResult;
};
export type AliasWriteGuard =
  | { kind: "discovery"; lease: DiscoveryLease }
  | { kind: "manual_intake"; requestId: string; generation: number };

function checked(evidence: AliasEvidence): AliasEvidence {
  const alias = observedUrl(evidence.alias);
  const sourceUrl = observedUrl(evidence.sourceUrl);
  if (!alias || !sourceUrl || alias !== evidence.alias || sourceUrl !== evidence.sourceUrl ||
    !evidence.ownerJobId.trim() || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(evidence.employerKey) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(evidence.requisitionId) ||
    !Number.isFinite(Date.parse(evidence.verifiedAt))) {
    throw new Error("Alias evidence must be exact, normalized and source-bound");
  }
  const proof = evidence.resolution;
  if (proof?.kind !== "resolved" || !proof.aliases.includes(alias) ||
    !proof.aliases.includes(sourceUrl) ||
    !proof.evidence.some(item => observedUrl(item.url) === sourceUrl && item.employerKey === evidence.employerKey &&
      item.requisitionId?.toLowerCase() === evidence.requisitionId.toLowerCase())) {
    throw new Error("Alias claim lacks matching resolver evidence");
  }
  if (proof.posting.kind === "employer" &&
    (proof.posting.employerKey !== evidence.employerKey ||
      proof.posting.requisitionId.toLowerCase() !== evidence.requisitionId.toLowerCase() ||
      proof.posting.jobId !== `employer:${evidence.employerKey}:${encodeURIComponent(evidence.requisitionId)}`)) {
    throw new Error("Alias claim conflicts with resolved employer identity");
  }
  return evidence;
}

export async function lookupAliasOwner(db: D1Database, alias: string): Promise<string | null> {
  const normalized = observedUrl(alias);
  if (!normalized) return null;
  const row = await db.prepare("SELECT owner_job_id FROM discovery_job_aliases WHERE alias=?")
    .bind(normalized).first<{ owner_job_id: string }>();
  return row?.owner_job_id ?? null;
}

export async function recordProvenAlias(db: D1Database, guard: AliasWriteGuard,
  input: AliasEvidence): Promise<"recorded" | "already_recorded" | "conflict"> {
  const evidence = checked(input);
  const job = await db.prepare("SELECT url FROM jobs WHERE id=?").bind(evidence.ownerJobId)
    .first<{ url: string }>();
  if (!job) return "conflict";
  const proof = evidence.resolution;
  if (proof?.kind !== "resolved") throw new Error("Alias claim lacks a resolved posting");
  const nativeOwner = proof.posting.kind === "ats" &&
    evidence.ownerJobId === `employer:${evidence.employerKey}:${encodeURIComponent(evidence.requisitionId)}`;
  const priorOwner = await db.prepare(`SELECT owner_job_id FROM discovery_job_owners
    WHERE employer_key=? AND requisition_key=?`)
    .bind(evidence.employerKey, evidence.requisitionId.toLowerCase())
    .first<{owner_job_id:string}>();
  if (proof.posting.jobId !== evidence.ownerJobId && !nativeOwner &&
    priorOwner?.owner_job_id !== evidence.ownerJobId) return "conflict";
  if (guard.kind === "manual_intake") {
    const current = await db.prepare(`SELECT id FROM manual_intake_requests
      WHERE id=? AND workflow_generation=? AND job_id=?`)
      .bind(guard.requestId, guard.generation, evidence.ownerJobId).first();
    if (!current) return "conflict";
    const gate = `EXISTS (SELECT 1 FROM manual_intake_requests
      WHERE id=? AND workflow_generation=? AND job_id=?)`;
    const results = await db.batch([
      db.prepare(`INSERT INTO discovery_job_owners (employer_key,requisition_key,requisition_id,owner_job_id)
        SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM jobs WHERE id=?) AND ${gate}
        ON CONFLICT(employer_key,requisition_key) DO NOTHING`)
        .bind(evidence.employerKey, evidence.requisitionId.toLowerCase(), evidence.requisitionId,
          evidence.ownerJobId, evidence.ownerJobId, guard.requestId, guard.generation, evidence.ownerJobId),
      db.prepare(`INSERT INTO discovery_job_aliases
        (alias,owner_job_id,employer_key,requisition_id,source_url,verified_at)
        SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM discovery_job_owners
          WHERE employer_key=? AND requisition_key=? AND owner_job_id=?) AND ${gate}
        ON CONFLICT(alias) DO NOTHING`)
        .bind(evidence.alias, evidence.ownerJobId, evidence.employerKey, evidence.requisitionId,
          evidence.sourceUrl, evidence.verifiedAt, evidence.employerKey,
          evidence.requisitionId.toLowerCase(), evidence.ownerJobId,
          guard.requestId, guard.generation, evidence.ownerJobId),
    ]);
    const row = await db.prepare(`SELECT owner_job_id,employer_key,requisition_id,source_url
      FROM discovery_job_aliases WHERE alias=?`).bind(evidence.alias).first<{
        owner_job_id:string;employer_key:string;requisition_id:string;source_url:string;
      }>();
    const stillCurrent = await db.prepare(`SELECT id FROM manual_intake_requests
      WHERE id=? AND workflow_generation=? AND job_id=?`)
      .bind(guard.requestId, guard.generation, evidence.ownerJobId).first();
    if (!stillCurrent) return "conflict";
    if (!row || row.owner_job_id !== evidence.ownerJobId ||
      row.employer_key !== evidence.employerKey || row.requisition_id !== evidence.requisitionId ||
      row.source_url !== evidence.sourceUrl) return "conflict";
    return results[1]?.meta.changes === 1 ? "recorded" : "already_recorded";
  }
  if (job.url !== evidence.sourceUrl && proof.posting.jobId !== evidence.ownerJobId) return "conflict";
  const results = await fencedBatch(db, guard.lease, [
    db.prepare(`INSERT INTO discovery_job_owners (employer_key,requisition_key,requisition_id,owner_job_id)
      SELECT ?,?,?,? FROM jobs WHERE id=? AND url=?
      ON CONFLICT(employer_key,requisition_key) DO NOTHING`)
      .bind(evidence.employerKey, evidence.requisitionId.toLowerCase(), evidence.requisitionId, evidence.ownerJobId,
        evidence.ownerJobId, job.url),
    db.prepare(`INSERT INTO discovery_job_aliases
      (alias,owner_job_id,employer_key,requisition_id,source_url,verified_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS (
        SELECT 1 FROM discovery_job_owners WHERE employer_key=? AND requisition_key=? AND owner_job_id=?
      ) AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND url=?)
      ON CONFLICT(alias) DO NOTHING`)
      .bind(evidence.alias, evidence.ownerJobId, evidence.employerKey, evidence.requisitionId,
        evidence.sourceUrl, evidence.verifiedAt,
        evidence.employerKey, evidence.requisitionId.toLowerCase(), evidence.ownerJobId,
        evidence.ownerJobId, job.url),
  ]);
  const row = await db.prepare(`SELECT owner_job_id,employer_key,requisition_id,source_url,verified_at
    FROM discovery_job_aliases WHERE alias=?`).bind(evidence.alias).first<{
      owner_job_id: string; employer_key: string; requisition_id: string;
      source_url: string; verified_at: string;
    }>();
  if (!row || row.owner_job_id !== evidence.ownerJobId ||
    row.employer_key !== evidence.employerKey || row.requisition_id !== evidence.requisitionId ||
    row.source_url !== evidence.sourceUrl) return "conflict";
  return results[1]?.meta.changes === 1 ? "recorded" : "already_recorded";
}
