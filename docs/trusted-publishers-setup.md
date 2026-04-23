# npm Trusted Publishers setup

Meridian publishes to npm via [Trusted Publishers](https://docs.npmjs.com/trusted-publishers) —
GitHub Actions authenticates to npm via OIDC, no long-lived `NPM_TOKEN` needed.

This doc is the one-time setup you do on [npmjs.com](https://www.npmjs.com/)
to wire each `@loom-loyalty/meridian-*` package to the `release.yml` workflow.

**What the repo already does (committed):**

- Each published package's `package.json` has:
  ```json
  "publishConfig": {
    "access": "public",
    "provenance": true
  }
  ```
- `.github/workflows/release.yml` has `id-token: write` permission.
- `NPM_TOKEN` is removed from the workflow — OIDC replaces it.

**What you have to do in the npm web UI (once per package, forever):**

## 1. Confirm the `@loom-loyalty` org exists

Visit https://www.npmjs.com/org/loom-loyalty. If it 404s, create it:

- https://www.npmjs.com/org/create
- Pick "Free" tier (unlimited public packages)
- Name: `loom-loyalty`

If it exists but you're not a member, add yourself or have a current
admin invite you.

## 2. Pre-register each package with a Trusted Publisher

For a package that has **never been published before** (our case — everything
is 404), you register it with a Trusted Publisher BEFORE the first publish.
Once registered, the first CI run will publish via OIDC successfully.

Steps per package:

1. Go to https://www.npmjs.com/settings/loom-loyalty/packages
2. Click **"Pre-register a package"** (or similar — labels shift;
   look for "Add package" with a Trusted Publisher option)
3. Enter the package name (e.g. `meridian-types`)
4. Choose **GitHub Actions** as the publisher
5. Fill in:

   | Field                | Value                                              |
   | -------------------- | -------------------------------------------------- |
   | Organization or user | `loom-loyalty`                                     |
   | Repository           | `meridian`                                         |
   | Workflow filename    | `release.yml`                                      |
   | Environment name     | _(leave blank — we don't use GitHub environments)_ |

6. Save.

Repeat for all six packages:

- `meridian-types`
- `meridian-wire`
- `meridian-priority-reference`
- `meridian-conformance`
- `meridian-runtime-cloudflare`
- `meridian-cli`

## 3. Trigger a release

After pre-registration, either merge a PR with a pending changeset
or manually trigger the workflow:

```bash
# List changesets waiting to publish
ls .changeset/

# If a changeset exists, push to main. The Changesets action opens
# a "Version Packages" PR. Merge it. The subsequent workflow run
# publishes via OIDC.

# Or, if everything is already versioned but not yet published:
gh workflow run release.yml
```

Watch the run:

```bash
gh run watch
```

Expected output: each package's publish step prints "Tarball Details"
followed by "Publishing with provenance" and completes with
`+ @loom-loyalty/<package>@<version>`.

## 4. Verify

```bash
for pkg in meridian-types meridian-wire meridian-priority-reference \
           meridian-conformance meridian-runtime-cloudflare meridian-cli; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "https://registry.npmjs.org/@loom-loyalty/$pkg")
  echo "@loom-loyalty/$pkg: $code"
done
```

All six should return 200.

## 5. Delete the NPM_TOKEN secret (cleanup)

Once OIDC is working end-to-end:

```bash
gh secret delete NPM_TOKEN
```

The workflow no longer references it, but leaving stale secrets around
is clutter. Remove after you've seen at least one green publish run.

## Troubleshooting

### `403 Forbidden` on publish with "trusted publisher required"

The package isn't pre-registered yet, OR the repo/workflow values
don't match what you entered in step 2. Double-check:

- The repo is `loom-loyalty/meridian` exactly (not a fork, not a
  different casing)
- The workflow filename is `release.yml` exactly (npm matches it
  against `workflow_ref` from the OIDC claim)
- The workflow triggers on `push: branches: [main]` — OIDC
  assumes this is a "trusted" event

### `403 Forbidden` with "publishConfig.access required"

The package is being published for the first time but npm doesn't
know whether to make it public or private. Ensure `publishConfig.access`
is `"public"` (already set in our package.jsons).

### `404 Not Found` on publish

The `@loom-loyalty` org doesn't exist or you're not a member. See step 1.

### Workflow publishes one package but fails on another

Each package is registered independently. You registered some but
not all. Revisit step 2 for the unregistered ones.

### "All changesets are empty; not creating PR"

Not an error — the workflow has no new versions to publish this
run. It's waiting for a new changeset + PR merge. Add a changeset
via `pnpm changeset`, merge it to main, the workflow will open a
Version Packages PR, merge that, and the follow-up workflow run
will publish.

## Why Trusted Publishers?

- **No token rotation ever.** OIDC tokens are short-lived per-run.
- **Provenance attestation.** Each published tarball gets a signed
  attestation linking it to the git commit + workflow run that
  built it. Consumers can verify via `npm audit signatures` that a
  specific `@loom-loyalty/meridian-types@0.4.0` was built from a
  specific Meridian commit, not smuggled in by someone who stole
  an NPM_TOKEN.
- **Least privilege.** Credentials only exist for the 60 seconds
  the publish runs. A compromised GitHub runner can't exfiltrate
  a token because there is no token.
- **Smaller blast radius.** Losing the org's admin credentials
  still won't let an attacker publish — they'd need to also
  reconfigure Trusted Publishers on each package (visible, loggable
  action).
