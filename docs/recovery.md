# Resume from evidence

Run `status` as shown in [SETUP.md](../SETUP.md), retain `.setup` receipts and intents, and rerun the blocked stage against the same selected workspace/instance. Stage completion states are scoped: an offline preview is not live acceptance, and emitted operational configs are not deployed schedules.

| Symptom | Recovery |
| --- | --- |
| `SETUP_LOCKED` | Establish that the recorded process has stopped. Only then explicitly remove that workspace's `.setup/lock`. Never steal based on age/PID alone; preserve all other state. |
| `RESOURCE_CREATION_UNCERTAIN` | Inspect provider truth for the exact persisted intent/account/name/opaque ID. Do not delete the intent, create a differently named replacement or retry while a write might still be in flight. |
| Ownership conflict, ambiguous/missing/replaced resource, migration hash mismatch | Stop and reconcile identity/provenance with the operator. Table presence and name matches do not establish ownership. Do not overwrite another deployment or import its records. |
| Approval mismatch, `PREVIEW_STALE`, `ACTIVE_REVISION_CHANGED` | Review actual current files/bytes and D1 revision. Obtain fresh applicable approval, rerun preview and generate a new activation review. Do not edit hashes/revisions just to force a gate. |
| `ACTIVATION_REVIEW_REQUIRED` | Expected first activation stop. Record actual external suspension/drain and uncertain Slack receipt reconciliation in the generated review before submitting it. A started Slack request cannot be recalled. |
| Lost activation response | Resume with the retained exact intent/review. Reconciliation permits only the expected revision+1 and hash; a newer unrelated active revision requires review. |
| Missing runtime, dependency/font/PDF capability | Use Node 22, selected Python 3.12 and isolated workspace dependencies. Keep macOS Arial for setup preflight; the explicit installed Liberation Sans option applies to material rendering only. Recheck real rendered documents. |
| `AMBIENT_WRANGLER_CONFIG_UNISOLATED` | Locked Wrangler prefers existing `~/.wrangler` over private XDG paths. Setup refuses without reading/moving it or changing HOME. Use a verified supported host/tool isolation arrangement; do not delete user settings or redirect HOME to bypass the gate. |
| Gmail declined, revoked/expired grant or partial secret upload | Use the same selected instance/private OAuth client and [read-only consent helper](lifecycle-setup.md). Rerun all three writes; never print/copy tokens or another person's grant. Testing normally needs reauthorization after seven days. |
| Slack/model/search failure or uncertain delivery | Keep durable retries, leases and delivery receipts. Reconcile provider evidence before replaying a send. A failure alert or test fixture is not proof of live delivery. |
| Radar budget exhausted or unknown topic | No extra X request starts below the existing page-cost budget check. Review selected supported topic IDs/positive data budget and timezone; rerun preview/review after instance changes. Disable radar without disabling the job workflow. |

Gmail authorization failure leaves the live checkpoint unchanged and settled classifications/receipts intact; failed mail remains retryable. Live processing reclassifies eligible earlier test/preview receipts using the current ledger. Test mode does not advance the live checkpoint or mutate application status. See [lifecycle recovery details](lifecycle-setup.md).

Private application packages survive ledger status conflicts; the candidate's newer action wins. Existing exact-ID legacy or ambiguous material folders require explicit resolution before new allocation. Prepared files do not prove submission. Review package and job ID through the [canonical material procedure](../skills/prepare-application/SKILL.md).
