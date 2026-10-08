---
name: onboard
description: Build or correct a private evidence-backed candidate workspace through a resume interview and writing preferences, then hand it to the resumable pipeline setup.
---

Select a private absolute workspace outside this source checkout and the reference checkout. Follow `tools/setup/cli.ts` and `docs/setup.md` for account/resource setup; this skill handles career inputs, not provider creation or deployment. Do not read another person's career files or carry their settings into this workspace.

Copy a supplied source resume with `tools.materials.workspace.capture_source_resume`; retain its stored path and SHA-256 receipt. The copy is byte-for-byte evidence, not an editable canonical profile. Interview the candidate in plain language, using the resume to avoid questions already answered. Establish factual role history, scope, outcomes, attribution, current corrections, target roles and writing preferences. Preserve unknowns and ask targeted follow-ups. The candidate never needs to author JSON or evidence IDs.

Use [Career_Evidence.template.md](assets/Career_Evidence.template.md) and [Writing_Preferences.template.md](assets/Writing_Preferences.template.md) in the private workspace. The assistant maintains a schemaVersion 1 JSON digest inside the evidence Markdown: `facts` contains stable IDs and factual text; `corrections` replaces existing IDs with the candidate's latest corrected text. Add source/provenance fields as useful. Retain original facts for audit; explicit corrections prevail. When correcting an earlier correction, replace its row so each ID appears once per section. Do not encode contradictory statements as separate unrelated facts. Keep the original resume and interview/source receipts private.

Review the readable corrected facts with the candidate, including scope and attribution. Incorporate every direct prose correction before material preparation. `load_evidence` accepts exactly one JSON block plus Markdown headings and rejects unreconciled prose, invalid IDs, unknown correction targets, duplicates and unsupported versions. Do not discard notes to make this gate pass; reconcile them into factual records or preserve unresolved questions in a separate private interview note and resolve them before making related claims. Unrecognized source formats require an assistant interview/digest, not a silent fallback.

Create private `materials.json` with the following shape, using the candidate's selected values. Paths resolve inside this workspace, including through symlinks. Required evidence/preferences/instance files must exist; configuration version mismatch stops preparation.

```json
{
  "schemaVersion": 1,
  "workspaceRoot": "/absolute/private/workspace",
  "careerEvidencePath": "Career_Evidence.md",
  "writingPreferencesPath": "Writing_Preferences.md",
  "applicationsRoot": "applications",
  "instanceConfigPath": "instance.json",
  "resumePages": 2,
  "coverLetterEnabled": true
}
```

Keep `materials.json` at the workspace root. The instance file may be nested inside that workspace: queue tools resolve its matching ancestor materials configuration and select the matching `.setup/generated/wrangler.unbounded.operational.toml`, or the preview configuration when the operational file is absent, and verify its DB binding. Instance configuration contains resource IDs, never secret values. Use the approved profile/setup tools for candidate criteria; the evidence digest does not replace the hosted ledger or approved screening configuration. Verify workspace dependencies and the selected font availability. Arial remains the default on macOS; do not substitute it silently. The optional installed Liberation Sans fallback uses an explicitly selected absolute `MATERIALS_FONT_DIR`, `--font-family "Liberation Sans"`, and the pinned fonts/OFL license checks documented in [prepare-application](../prepare-application/SKILL.md). Record the chosen family and repeat rendered reviews. Its document checks were performed on macOS; no other platform is advertised until its installation, licensed fonts and rendered document checks pass. Prepare application packages only when requested, through [prepare-application](../prepare-application/SKILL.md).
