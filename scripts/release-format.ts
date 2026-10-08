import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export const REQUIRED = [
    "LICENSE",
    "docs/installation-results.md",
    "docs/release-notes.md",
    "scripts/release.ts",
    ".agents/skills/job-materials/SKILL.md",
    ".claude/skills/job-materials/SKILL.md",
    ".github/workflows/verify.yml",
    ".gitignore",
    ".release/public-manifest.json",
    "AGENTS.md",
    "CLAUDE.md",
    "README.md",
    "SETUP.md",
    "examples/boston-engineering.candidate.json",
    "examples/chicago-operations.candidate.json",
    "examples/instance.draft.json",
    "examples/instance.json",
    "examples/uk-review.candidate.json",
    "migrations/0001-screening-evidence.sql",
    "package-lock.json",
    "package.json",
    "schema.fixed-baseline-migration.sql",
    "src/operations/auth.ts",
    "src/discovery/baseline.ts",
    "schema.candidate-config-migration.sql",
    "schema.discovery-alias-migration.sql",
    "schema.discovery-candidates-migration.sql",
    "schema.discovery-controls-migration.sql",
    "schema.discovery-coverage-migration.sql",
    "schema.discovery-fixed-candidates-migration.sql",
    "schema.discovery-query-migration.sql",
    "schema.durable-manual-intake-migration.sql",
    "schema.ledger-migration.sql",
    "schema.lifecycle-migration.sql",
    "schema.radar-migration.sql",
    "schema.release-receipts-migration.sql",
    "schema.sql",
    "schema.unbounded-migration.sql",
    "schemas/candidate.schema.json",
    "schemas/instance.schema.json",
    "scripts/import-source.ts",
    "scripts/package-release.ts",
    "scripts/privacy-scan.ts",
    "scripts/release-format.ts",
    "scripts/verify-guides.ts",
    "scripts/verify-release.ts",
    "scripts/verify-runtime-imports.ts",
    "skills/onboard/SKILL.md",
    "skills/onboard/assets/Career_Evidence.template.md",
    "skills/onboard/assets/Writing_Preferences.template.md",
    "skills/prepare-application/SKILL.md",
    "src/board-digest.ts",
    "src/config/candidate.ts",
    "src/config/env.ts",
    "src/config/instance.ts",
    "src/config/policy.ts",
    "src/config/prompts.ts",
    "src/config/run-context.ts",
    "src/config/schedule.ts",
    "src/config/sources.ts",
    "src/config/types.ts",
    "src/criteria.ts",
    "src/db.ts",
    "src/description.ts",
    "src/discovery-preview.ts",
    "src/discovery/aliases.ts",
    "src/discovery/application-notifications.ts",
    "src/discovery/application-state.ts",
    "src/discovery/candidates.ts",
    "src/discovery/comparison.ts",
    "src/discovery/coverage.ts",
    "src/discovery/evidence.ts",
    "src/discovery/expanded-run.ts",
    "src/discovery/fetch.ts",
    "src/discovery/fixed-candidates.ts",
    "src/discovery/jobposting.ts",
    "src/discovery/observe.ts",
    "src/discovery/queries.ts",
    "src/discovery/query-execution.ts",
    "src/discovery/query-pages.ts",
    "src/discovery/query-provider.ts",
    "src/discovery/queue-integration.ts",
    "src/discovery/registry.ts",
    "src/discovery/resolve.ts",
    "src/discovery/safe-fetch.ts",
    "src/discovery/types.ts",
    "src/discovery/version.ts",
    "src/fetch-job.ts",
    "src/filter.ts",
    "src/index.ts",
    "src/intake/command.ts",
    "src/intake/delivery-store.ts",
    "src/intake/delivery.ts",
    "src/intake/dispatch.ts",
    "src/intake/store.ts",
    "src/intake/types.ts",
    "src/intake/workflow.ts",
    "src/ledger/import/aiapply.ts",
    "src/ledger/import/codex.ts",
    "src/ledger/import/legacy.ts",
    "src/ledger/import/plan.ts",
    "src/ledger/import/review.ts",
    "src/ledger/import/snapshot.ts",
    "src/ledger/import/sql.ts",
    "src/ledger/import/types.ts",
    "src/ledger/import/verify.ts",
    "src/ledger/match.ts",
    "src/ledger/normalize.ts",
    "src/ledger/transitions.ts",
    "src/ledger/types.ts",
    "src/lifecycle/classify.ts",
    "src/lifecycle/cron.ts",
    "src/lifecycle/db.ts",
    "src/lifecycle/decide.ts",
    "src/lifecycle/evidence.ts",
    "src/lifecycle/gmail-client.ts",
    "src/lifecycle/gmail-message.ts",
    "src/lifecycle/public-pages.ts",
    "src/lifecycle/record.ts",
    "src/lifecycle/slack-actions.ts",
    "src/lifecycle/slack-blocks.ts",
    "src/lifecycle/workflow.ts",
    "src/location-notifications.ts",
    "src/location.ts",
    "src/node-fs.d.ts",
    "src/operations/discovery-report.ts",
    "src/operations/discovery-run.ts",
    "src/operations/fetch.ts",
    "src/operations/filter-step.ts",
    "src/operations/leases.ts",
    "src/operations/retries.ts",
    "src/operations/run-health.ts",
    "src/radar/angle-rules.ts",
    "src/radar/budget.ts",
    "src/radar/collect.ts",
    "src/radar/db.ts",
    "src/radar/digest-blocks.ts",
    "src/radar/editor.ts",
    "src/radar/profile.ts",
    "src/radar/rank.ts",
    "src/radar/slack-actions.ts",
    "src/radar/sources.ts",
    "src/radar/text.ts",
    "src/radar/topics.ts",
    "src/radar/triage.ts",
    "src/radar/workflow.ts",
    "src/radar/x-client.ts",
    "src/screen-fixed-job.ts",
    "src/screening-holds.ts",
    "src/screening/confirmation-fixtures.ts",
    "src/screening/evaluate.ts",
    "src/screening/experiments/contracts.ts",
    "src/screening/experiments/qualification-candidate.ts",
    "src/screening/experiments/qualifications.ts",
    "src/screening/experiments/score.ts",
    "src/screening/policy-fixtures.ts",
    "src/screening/policy-report.ts",
    "src/screening/snapshot.ts",
    "src/screening/store.ts",
    "src/screening/types.ts",
    "src/screening/workflow.ts",
    "src/slack-text.ts",
    "src/slack.ts",
    "src/sources.ts",
    "src/step-stream.ts",
    "src/unbounded/discovery.ts",
    "src/unbounded/index.ts",
    "templates/wrangler.fixed.toml",
    "templates/wrangler.unbounded.toml",
    "tools/__init__.py",
    "tools/gmail-auth/auth.d.mts",
    "tools/gmail-auth/auth.mjs",
    "tools/materials/__init__.py",
    "tools/materials/check_bullets.py",
    "tools/materials/check_terms.py",
    "tools/materials/existing_package.py",
    "tools/materials/fetch-posting.ts",
    "tools/materials/jobs_queue.py",
    "tools/materials/measure_space.py",
    "tools/materials/render_letter.py",
    "tools/materials/render_resume.py",
    "tools/materials/requirements-macos-py312.lock",
    "tools/materials/requirements.txt",
    "tools/materials/style.py",
    "tools/materials/verify_ats.py",
    "tools/materials/workspace.py",
    "tools/setup/bootstrap.d.mts",
    "tools/setup/bootstrap.mjs",
    "tools/setup/cli.ts",
    "tools/setup/core-guards.d.mts",
    "tools/setup/core-guards.mjs",
    "tools/setup/preflight.ts",
    "tools/setup/render-config.ts",
    "tools/setup/resources.ts",
    "tools/setup/state.ts",
    "tools/setup/types.ts",
    "tsconfig.json",
    "tsconfig.tools.json",
    "vitest.config.ts",
    "vitest.integration.config.ts"
] as const;
export function safePath(path: string): boolean { return !!path && Buffer.byteLength(path) < 100 && !path.includes("\\") && !/[^\x20-\x7e]/.test(path) && !path.startsWith("/") && !path.includes(":") && !path.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git"); }
export function validateFiles(files: unknown): asserts files is string[] { if (!Array.isArray(files) || !files.every(p => typeof p === "string" && safePath(p)) || new Set(files.map(p => p.toLowerCase())).size !== files.length)
    throw new Error("Invalid or duplicate release paths"); for (const p of REQUIRED)
    if (!files.includes(p))
        throw new Error(`Required file absent: ${p}`); }
export function tar(entries: readonly {
    path: string;
    bytes: Buffer;
}[]): Buffer {
    const chunks: Buffer[] = [];
    for (const { path, bytes } of entries) {
        if (!safePath(path))
            throw new Error("Invalid archive path");
        const header = Buffer.alloc(512);
        header.write(path);
        const oct = (n: number, offset: number, size: number) => header.write(n.toString(8).padStart(size - 1, "0") + "\0", offset, size);
        oct(0o644, 100, 8);
        oct(0, 108, 8);
        oct(0, 116, 8);
        oct(bytes.length, 124, 12);
        oct(0, 136, 12);
        header.fill(32, 148, 156);
        header[156] = 48;
        header.write("ustar\0", 257);
        header.write("00", 263);
        const sum = header.reduce((a: number, b: number) => a + b, 0);
        header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
        chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
    }
    chunks.push(Buffer.alloc(1024));
    return Buffer.concat(chunks);
}
export function untar(bytes: Buffer): Map<string, Buffer> {
    const result = new Map<string, Buffer>();
    let offset = 0;
    const seen = new Set<string>();
    while (offset + 512 <= bytes.length) {
        const h = bytes.subarray(offset, offset + 512);
        if (h.every(n => n === 0)) {
            if (bytes.length - offset < 1024 || !bytes.subarray(offset).every(n => n === 0))
                throw new Error("Invalid archive terminator");
            return result;
        }
        const string = (start: number, end: number) => h.subarray(start, end).toString().split("\0")[0];
        const path = string(0, 100), sizeText = string(124, 136), sumText = string(148, 156).trim();
        if (!safePath(path) || seen.has(path.toLowerCase()))
            throw new Error("Unsafe or duplicate archive path");
        if (h[156] !== 48 || string(157, 257) || string(345, 500))
            throw new Error("Links or extended archive entries rejected");
        if (string(257, 263) !== "ustar" || !/^[0-7]+$/.test(sizeText) || !/^[0-7]+$/.test(sumText))
            throw new Error("Invalid archive header");
        const copy = Buffer.from(h);
        copy.fill(32, 148, 156);
        if (copy.reduce((a: number, b: number) => a + b, 0) !== parseInt(sumText, 8))
            throw new Error("Archive header checksum failed");
        const size = parseInt(sizeText, 8);
        if (size > 64 * 1024 * 1024 || offset + 512 + size > bytes.length)
            throw new Error("Invalid archive size");
        seen.add(path.toLowerCase());
        result.set(path, bytes.subarray(offset + 512, offset + 512 + size));
        offset += 512 + Math.ceil(size / 512) * 512;
    }
    throw new Error("Missing archive terminator");
}
