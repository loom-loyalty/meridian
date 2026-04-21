# Real-CF E2E CI Setup

The `.github/workflows/e2e-cloudflare.yml` workflow deploys the
runtime-cloudflare test worker to a real Cloudflare account on every
push to `main`, hits a smoke endpoint to verify the deploy works, then
tears down. It's gated on two repo secrets — until they're set the
workflow prints a notice and skips, so it's safe to merge this file
before the CF-side setup is done.

This doc is the setup checklist. ~10 minutes if you already have a
Cloudflare account.

## What you need

1. A Cloudflare account. Either:
   - **New dedicated `meridian-ci` account** (the plan's preferred
     option; keeps CI costs separated from production Shuttle billing
     once that ships), or
   - **Existing Loom Loyalty account** with a scoped API token that
     only grants access to `meridian-runtime-cloudflare-ci`. Fine for
     now; switch to a dedicated account when Shuttle goes live.

2. The account's **Account ID** (Dashboard → right sidebar → "Account ID").

3. A scoped **API Token** with these permissions:
   - **Account** → **Workers Scripts** → **Edit**
   - **Account** → **Workers Durable Objects** → **Edit**

   Everything else stays at "Deny". Scope the token to the single
   account you picked in step 1. Don't use a Global API Key — it has
   unscoped blast radius.

## Setup steps

### 1. Create the API token

```bash
# Dashboard flow (easiest):
# 1. https://dash.cloudflare.com/profile/api-tokens
# 2. "Create Token" → "Create Custom Token"
# 3. Name: "meridian-ci-e2e"
# 4. Permissions:
#    - Account | Workers Scripts | Edit
#    - Account | Workers Durable Objects | Edit
# 5. Account Resources: Include | <your account>
# 6. TTL: optional (recommend 1 year + calendar reminder to rotate)
# 7. Copy the token — Cloudflare shows it exactly once
```

### 2. Add the GitHub repo secrets

```bash
gh secret set CLOUDFLARE_API_TOKEN --body "<paste the token>"
gh secret set CLOUDFLARE_ACCOUNT_ID --body "<paste the account id>"
```

Or via the web UI: **Repo Settings → Secrets and variables → Actions → New repository secret**.

### 3. Set billing alerts

Cloudflare does **not** hard-cap spending at the account level. The
workflow tears down after every run, but a broken teardown could
accumulate cost. Configure a soft cap:

1. Dashboard → **Billing** → **Notifications**
2. Add a "Workers Usage" alert at the dollar threshold you're
   comfortable with (suggest $10/month for CI-only).
3. Add an "Account Usage" email alert.

Cloudflare sends notifications, it does not auto-suspend. Check the
alerts once a week until the workflow has been running for a month.

### 4. Trigger the workflow manually (first run)

```bash
gh workflow run e2e-cloudflare.yml
gh run watch
```

Expected result (~1-2 min):

- `Check CF secrets` job passes (secrets detected)
- `Deploy + smoke + teardown` job:
  - `Deploy test worker to Cloudflare` → prints the `.workers.dev` URL
  - `Smoke — fetch root endpoint` → JSON matches `{runtime, milestone, healthy}`
  - `Teardown — delete CI worker` → worker removed

### 5. Add the workflow to branch protection (optional)

Once you've verified a few clean runs, consider adding the E2E job
as a required check on PRs to `main`. Alternatively, label specific
PRs with `e2e-cloudflare` to trigger E2E on that PR only.

```bash
# Label a PR to trigger E2E on it:
gh pr edit <number> --add-label e2e-cloudflare
```

## How to read a failed run

- **Gate skipped**: secrets missing. Re-run step 2.
- **Deploy failed, "Authentication error (10000)"**: token permissions
  wrong. Recreate per step 1 with both Workers Scripts AND Durable
  Objects permissions.
- **Deploy failed, "DO migration not valid"**: the `test/wrangler-ci.toml`
  migration conflicts with state already on the account under the same
  worker name. Run `pnpm wrangler delete --name meridian-runtime-cloudflare-ci --force`
  locally (with the same token/account exported) and re-run.
- **Smoke failed, HTTP not 200**: Worker deployed but code crashed.
  Check `wrangler tail meridian-runtime-cloudflare-ci` during the next
  run.
- **Smoke failed, JSON assertion failed**: `test/test-worker.ts`'s
  response shape changed without updating the workflow's `jq` check.
  Keep the fields `{runtime, milestone, healthy}` stable; only add.
- **Teardown warning**: usually harmless. The `always()` step catches
  deploy failures where there's nothing to delete yet.

## What grows in M2

When the eng-review decision lands (real-CF conformance runs starting
M2), this workflow gets a new `conformance` step between smoke and
teardown that invokes the runtime-primitive suite against the live
deploy. The only piece you need to keep in sync on the CF side is
making sure the CI account stays within the billing alert you set in
step 3 — the conformance suite is heavier than the smoke check but
still well under the free tier.

## Security notes

The workflow only reads secrets that you explicitly granted to GitHub
Actions. `CLOUDFLARE_API_TOKEN` is scoped to Workers + DO edits on the
account you chose; it cannot create zones, modify DNS, or touch other
accounts. No untrusted event payloads (PR title, body, commit message)
flow into any `run:` command — the workflow follows the
[GitHub workflow-injection guide](https://github.blog/security/vulnerability-research/how-to-catch-github-actions-workflow-injections-before-attackers-do/).
