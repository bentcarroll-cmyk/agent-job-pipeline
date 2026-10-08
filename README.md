# Agent Job Pipeline

A personal job-search workflow with scheduled discovery, posting verification and screening, Slack review and manual intake, a durable Cloudflare D1 ledger, optional Gmail reconciliation, and application materials prepared when you request them. Each operator uses their own accounts and a separately selected private career workspace. Missing information stays unknown or requires review.

Give Codex or Claude Code the installation prompt below, then follow [SETUP.md](SETUP.md). Start with macOS, Node 22 and Python 3.12; other platforms have not passed installation and document checks. Setup is resumable, and guides distinguish offline checks from deployment and live acceptance.

The repository and prerelease below are the intended setup destination. Use this prompt only after verifying the published `v0.1.0-beta.1` tag, final publication readback receipt and downloaded asset checksum; this guide does not assert that publication has occurred.

> Set up Agent Job Pipeline from https://github.com/bentcarroll-cmyk/agent-job-pipeline at the reviewed v0.1.0-beta.1 prerelease. Read SETUP.md and AGENTS.md. Help me select a private career workspace outside the checkout, interview me from my resume, and review the exact readable criteria and machine configuration before recording my approval. Identify enabled services, account choices, schedules and costs before authorized external actions. Keep secrets out of chat and preserve resumable private receipts. Distinguish actual account checks from synthetic and offline checks. Prepare application materials only when I request them.

Read [account requirements](docs/accounts.md), [setup mechanics](docs/setup.md), [Gmail consent and recovery](docs/lifecycle-setup.md), [upgrades](docs/upgrades.md), and [recovery](docs/recovery.md). Assistant contracts are in [AGENTS.md](AGENTS.md); requested materials follow one [canonical procedure](skills/prepare-application/SKILL.md).

The AI radar is optional. Disabled radar requires no X data-provider or Anthropic account or credentials. Enabled radar follows the approved candidate interests, selected topics, timezone and data budget. Radar angles are private source-grounded drafts for review.

This extraction has synthetic/offline verification. Real clean installation through each assistant and controlled live deployment acceptance remain release checks; these guides do not establish that those checks passed. No application submission or employer messaging happens during setup.

## Release status and license

v0.1.0-beta.1 is an evaluation beta with local checks on macOS arm64. The full workflow is implemented, but complete native installation and live discovery, Slack, Gmail and cleanup have not been verified. Use your own explicitly selected accounts; successful hosted setup is not promised. See [observed installation results](docs/installation-results.md), [release notes](docs/release-notes.md) and [publication gates](docs/release-checklist.md). This software is source-available under the [Personal Evaluation License](LICENSE); commercial use and redistribution require separate permission.
