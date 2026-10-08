# Gmail lifecycle setup and recovery

Each operator authorizes only their own Gmail account for their separately selected instance. Classification uses the approved candidate display name. The app and privacy pages use `instance.operator.displayName` and `contactEmail`. Review those generated pages and the processing description before adding their URLs to Google's OAuth Branding configuration.

The Worker needs operational `INSTANCE_CONFIG` and approved `CANDIDATE_CONFIG` bindings. A draft with a null database ID is rejected. `instance.lifecycle.since` is the history floor used for catch-up, with 48 hours of overlap after the last completed checkpoint. `lifecycle.enabled=false` and `LIFECYCLE_MODE=off` read no mail. Only the literal `live` reconciles the application ledger. Every other mode is test mode: test receipts and test Slack summaries, without application ledger changes or advancement of the live checkpoint. Set the mode explicitly during setup. Keep the configured AI Gateway ID and do not enable request logging or caching for lifecycle classification.

## OAuth prerequisites and modes

Create an installed/Desktop OAuth client in the operator's own Google Cloud project, enable the Gmail API, and save the downloaded client JSON in the operator's private workspace. The helper accepts the JSON's `installed.client_id` and `installed.client_secret`; it requests only `https://www.googleapis.com/auth/gmail.readonly`. It never sends, changes, labels or deletes mail. It uses a local loopback callback, fresh state and PKCE, and opens consent in the local macOS browser without printing an authorization URL.

`instance.lifecycle.oauthMode` documents the operator's actual Google setup. It does not change Google's publishing status or confer verification:

- `testing`: the operator must be an allowed test user. With Gmail's scope, Testing refresh tokens normally expire after seven days; sign in again when recovery is required.
- `personal`: a personal-use deployment may qualify for Google's verification exception. The operator must check Google's requirements and any unverified-app warning or user limit. Choosing this flag does not publish the app or prevent expiry by itself.
- `verified`: use this description only after Google's actual verification requirements have been satisfied for the configured project and requested scope.

See Google's [OAuth 2.0 guide and token-expiration requirements](https://developers.google.com/identity/protocols/oauth2) and [verification exceptions](https://support.google.com/cloud/answer/13464323). Hosting public pages is one setup input, not evidence of verification.

## Local command and credential destination

From this new extraction checkout, with its installed dependencies and Node 22 runtime:

```sh
node --import /absolute/private/workspace/.setup/dependencies/node_modules/tsx/dist/loader.mjs tools/gmail-auth/auth.mjs --instance /absolute/private/workspace/instance.json --client /absolute/private/workspace/oauth-client.json --workspace /absolute/private/workspace
```

The optional explicit `--workspace` selects guarded private Wrangler dependencies; supply it for nested instance files. Without it, the instance file's parent is the dependency workspace. No checkout-local dependency fallback is used. The instance must already contain the new account and provisioned database ID. Human consent happens in the browser. No consent or provider call occurs merely from importing the helper or requesting its usage output. Successful output contains only `ok`, `instanceId` and `workerName`; failure output is generic and contains no tokens, provider response body or sensitive authorization state.

The helper validates the selected operational instance using the shared parser, then writes `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` and `GMAIL_REFRESH_TOKEN` directly to its `cloudflare.unboundedWorkerName` in its `cloudflare.accountId`. Each upload uses a private temporary generated Wrangler config naming exactly that account/worker, runs from that isolated directory, and sends secret values through stdin. It cannot discover another checkout's Wrangler config. Subprocess stdout/stderr are discarded. The operator must privately supply `CLOUDFLARE_API_TOKEN` authorized for the selected Cloudflare account before invoking the helper; missing token or private Wrangler capability fails before Google consent. The child receives only that explicit token and selected account ID, with HOME preserved, private XDG/cache/log/temp paths, keyring/dotenv discovery disabled, and metrics/error reporting disabled. It inherits no other ambient credential, proxy or configuration variables. Existing `~/.wrangler` causes the same isolation refusal as offline setup before consent, without reading or moving it; refusal/path checks repeat before every upload. Upload temporary files are under the selected workspace's private `.setup/tmp`. Tokens are never printed for manual copy/paste. Client JSON stays private and must not be committed or put in configuration bindings.

On sign-in recovery, rerun the same command with the same selected instance and private client file. A failed upload may have saved only some of the three secrets; rerun the complete command to finish consistent storage. Never recover by copying credentials from another operator or from the protected source instance.

## Recovery and data boundaries

A failed/revoked grant or rejected Gmail authorization stops the batch. Completed classifications are reconciled and their receipts survive; failed and unprocessed mail remains retryable and the checkpoint stays unchanged. The next successful run skips settled live receipts and catches up. Preview/test receipts do not consume eligibility for a later live run: live processing fetches and classifies those messages again, including previews inside the history floor but outside an older preview-advanced checkpoint. It uses the current ledger and a fresh live classification retry budget, preserving the preview's original creation time. Preview writes cannot overwrite live receipts. Authorization failure does not consume a message's three classification attempts. Model/transient classification failures keep the established retry receipt behavior.

When live processing replaces a preview, its ledger, interview/schedule writes and receipt save run in one D1 transaction. Eligibility must still be a preview at the start of the transaction; a competing settled live receipt, a live retry, or a missing preview aborts those writes. A losing attempt reports the actual stored decision and preserves the live attempt budget. Ordinary live receipts continue to dedupe, and explicit Slack answers/undo retain their existing behavior.

Email text is read only inside classification steps and sent to Workers AI with AI Gateway `collectLog:false` and `skipCache:true`. Durable step outputs contain identifiers, headers, classification fields or redacted status, never bodies or credentials. The ledger keeps only documented email metadata, classification and receipt decisions. Recovery errors and Slack alerts omit raw provider/model errors.

## Setup handoff for Tasks 7 and 10

Task 7 should generate the operational instance and both Worker configs, bind lifecycle mode explicitly, and provision the selected account resources before invoking authorization. Invoke this helper only with explicit operator consent for the selected new Gmail account. Reuse `authorizeAndStore(rawInstance, clientJson, { authorize, writeSecret })` for setup orchestration and offline checks; its returned status is safe to display. `writeSecret` receives `{accountId, workerName}`, secret name and private value internally and must never log arguments.

Record actual Google mode and human authorization results separately from offline checks. Local tests use fabricated email messages, temporary D1 databases, fake OAuth grants and intercepted subprocesses. They prove code behavior and credential routing, not real Google consent, token longevity, verification or deployed acceptance. Those live checks require separately selected and authorized test resources.
