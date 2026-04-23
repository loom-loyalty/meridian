---
"@loom-loyalty/meridian-types": patch
"@loom-loyalty/meridian-wire": patch
"@loom-loyalty/meridian-priority-reference": patch
"@loom-loyalty/meridian-conformance": patch
"@loom-loyalty/meridian-runtime-cloudflare": patch
"@loom-loyalty/meridian-cli": patch
---

Verify Trusted Publishers OIDC flow across every package.

No-op patch bump that forces every `@loom-loyalty/meridian-*`
package to republish via the OIDC + Trusted Publishers pipeline.

Why a deliberate no-op bump: the first real publish run
(changesets published via `gh workflow run release.yml` from
PR #38) 404'd on `meridian-conformance` and
`meridian-runtime-cloudflare`. npm returns 404 (not 403) when a
Trusted Publisher config is missing or mismatched for a specific
package — confusingly, "package not found" covers both "doesn't
exist" and "exists but no TP entry matches". That first run
confirmed OIDC tokens mint correctly and provenance attestations
land in Sigstore (indices 1360301067, 1360301068) — just the
per-package TP entries were incomplete.

TP is now configured on all six. This changeset exercises each
one so we verify the full pipeline in one run:

- 6 separate npm publishes, each with its own OIDC token
- 6 separate provenance attestations in Sigstore
- 6 registry entries bumped by a patch version

If any single package 404s on this run, that's the one with a
TP config problem — isolated signal instead of hoping subsequent
changesets happen to touch it.

Adopter-facing change: none. No code changes in this commit; the
behavior is identical across all 6 packages.
