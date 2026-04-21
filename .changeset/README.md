# Changesets

This directory holds changeset files describing package-level changes. Every pull
request that modifies a package under `packages/*` should include at least one
changeset file.

## Workflow

1. Before opening a PR, create a changeset:

   ```bash
   pnpm changeset
   ```

   The CLI will prompt for:
   - Which packages are affected
   - The semver bump level (patch / minor / major) for each
   - A short summary (becomes the changelog entry)

2. Commit the generated `.changeset/*.md` file alongside your code changes.

3. On merge to `main`, the release workflow opens (or updates) a "Version Packages"
   PR that applies the version bumps and regenerates each package's `CHANGELOG.md`.

4. Merging the Version Packages PR triggers the publish step (currently tags
   on GitHub; npm publish is wired but disabled until `NPM_TOKEN` is set in
   repo secrets).

## What requires a changeset

- Any change under `packages/types/`, `packages/wire/`, or
  `packages/priority-reference/`.
- `packages/conformance/` is ignored in `config.json` — it's a test-helper
  package, not a shipped dependency. No changesets needed.

## What does not require a changeset

- Spec-only changes under `specs/`.
- CI, README, CLAUDE.md, changeset config changes.
- Internal refactors that do not change any exported surface.

If in doubt, run `pnpm changeset` and select `patch` — it's the lowest-cost
option.
