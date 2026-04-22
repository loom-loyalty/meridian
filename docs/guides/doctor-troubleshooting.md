# `meridian doctor` troubleshooting

`meridian doctor` runs seven checks against your local config and a
deployed Meridian runtime. Exits 0 on all-green, 1 if any check
fails. Every `FAIL` result prints a remediation line so you know
exactly what to fix.

Run:

```bash
meridian doctor --endpoint=https://your-worker.workers.dev
# or
MERIDIAN_ENDPOINT=https://your-worker.workers.dev meridian doctor
```

Without `--endpoint`, doctor runs only the local checks (node
version, token presence) and skips the remote ones.

## The checks

### 1. `node-version`

**Pass:** Node 22+. **Fail:** any older version.

Meridian requires Node 22 across the CLI, types, and runtime
packages. Node 20 works for most things but has diverged
enough on timers + `fetch` behavior that we don't support it.

**Fix:**

```bash
nvm install 22
nvm use 22
# or add to .nvmrc / mise / asdf / volta
```

### 2. `admin-token`

**Pass:** `MERIDIAN_ADMIN_TOKEN` is present (env or `.dev.vars`) and ≥ 20 chars.

**Fail:** missing or too short.

Admin tokens must be at least 20 chars for bearer-auth to be
meaningful. `meridian gen-token` mints 256-bit URL-safe base64
tokens (~43 chars) — always use that unless you have a reason not to.

**Fix:**

```bash
meridian gen-token --dev-vars
# then, for deployed:
wrangler secret put MERIDIAN_ADMIN_TOKEN
```

### 3. `endpoint`

**Pass:** `MERIDIAN_ENDPOINT` set + parses as a URL.

**Fail:** missing or malformed.

**Fix:**

```bash
meridian doctor --endpoint=https://<your-worker>.workers.dev
# or persist:
echo 'MERIDIAN_ENDPOINT="https://..."' >> .dev.vars
```

### 4. `health`

**Pass:** `GET /` returns 200 with `{runtime: "meridian-cloudflare", healthy: true}`.

**Fail:**

- Connection error → worker is not deployed or URL is wrong
- Non-200 → worker deployed but crashed on `/`
- Unexpected body → stale runtime version; upgrade
  `@loom-loyalty/meridian-runtime-cloudflare`

**Fix:**

```bash
wrangler tail <worker-name>
# Then retry doctor and watch for exception frames
```

### 5. `agent-card`

**Pass:** `GET /.well-known/agent-card.json` returns `protocolVersion: "v1"`.

**Fail:** version missing or wrong. Points at a runtime-version mismatch
between what the CLI expects and what the deployed worker ships.

**Fix:**

Upgrade runtime-cloudflare to match the CLI version:

```bash
pnpm up @loom-loyalty/meridian-runtime-cloudflare
wrangler deploy
```

### 6. `security-schemes`

**Pass:** AgentCard's `securitySchemes` includes a `bearer` entry.

**Fail:** AgentCard is served but advertises no auth. This means the
deployed worker was created WITHOUT `auth: { bearer: ... }` — the
worker is open to anyone who can reach the URL.

**Fix:**

Set `auth` in `createMeridianWorker`:

```ts
createMeridianWorker({
  agents: [...],
  auth: { bearer: env.MERIDIAN_ADMIN_TOKEN },
});
```

Then `wrangler deploy`.

See [AgentCard securitySchemes guide](agent-card-security-schemes.md)
for the full shape.

### 7. `admin-auth`

**Pass:** `GET /admin/domains` with the configured bearer token returns 200.

**Fail:**

- 401 → deployed token doesn't match local token. Rotate:
  `meridian gen-token --dev-vars` locally, paste same value into
  `wrangler secret put MERIDIAN_ADMIN_TOKEN`.
- 5xx → admin route crashed. Check `wrangler tail`.

This check confirms the full round-trip: your local token → HTTP
request → worker authorizer → admin handler → 200 response.

## Skip behavior

Checks cascade. Without an endpoint set, all remote checks print
`SKIP`. Without a token, `admin-auth` prints `SKIP` but the first
four local + remote checks still run.

`SKIP` never counts as a failure. Exit code stays 0 if every `FAIL`
turned into a `PASS` or `SKIP`.

## Sample clean output

```
[OK ] node-version: Node 22.22.2
[OK ] admin-token: present (43 chars)
[OK ] endpoint: https://my-meridian.workers.dev
[OK ] health: meridian-cloudflare runtime is healthy
[OK ] agent-card: protocolVersion=v1
[OK ] security-schemes: bearer auth advertised
[OK ] admin-auth: bearer token accepted by /admin/domains
```

## Sample failure

```
[OK ] node-version: Node 22.22.2
[FAIL] admin-token: MERIDIAN_ADMIN_TOKEN not found in env or .dev.vars
       → Run `meridian gen-token --dev-vars` to mint one.
[OK ] endpoint: https://my-meridian.workers.dev
[OK ] health: meridian-cloudflare runtime is healthy
[OK ] agent-card: protocolVersion=v1
[FAIL] security-schemes: AgentCard does not advertise bearer auth — worker is OPEN
       → Set `auth: { bearer: env.MERIDIAN_ADMIN_TOKEN }` in createMeridianWorker(), then redeploy.
[SKIP] admin-auth: skipping — no MERIDIAN_ADMIN_TOKEN available
```

The two `FAIL`s are linked: the missing local token caused the
`admin-auth` skip, AND the deployed worker is open because no token
was ever configured. Fixing them:

```bash
meridian gen-token --dev-vars         # mint locally
# update src/worker.ts with auth: { bearer: env.MERIDIAN_ADMIN_TOKEN }
wrangler secret put MERIDIAN_ADMIN_TOKEN   # paste the token
wrangler deploy
meridian doctor                        # re-run — should be all green
```
