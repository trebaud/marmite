---
name: release-bun
description: >
  Cut a new release of a Bun-based npm package: bump the version in package.json,
  run typecheck and tests, publish to npm with `bun publish`, push the git tag,
  and create a GitHub release with a curated changelog.
  Use when the user says "release", "cut a release", "publish v1.x", or "new version"
  in a Bun project.
allowed-tools: Bash
---

# Release a Bun package

Cut a new release of the current Bun-based npm package and publish it to npm + GitHub.

## Arguments

`$ARGUMENTS` may be:
- A full version tag: `v1.2.0` — used as-is, skips version analysis
- A bump keyword: `patch`, `minor`, or `major` — overrides the inferred bump
- Empty — infer the bump level from the changes (see step 1)

## Preflight

Check the workspace is clean and on the right branch:

```bash
git status --porcelain
git rev-parse --abbrev-ref HEAD
```

Refuse to proceed if the working tree is dirty or the branch is not `main` (ask the user to confirm an override). Confirm the package manifest is present:

```bash
test -f package.json && test -f bun.lock
```

If `bun.lock` is missing, this is not a Bun project — stop and surface the mismatch.

## Steps

### 1. Determine the version bump

Get the latest tag, the current package version, and the commits since it:

```bash
git describe --tags --abbrev=0 2>/dev/null || echo "NO_TAG"
node -p "require('./package.json').version"
git log <LATEST_TAG>..HEAD --oneline --no-merges
git diff <LATEST_TAG>..HEAD
```

If there is no previous tag, treat the entire git history as the diff and propose `v0.1.0` (or whatever is in `package.json`) as the initial release.

If `$ARGUMENTS` is a full version tag (starts with `v`), skip this analysis and use it directly.

Otherwise, analyze the commits and diff to classify the bump:

**MAJOR** — any of:
- A commit message contains `BREAKING CHANGE:` or a type with `!` (e.g. `feat!:`, `fix!:`)
- A public API, CLI flag, config key, or exported type was removed or changed incompatibly
- An exported function signature changed in a breaking way

**MINOR** — none of the above, and any of:
- A commit type is `feat:` or similar (new feature added)
- A new CLI command, flag, exported function, or config option was introduced
- New functionality added without breaking existing behavior

**PATCH** — only backwards-compatible fixes, chores, or documentation:
- Commit types: `fix:`, `chore:`, `docs:`, `refactor:`, `perf:`, `test:`, `style:`
- No new features, no breaking changes

If `$ARGUMENTS` is a bump keyword (`patch`, `minor`, `major`), use that instead of the inferred level.

Compute the next version by incrementing the appropriate component of the latest tag (or `package.json` version if no tag exists):
- `major` → bump first number, reset minor and patch to 0
- `minor` → bump second number, reset patch to 0
- `patch` → bump third number

Always prefix the git tag with `v` (e.g. `v1.2.3`). The version inside `package.json` must be the bare semver string (`1.2.3`), without the `v` prefix.

Present the inferred bump level, the reasoning, and the resolved version to the user, then ask for confirmation before proceeding.

### 2. Update package.json and run gates

Update the `version` field in `package.json` to the bare semver (no `v` prefix). Prefer `bun pm version` if available, otherwise edit `package.json` directly:

```bash
bun pm version <SEMVER> --no-git-tag-version 2>/dev/null \
  || (jq ".version = \"<SEMVER>\"" package.json > package.json.tmp && mv package.json.tmp package.json)
```

Verify the change, then run the same gates `prepublishOnly` enforces, so a failure surfaces before any tag or publish:

```bash
bun install
bun run typecheck
bun test
```

If any gate fails, stop and report — do not tag, do not publish.

### 3. Commit the version bump and tag

```bash
git add package.json
git commit -m "release: <VERSION>"
git tag <VERSION>
git push origin HEAD
git push origin <VERSION>
```

Fail loudly if any push is rejected.

### 4. Publish to npm

```bash
bun publish
```

`bun publish` will re-run `prepublishOnly` if defined, so the typecheck and tests will execute again as a final guard. If publishing fails after the tag was pushed, do not delete the tag automatically — stop and surface the error so the user can decide (re-publish vs. retract).

For scoped or restricted packages the user may need `bun publish --access public` — only add that flag if the user requests it or the registry rejects the default.

### 5. Generate changelog

Get the previous tag (the one before the latest):

```bash
git tag --sort=-version:refname | sed -n '2p'
```

Then collect commits between the previous tag and the new tag:

```bash
git log <PREV_TAG>..<VERSION> --oneline --no-merges
```

If this is the first release, use the full history: `git log --oneline --no-merges`.

Filter and rewrite the commits into concise, user-facing release notes:

- **Include only** changes that affect end users: new features, bug fixes, UX improvements, performance gains visible to users.
- **Exclude** anything that is purely internal: CI/CD, devops, documentation, refactoring, dependency bumps, test changes, chores.
- Prefix each entry with a short type label: `feature:`, `bug:`, `perf:`, `ux:`.
- Keep each entry to one short sentence. Do not copy the raw commit message verbatim — rephrase it to describe what the user experiences.

Format the notes as:

```
## What's Changed

- feature: <what the user can now do>
- bug: <what was broken and is now fixed>
...

**Full changelog**: https://github.com/<OWNER>/<REPO>/compare/<PREV_TAG>...<VERSION>
```

Derive `<OWNER>/<REPO>` from `package.json`'s `repository.url` (or `git remote get-url origin`). If no previous tag exists, omit the compare link.

If no commits pass the user-facing filter, write "No user-facing changes in this release."

### 6. Create the GitHub release

```bash
gh release create <VERSION> \
  --title "<VERSION>" \
  --notes "<NOTES>"
```

This release has no binary artifacts to attach — the package is consumed via npm. Print the release URL and the `npm`/`bun add` install command for the new version when done.
