import { fencedBatch, type DiscoveryLease } from "./operations/leases";
import { embeddedGreenhouseJobId, type Source, type NormalizedJob } from "./sources";
import type { Verdict } from "./criteria";
import { jobRefId, parseJobUrl, workdaySite, titleCaseSlug, type JobRef } from "./unbounded/discovery";

export type KnownApplication = { status: string | null; source_job_id: string | null };

const CHUNK = 50; // conservative batch size for D1 batch() calls

export async function countJobs(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) as n FROM jobs").first<{ n: number }>();
  return row?.n ?? 0;
}

export async function getExistingJobIds(db: D1Database, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const { results } = await db.prepare(`SELECT id FROM jobs WHERE id IN (${placeholders})`).bind(...chunk).all<{ id: string }>();
    for (const r of results) found.add(r.id);
  }
  return found;
}

// Fixed boards can use a display name while /job derives the ATS slug.
// Probe indexed IDs and verify the configured employer and posting ID.
export async function getExistingAtsJobOwners(db: D1Database,
  jobs: readonly Pick<NormalizedJob, "id" | "url">[], sources: readonly Source[],
  identityConflicts?: Set<string>): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  for (let i = 0; i < jobs.length; i += CHUNK) {
    const chunk = jobs.slice(i, i + CHUNK);
    if (!chunk.length) continue;
    const candidates = new Map<string, string[]>();
    for (const job of chunk) {
      const ref = parseJobUrl(job.url, "");
      const [ats, company, ...postingParts] = job.id.split(":");
      const source = sources.find(item => item.ats === ats && item.company === company);
      const canonical = ref && ref.ats !== "workday" && source && "slug" in source &&
        ref.ats === ats && ref.slug.toLowerCase() === source.slug.toLowerCase() &&
        ref.postingId.toLowerCase() === postingParts.join(":").toLowerCase()
        ? jobRefId(ref) : null;
      candidates.set(job.id, [...new Set([job.id, ...(canonical ? [canonical] : [])])]);
    }
    const keys = [...new Set([...candidates.values()].flat())];
    const placeholders = keys.map(() => "?").join(",");
    const rows = (await db.prepare(`SELECT id,url FROM jobs WHERE id IN (${placeholders})`)
      .bind(...keys).all<{ id: string; url: string }>()).results;
    for (const row of rows) for (const job of chunk) {
      if (!candidates.get(job.id)!.includes(row.id)) continue;
      if (row.id !== job.id) {
        const requested = parseJobUrl(job.url, "");
        const stored = parseJobUrl(row.url, "");
        if (!requested || !stored || requested.ats === "workday" ||
          jobRefId(requested) !== jobRefId(stored)) continue;
      }
      const prior = owners.get(job.id);
      if (prior && prior !== row.id) {
        if (!identityConflicts) throw new Error(`Ambiguous ATS job owner for ${job.id}`);
        identityConflicts.add(job.id);
        owners.delete(job.id);
      }
      if (!identityConflicts?.has(job.id)) owners.set(job.id, row.id);
    }
  }
  return owners;
}

export async function touchLastSeen(db: D1Database, ids: string[], now: string, lease?: DiscoveryLease): Promise<void> {
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;
    await fencedBatch(db, lease, chunk.map((id) => db.prepare("UPDATE jobs SET last_seen_at = ? WHERE id = ?").bind(now, id)));
  }
}

export async function lookupKnownApplication(db: D1Database, canonicalId: string | null): Promise<KnownApplication | null> {
  if (!canonicalId) return null;
  const row = await db
    .prepare("SELECT status, source_job_id FROM known_applications WHERE canonical_id = ? LIMIT 1")
    .bind(canonicalId)
    .first<KnownApplication>();
  return row ?? null;
}

export type EmployerApplicationLookup =
  | { kind: "none" }
  | { kind: "matched"; application: KnownApplication }
  | { kind: "ambiguous" };

// A requisition is scoped to its employer. Old imports may store the bare
// requisition as canonical_id, so require the employer too unless an exact
// owner ID or a resolver-proven posting URL identifies the application.
export async function lookupKnownEmployerApplication(db: D1Database, input: {
  ownerJobId: string; employerKey: string; employerName: string;
  requisitionId: string; aliases: readonly string[];
}): Promise<EmployerApplicationLookup> {
  const aliases = [...new Set(input.aliases)];
  const aliasCondition = aliases.length ? `posting_url IN (${aliases.map(() => "?").join(",")})` : "0";
  const rows = (await db.prepare(`SELECT status,source_job_id FROM known_applications
    WHERE canonical_id=? OR ${aliasCondition} OR
      ((lower(canonical_id)=lower(?) OR lower(requisition_id)=lower(?))
        AND lower(trim(COALESCE(employer,''))) IN (?,?))
    ORDER BY id LIMIT 2`).bind(input.ownerJobId, ...aliases, input.requisitionId,
      input.requisitionId, input.employerKey.toLowerCase(), input.employerName.toLowerCase())
    .all<KnownApplication>()).results;
  if (rows.length > 1) return { kind: "ambiguous" };
  return rows.length ? { kind: "matched", application: rows[0] } : { kind: "none" };
}

// A careers page embedding a Greenhouse board carries only the posting's
// Greenhouse id (gh_jid), which Greenhouse keeps unique across boards. It can
// identify an application only against another Greenhouse identity, never a
// bare id: Workday requisitions can be all digits too.
function greenhouseJobId(url: string, ref: JobRef | null): string | null {
  return ref ? (ref.ats === "greenhouse" ? ref.postingId : null) : embeddedGreenhouseJobId(url);
}

export type NamedApplication = KnownApplication & { employer: string | null; title: string | null };

export type AtsApplicationLookup =
  | { kind: "none" }
  | { kind: "matched"; application: NamedApplication }
  | { kind: "ambiguous" };

// jobId and employerName are null for a careers page that names a Greenhouse
// posting but not its board: its only identity is the posting URL.
// Additional jobIds must come from configured ATS identity or proven aliases.
export async function lookupKnownAtsApplication(db: D1Database, input: {
  jobId: string | null; jobIds?: readonly string[]; postingId: string; employerName: string | null; postingUrl: string;
}): Promise<AtsApplicationLookup> {
  const jobIds = new Set([input.jobId, ...(input.jobIds ?? [])]
    .filter((id): id is string => id !== null).map(id => id.toLowerCase()));
  const keys = jobIds.size ? [...jobIds] : [null];
  const rows = (await db.prepare(`SELECT canonical_id,posting_url,requisition_id,employer,title,status,source_job_id
    FROM known_applications
    WHERE lower(canonical_id) IN (${keys.map(() => "?").join(",")}) OR lower(canonical_id)=lower(?) OR
      lower(requisition_id)=lower(?) OR posting_url=?
    ORDER BY id LIMIT 101`).bind(...keys, input.postingId,
      input.postingId, input.postingUrl).all<NamedApplication & {
        canonical_id:string|null;posting_url:string|null;requisition_id:string|null}>()).results;
  if (rows.length > 100) return { kind: "ambiguous" };
  const requested = parseJobUrl(input.postingUrl, "");
  const employer = input.employerName?.trim().toLowerCase();
  const matches = rows.filter(row => {
    // A canonical Workday ID omits the career site. Explicit URL evidence
    // must agree before even an exact ID can establish this application.
    if (requested?.ats === "workday" && row.posting_url) {
      const observed = parseJobUrl(row.posting_url, "");
      if (observed?.ats === "workday" && (jobRefId(observed) !== jobRefId(requested) ||
        workdaySite(row.posting_url) !== workdaySite(input.postingUrl))) return false;
    }
    if (row.canonical_id && jobIds.has(row.canonical_id.toLowerCase())) return true;
    if (row.posting_url === input.postingUrl) return true;
    if (row.posting_url) {
      const observed = parseJobUrl(row.posting_url, "");
      if (!requested || !observed) {
        const id = greenhouseJobId(row.posting_url, observed);
        return id !== null && id === greenhouseJobId(input.postingUrl, requested);
      }
      if (jobRefId(requested) !== jobRefId(observed)) return false;
      return requested.ats !== "workday" || workdaySite(input.postingUrl) === workdaySite(row.posting_url);
    }
    return !!employer && row.employer?.trim().toLowerCase() === employer &&
      (row.canonical_id?.toLowerCase() === input.postingId.toLowerCase() ||
        row.requisition_id?.toLowerCase() === input.postingId.toLowerCase());
  });
  if (matches.length > 1) return { kind: "ambiguous" };
  return matches.length ? { kind: "matched", application: matches[0] } : { kind: "none" };
}

// Statuses /job answers as already applied: the application went in, or it
// closed, usually with a rejection.
const APPLIED = new Set(["applied", "interviewing", "offer", "closed"]);

// The application a /job link was already applied to, found the way the
// unbounded Worker finds one for a search hit. Only a link naming an ATS
// posting, or a careers page embedding a Greenhouse one, can match.
export async function appliedApplicationForUrl(db: D1Database, url: string): Promise<NamedApplication | null> {
  const ref = parseJobUrl(url, "");
  const ghJid = ref ? null : embeddedGreenhouseJobId(url);
  if (!ref && !ghJid) return null;
  const lookup = await lookupKnownAtsApplication(db, ref
    ? { jobId: jobRefId(ref), postingId: ref.postingId, employerName: titleCaseSlug(ref.slug), postingUrl: ref.url }
    : { jobId: null, postingId: ghJid!, employerName: null, postingUrl: url });
  return lookup.kind === "matched" && APPLIED.has(lookup.application.status ?? "") ? lookup.application : null;
}

export type JobInsert = {
  criteriaVersion: string;
  job: NormalizedJob;
  firstSeenAt: string;
  isKnownApplication: boolean;
  knownApplicationSource: string | null;
  verdict: Verdict | null; // null = not evaluated (baseline or known application)
  applicationStatus: string;
  applicationStatusSource: string;
  discoverySource?: string; // 'fixed_board' (default) | 'unbounded_search'
  // true = leave notified_at NULL even on a match, because delivery hasn't
  // happened yet. Both discovery Workers set this: they stamp notified_at
  // only once Slack accepts the message (see markNotified), so an interrupted
  // run leaves its saved, undelivered matches recoverable.
  deferNotifiedAt?: boolean;
};

export function jobInsertStatement(db: D1Database, r: JobInsert, now = new Date().toISOString()): D1PreparedStatement {
  return db
      .prepare(
        `INSERT INTO jobs (
          id, company, title, url, location, department, is_remote, employment_type,
          posted_at, compensation, first_seen_at, last_seen_at,
          is_known_application, known_application_source,
          match, match_lane, match_hard_exclude, match_reason, notified_at,
          application_status, application_status_source, application_status_updated_at,
          discovery_source, criteria_version
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO NOTHING`,
      )
      .bind(
        r.job.id,
        r.job.company,
        r.job.title,
        r.job.url,
        r.job.location,
        r.job.department,
        r.job.isRemote === null ? null : r.job.isRemote ? 1 : 0,
        r.job.employmentType,
        r.job.postedAt,
        r.job.compensation,
        r.firstSeenAt,
        r.firstSeenAt,
        r.isKnownApplication ? 1 : 0,
        r.knownApplicationSource,
        r.verdict ? (r.verdict.match ? 1 : 0) : null,
        r.verdict?.lane ?? null,
        r.verdict?.hard_exclude ?? null,
        r.verdict?.reason ?? null,
        r.verdict?.match && !r.deferNotifiedAt ? now : null,
        r.applicationStatus,
        r.applicationStatusSource,
        r.applicationStatusSource === "pipeline" ? null : now,
        r.discoverySource ?? "fixed_board",
        r.criteriaVersion,
      );
}

export async function insertJobs(db: D1Database, rows: JobInsert[], lease?: DiscoveryLease): Promise<void> {
  const now = new Date().toISOString();
  const stmts = rows.map(r => jobInsertStatement(db, r, now));
  for (let i = 0; i < stmts.length; i += CHUNK) {
    const chunk = stmts.slice(i, i + CHUNK);
    if (lease) {
      // Persisted results and retry cleanup commit together. A crash between
      // two independent writes must not leave a resolved job in retry state.
      const ids = rows.slice(i, i + CHUNK).map(r => r.job.id);
      chunk.push(db.prepare(`DELETE FROM discovery_retries WHERE pipeline = ? AND job_id IN (${ids.map(() => "?").join(",")})`)
        .bind(lease.pipeline, ...ids));
    }
    await fencedBatch(db, lease, chunk);
  }
}

export async function recordRun(
  db: D1Database,
  summary: {
    sourcesOk: number;
    sourcesFailed: number;
    newPostings: number;
    alreadyAppliedSkipped: number;
    matches: number;
    errors: string[];
    worker?: string; // 'fixed_boards' (default) | 'unbounded_discovery'
  },
  lease?: DiscoveryLease,
): Promise<void> {
  await fencedBatch(db, lease, [db
    .prepare(
      `INSERT INTO pipeline_runs (ran_at, sources_ok, sources_failed, new_postings, already_applied_skipped, matches, errors, worker)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .bind(
      new Date().toISOString(),
      summary.sourcesOk,
      summary.sourcesFailed,
      summary.newPostings,
      summary.alreadyAppliedSkipped,
      summary.matches,
      JSON.stringify(summary.errors),
      summary.worker ?? "fixed_boards",
    )]);
}

export async function getRotationCursor(db: D1Database, lease?: DiscoveryLease): Promise<number> {
  const row = await db
    .prepare("SELECT next_phrase_index FROM search_rotation WHERE id = 1")
    .first<{ next_phrase_index: number }>();
  if (row) return row.next_phrase_index;
  await fencedBatch(db, lease, [db.prepare("INSERT INTO search_rotation (id, next_phrase_index) VALUES (1, 0) ON CONFLICT(id) DO NOTHING")]);
  return 0;
}

export async function advanceRotationCursor(db: D1Database, nextIndex: number, lease?: DiscoveryLease): Promise<void> {
  await fencedBatch(db, lease, [db.prepare("UPDATE search_rotation SET next_phrase_index = ? WHERE id = 1").bind(nextIndex)]);
}

// Records a verdict tapped from a Slack button. Returns false when no row
// matched, so the caller can surface "that message points at a job row that
// no longer exists" instead of silently reporting success.
export async function setApplicationStatus(
  db: D1Database,
  jobId: string,
  status: string,
  source: string,
  now: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE jobs
          SET application_status = ?,
              application_status_source = ?,
              application_status_updated_at = ?
        WHERE id = ?`,
    )
    .bind(status, source, now, jobId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}


export type PendingMatch = { job: NormalizedJob; verdict: Verdict; criteriaVersion: string };

export function notificationPipeline(discoverySource: string): "fixed_boards" | "unbounded_discovery" {
  return discoverySource === "fixed_board" ? "fixed_boards" : "unbounded_discovery";
}

// Stamp notified_at only after Slack accepts delivery. Assessed but undelivered
// matches remain in this recoverable notification queue across interruptions.
export async function getPendingNotifications(
  db: D1Database,
  discoverySource: string,
  limit: number,
  afterJobId: string | null = null,
  instanceId?: string,
): Promise<PendingMatch[]> {
  const { results } = await db
    .prepare(
      `SELECT id, company, title, url, location, department, is_remote, employment_type,
              posted_at, compensation, match_lane, match_hard_exclude, match_reason, criteria_version
         FROM jobs j
        WHERE match = 1 AND notified_at IS NULL AND discovery_source = ?
          AND application_status = 'not_applied' AND is_known_application = 0
          AND j.criteria_version=(SELECT criteria_version FROM candidate_active_configs WHERE instance_id=?)
          AND NOT EXISTS (SELECT 1 FROM discovery_retries r WHERE r.pipeline = ?
            AND r.job_id = j.id AND r.next_attempt_at > ?)
          AND (? IS NULL OR (j.first_seen_at,j.id) > (SELECT first_seen_at,id FROM jobs WHERE id=?))
        ORDER BY first_seen_at, id
        LIMIT ?`,
    )
    .bind(discoverySource, instanceId ?? null, notificationPipeline(discoverySource), Date.now(), afterJobId, afterJobId, limit)
    .all<any>();

  return results.map((r) => ({
    criteriaVersion: r.criteria_version,
    job: {
      id: r.id,
      company: r.company,
      title: r.title,
      url: r.url,
      location: r.location,
      department: r.department,
      isRemote: r.is_remote === null ? null : r.is_remote === 1,
      employmentType: r.employment_type,
      postedAt: r.posted_at,
      compensation: r.compensation,
      // Legacy notification rows omit bodies; evidence-mode snapshots live separately.
      description: null,
    },
    verdict: {
      match: true,
      hard_exclude: r.match_hard_exclude,
      lane: r.match_lane,
      reason: r.match_reason ?? "",
    },
  }));
}

// Repeat inside the send callback: a disposition or hold can change after
// the pending-list checkpoint without changing its memoized contents.
export async function isLegacyNotificationPending(db: D1Database, jobId: string, pipeline: "fixed_boards" | "unbounded_discovery", instanceId?: string, expectedVersion?: string): Promise<boolean> {
  if (!instanceId || typeof expectedVersion !== "string" || !expectedVersion) return false;
  const row = await db.prepare(`SELECT 1 AS pending FROM jobs j WHERE id=?
    AND match=1 AND notified_at IS NULL AND application_status='not_applied' AND is_known_application=0
    AND j.criteria_version=(SELECT criteria_version FROM candidate_active_configs WHERE instance_id=?)
    AND j.criteria_version=?
    AND NOT EXISTS (SELECT 1 FROM discovery_retries r WHERE r.pipeline=? AND r.job_id=j.id AND r.next_attempt_at>?)`)
    .bind(jobId, instanceId, expectedVersion, pipeline, Date.now()).first<{ pending: number }>();
  return row?.pending === 1;
}

export async function markNotified(db: D1Database, ids: string[], now: string, lease?: DiscoveryLease): Promise<void> {
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;
    await fencedBatch(db, lease, chunk.map((id) => db.prepare("UPDATE jobs SET notified_at = ? WHERE id = ?").bind(now, id)));
  }
}
