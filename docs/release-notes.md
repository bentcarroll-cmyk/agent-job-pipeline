# v0.1.0-beta.2 evaluation beta

Agent Job Pipeline is a source-available personal evaluation workflow for an operator's own job search. The [license](../LICENSE) allows personal setup, inspection and private modification. Commercial use, redistribution and service operation require the owner's permission. This is not an open-source license.

## Changes since v0.1.0-beta.1

- `/job` and requested materials read Oracle Recruiting Cloud postings.
- The application tracker records one interview round per interview, not one per email thread, and files a reply whose wording matches no application under the application the rest of its thread belongs to.
- Later mail in a round's thread no longer moves its time once the round has happened. The mailbox owner's own sent mail and drafts set no interview time and open no later round. An employer's first scheduling email starts round 1, and a time a scheduling email moved can be undone from Slack.
- A known application is recognized by requisition under either half of an "A / B" employer name, including one recorded with a link that names no posting.
- The release tool publishes a later version beside the earlier published release, without changing it.

## Scope

The workflow separates the approved candidate profile, private career workspace and hosted D1 ledger. It includes scheduled discovery, verification and screening, Slack review and `/job` intake, Gmail lifecycle reconciliation, and requested application materials through shared Codex and Claude Code skills. The optional AI radar starts disabled. Materials preparation never establishes submission.

The measured local platform is macOS arm64, Node 22 and Python 3.12, with macOS Arial document checks. Linux, Windows and other architectures are unvalidated. Python dependency versions are pinned for the measured platform; wheel artifacts are not hash-locked. No fonts are distributed. Read [installation results](installation-results.md) before interpreting any support claim; they were measured on v0.1.0-beta.1 and have not been repeated for this beta.

This beta implements the full workflow but does not claim verified hosted installation. Full native setup and live discovery, Slack callbacks, Gmail consent/recovery and resource cleanup remain unverified. Beta publication requires passed local workflow checks, material and visual evidence, matching hosted CI and independent immutable review. All nine acceptance statuses remain visible; any known failed check blocks release. A stable release requires all nine actual checks passed. The beta is a GitHub prerelease, never the latest stable release.

## Setup prompt after publication

> Set up Agent Job Pipeline from https://github.com/bentcarroll-cmyk/agent-job-pipeline at the reviewed v0.1.0-beta.2 prerelease. Read SETUP.md and AGENTS.md. Help me select a private career workspace outside the checkout, interview me from my resume, and review the exact readable criteria and machine configuration before recording my approval. Identify enabled services, account choices, schedules and costs before authorized external actions. Keep secrets out of chat and preserve resumable private receipts. Distinguish actual account checks from synthetic and offline checks. Prepare application materials only when I request them.

The repository/release in this prompt is the intended destination; this candidate document does not assert that it already exists publicly. Check the final publication readback receipt and downloaded asset checksum first.

## Known limits

- Human account selection, login and consent remain necessary. A fresh Slack app requires an unused workspace-wide `/job` command; a separate channel alone does not isolate a conflicting command.
- Setup emits operational configuration after reviewed activation, then deployment requires its own authorized execution. Preserve uncertain resource intents and reconcile provider truth before retrying.
- Gmail consent is read-only for the selected account. Testing-mode token expiry and recovery require observed checks. Select your own account and consent explicitly before any live operation.
- Missing macOS Arial or an ambient legacy Wrangler configuration currently blocks isolated preflight. Do not move another operator's files or change HOME to bypass the block.
- Heuristic privacy scans supplement independent disclosure review. Start publication from the explicit committed-file manifest and fresh history; never push extraction/development history.
