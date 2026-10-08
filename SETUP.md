# Guided setup on macOS

This is the `0.1.0-beta.1` evaluation beta. Local verification is scoped to macOS arm64. Full native installation and live discovery, Slack, Gmail and resource cleanup remain unverified; setup still requires your own selected accounts, credentials and consent. Beta publication does not establish successful hosted installation.

Copy this prompt into Codex or Claude Code. The repository and prerelease below are the intended setup destination. Use this prompt only after verifying the published `v0.1.0-beta.1` tag, final publication readback receipt and downloaded asset checksum; this guide does not assert that publication has occurred.

> Set up Agent Job Pipeline from https://github.com/bentcarroll-cmyk/agent-job-pipeline at the reviewed v0.1.0-beta.1 prerelease. Read SETUP.md and AGENTS.md. Help me select a private career workspace outside the checkout, interview me from my resume, and review the exact readable criteria and machine configuration before recording my approval. Identify enabled services, account choices, schedules and costs before authorized external actions. Keep secrets out of chat and preserve resumable private receipts. Distinguish actual account checks from synthetic and offline checks. Prepare application materials only when I request them.

## Assistant access

Both assistants follow this guide and the same canonical skills. In Codex, open the release checkout and ensure the selected external workspace is writable; a CLI session may use `--add-dir /absolute/private/workspace`. Inspect installed `codex exec --help` before noninteractive work. `exec` defaults to read-only; explicit `--sandbox workspace-write` is needed for file edits, and `--json` / `--output-last-message` can capture receipts. Do not bypass approvals or read saved authentication files. See official [project instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md) and [noninteractive execution](https://learn.chatgpt.com/docs/non-interactive-mode).

In Claude Code, start in the release checkout, confirm that CLAUDE.md imports AGENTS.md, and inspect installed `claude --help`. Grant the selected workspace through the session's directory access (`--add-dir /absolute/private/workspace` where supported). The repository `.claude/skills` adapter delegates material requests; it disables model-initiated invocation. `--print` is a documented noninteractive mode, not proof that local files, browser or PDF images are accessible. See official [skills](https://code.claude.com/docs/en/skills) and [headless execution](https://code.claude.com/docs/en/headless).

For either assistant, establish actual shell/file tools, macOS browser consent, Python/PDF tools, and the ability to inspect rendered images. Browser automation is not guaranteed by either guide. Human login and consent can happen manually. Never call an instruction-only or fake-adapter walkthrough a real installation. Live assistant/account acceptance is a separate release check.

## 1. Select workspace and approve the profile

All `/absolute/private/workspace` and `/absolute/python3.12` paths below are placeholders. Resolve them to the selected real paths; do not use another person's defaults. The workspace must be outside the release checkout and protected source directories, including after symlink resolution.

Read [onboarding](skills/onboard/SKILL.md). Copy the selected resume byte for byte into the private workspace, interview the candidate, and reconcile direct corrections into the reviewed factual Markdown/JSON digest and writing preferences. Keep unresolved evidence gaps explicit. Create private `materials.json` using that skill's schema; choose resume page count and whether letters are wanted.

Prepare private `criteria.md` and `candidate.json` using [candidate schema](schemas/candidate.schema.json). Review readable eligibility, employment type, clearance, comparable annual base pay/currency, commute/remote arrangements, function lanes, search banks and employer sources. Remote alone does not prove eligibility; incomparable pay requires review. After the candidate approves the actual readable bytes and machine configuration, record SHA-256 of the readable file, `candidatePolicyHash(policy)` and `candidateCriteriaVersion(candidate)` as `readableSha256`, `policySha256` and `configSha256`, plus the real approval time. Functions live in [candidate configuration](src/config/candidate.ts). Setup verifies approvals; it does not manufacture them. Any changed search bank or policy requires fresh review.

Create private `instance.json` from the synthetic [draft](examples/instance.draft.json), guided by [instance schema](schemas/instance.schema.json). Set your own account, operator contact, Slack channel/user, flags and schedule. The database ID stays null until provisioning. The examples are fabricated, not working accounts, approved criteria or resource ownership receipts.

## 2. Check local capabilities

Use Node 22 and an explicitly selected Python 3.12 executable. Create the selected external workspace directory first with private permissions. From the release checkout, bootstrap locked dependencies using core Node only; no checkout `node_modules` or global installation is needed:

```sh
node tools/setup/bootstrap.mjs --workspace /absolute/private/workspace
```

Bootstrap preserves HOME, uses private npm configuration/cache, refuses escaped/special setup paths, and shares the workspace lock. It returns the exact private loader path. Replace the loader placeholder in each command below with that returned absolute path. The check installs/verifies private dependencies and a copied-executable Python environment under `.setup`, then tests real macOS Arial embedding, text extraction and rasterization. See [dependency isolation and prerequisites](docs/setup.md).

```sh
node --import /absolute/private/workspace/.setup/dependencies/node_modules/tsx/dist/loader.mjs tools/setup/cli.ts check --workspace /absolute/private/workspace --instance /absolute/private/workspace/instance.json --python /absolute/python3.12
node --import /absolute/private/workspace/.setup/dependencies/node_modules/tsx/dist/loader.mjs tools/setup/cli.ts status --workspace /absolute/private/workspace --instance /absolute/private/workspace/instance.json
```

Keep HOME, CODEX_HOME and global configuration unchanged. Missing Arial currently blocks setup preflight. For requested materials after preflight, macOS Arial is the default; an explicitly selected installed Liberation Sans directory and `--font-family "Liberation Sans"` are supported with pinned regular/bold/font-license hashes. This is not an automatic setup fallback. No fonts are vendored; see the [canonical PDF checks and installed font option](skills/prepare-application/SKILL.md). Other platforms remain unvalidated.

## 3. Authorize selected accounts and provision

Read [accounts](docs/accounts.md). Confirm exact account/channel/user and intended service usage. The operator supplies `CLOUDFLARE_API_TOKEN` privately for the selected account; never paste or interpolate it into chat/command arguments. When authorized:

```sh
node --import /absolute/private/workspace/.setup/dependencies/node_modules/tsx/dist/loader.mjs tools/setup/cli.ts resources --workspace /absolute/private/workspace --instance /absolute/private/workspace/instance.json --provider-writes approved
```

The CLI records random resource names/intents before writes, checks account-scoped opaque IDs and database ownership, and initializes the complete schema with migration receipts. It updates the selected instance file with actual IDs. It creates Worker metadata, not deployed code. Resume using the same workspace; do not delete uncertain intents or adopt resources by matching names. Slack app installation, callback settings and credential storage remain separate guided account steps. Require a fresh app and an unused `/job` namespace; use another Slack workspace when an active app owns `/job`. Never repoint an existing app or its commands.

## 4. Preview and authorize Gmail if enabled

```sh
node --import /absolute/private/workspace/.setup/dependencies/node_modules/tsx/dist/loader.mjs tools/setup/cli.ts preview --workspace /absolute/private/workspace --instance /absolute/private/workspace/instance.json
```

This validates approval/bindings and performs both offline Worker builds. `.setup/preview.json` records `livePreview:false`; preview/shadow configs have empty schedules and disabled operational entries. Review screening examples and unknown/review outcomes separately. Neither build proves real source discovery, model access, Slack delivery, Gmail consent or account quota.

When lifecycle is selected, review generated `/` and `/privacy` pages for the configured operator after their authorized hosting, configure your Google project/installed OAuth client and actual mode, then follow [Gmail setup](docs/lifecycle-setup.md). Human consent must name the selected Gmail account and read-only processing, including classification through Workers AI without Gateway logging/caching. With explicit authorization and selected account credentials:

```sh
node --import /absolute/private/workspace/.setup/dependencies/node_modules/tsx/dist/loader.mjs tools/gmail-auth/auth.mjs --instance /absolute/private/workspace/instance.json --client /absolute/private/workspace/oauth-client.json --workspace /absolute/private/workspace
```

The helper routes the three Gmail secrets directly to the instance's unbounded Worker through stdin; show only redacted success/failure. No browser grant or upload is implied by an offline test. Testing tokens normally need reauthorization after seven days; the local `oauthMode` flag does not publish or verify a Google app.

## 5. Review schedule and activation

Show timezone, five-minute local times, ISO discovery weekdays, lifecycle/radar enablement, channel destinations, data budget and service usage. Radar is off by default, requires neither X nor Anthropic credentials while disabled, and prepares private digest drafts only. When enabled, choose supported IDs: `enterprise_adoption`, `agents_in_operations`, `operating_models`, `governance_policy`, `frontier_releases`, `ai_economics`, `data_analysis`, `hands_on`. Hiring queries come from approved function phrases. Set an explicit channel, positive monthly data budget and daily radar time. The budget meters estimated X data costs; it is not a total-service billing cap. Changing instance choices invalidates preview/review fingerprints.

Only after approval of these exact choices and verified resources:

```sh
node --import /absolute/private/workspace/.setup/dependencies/node_modules/tsx/dist/loader.mjs tools/setup/cli.ts activate --workspace /absolute/private/workspace --instance /absolute/private/workspace/instance.json --provider-writes approved
```

The first invocation intentionally stops with `ACTIVATION_REVIEW_REQUIRED` and writes `.setup/activation-review.json`. Externally suspend scheduled/manual delivery, drain running Workflows and reconcile uncertain Slack requests; record truthful `externalQuiesced`, `receiptsReconciled`, evidence and current `reviewedAt`. Do not assert live checks or external suspension from an offline test. Review the current active revision and exact hashes/resource IDs, then:

```sh
node --import /absolute/private/workspace/.setup/dependencies/node_modules/tsx/dist/loader.mjs tools/setup/cli.ts activate --workspace /absolute/private/workspace --instance /absolute/private/workspace/instance.json --provider-writes approved --review /absolute/private/workspace/.setup/activation-review.json
```

Activation independently checks active criteria and performs reviewed D1 compare-and-swap. It emits `.setup/generated/wrangler.fixed.operational.toml` and `wrangler.unbounded.operational.toml`, with one UTC five-minute dispatcher per Worker for the approved local calendar. It does not deploy either Worker. Spring-forward skipped local slots are skipped; repeated fall-back slots deduplicate by local slot, while intake recovery runs on every UTC tick. Live deployment, callback registration, cron capacity, provider costs and controlled acceptance need separately authorized execution. Keep real deployment and live acceptance receipts separate from activation and offline checks.

## 6. Resume and operate

Use `status` to inspect receipts, then rerun the blocked stage against the same selected files and resources. Read [recovery](docs/recovery.md) for uncertain provider writes, locks, Gmail failures and changed approvals; use [upgrades](docs/upgrades.md) when changing a reviewed release.

D1 is authoritative for jobs and application state. Slack review and manual intake do not prepare materials automatically. On a request such as “prepare materials for this exact job ID using my selected materials.json”, Codex's `.agents/skills/job-materials` or Claude's `.claude/skills/job-materials` delegates to [prepare-application](skills/prepare-application/SKILL.md). Review real PDF pages before `materials_ready`. Packages and readiness do not imply application submission, uploaded versions or receipt-confirmed status. Setup sends no employer messages.
