#!/usr/bin/env bash
#
# Merge upstream's new commits into this fork and push to the fork.
#
# Layout this script assumes, and which the remotes are configured for:
#
#   origin    -> che246/dsh-workbuddy-connect   (this fork; the only push target)
#   upstream  -> corrinehu/dsh-workbuddy-connect (the original; fetch-only)
#
# `upstream` has its push URL deliberately set to a non-repository, so an
# accidental `git push upstream` fails instead of writing to someone else's
# project. Every push in this script names `origin` explicitly for the same
# reason.
#
# Why a script rather than a documented sequence: the merge has three steps
# that are easy to get wrong by hand — deciding whether a merge is needed at
# all, resolving the files both sides touch, and regenerating `lib/` (which is
# committed, so a source-only merge would ship stale build output). Each of
# those is a real failure this fork already hit once.
#
# Usage:
#   scripts/sync-upstream.sh            # merge and push
#   scripts/sync-upstream.sh --no-push  # merge only, leave the push to you
#   scripts/sync-upstream.sh --dry-run  # report what would happen
#
set -euo pipefail

cd "$(dirname "$0")/.."

PUSH=1
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --no-push) PUSH=0 ;;
    --dry-run) DRY_RUN=1; PUSH=0 ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n=== %s\n' "$1"; }

step "Checking remotes"
for remote in origin upstream; do
  if ! git remote get-url "$remote" >/dev/null 2>&1; then
    echo "missing remote '$remote' — expected origin=che246 fork, upstream=corrinehu" >&2
    exit 1
  fi
done
echo "origin   -> $(git remote get-url origin)"
echo "upstream -> $(git remote get-url upstream)"

if [ -n "$(git status --porcelain)" ]; then
  # A merge left mid-conflict is resumable, not dirty: the user is following
  # this script's own instruction to resolve and re-run. Refusing here would
  # strand them — the first version of this script did exactly that.
  if [ -f .git/MERGE_HEAD ]; then
    if git diff --name-only --diff-filter=U | grep -q .; then
      echo "" >&2
      echo "a merge is in progress with unresolved conflicts:" >&2
      git diff --name-only --diff-filter=U >&2
      echo "" >&2
      echo "resolve them, 'git add' the results, then re-run this script." >&2
      exit 1
    fi
    step "Resuming a resolved merge"
    git commit --no-edit
  else
    echo "" >&2
    echo "working tree is dirty; commit or stash first so the merge cannot mix your" >&2
    echo "edits with the merge result:" >&2
    git status --short >&2
    exit 1
  fi
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
step "Fetching upstream"
git fetch upstream --prune
git fetch origin --prune

BEHIND="$(git rev-list --count "HEAD..upstream/main")"
AHEAD="$(git rev-list --count "upstream/main..HEAD")"
echo "branch: $BRANCH"
echo "commits this fork is ahead of upstream:  $AHEAD"
echo "commits upstream has that this fork lacks: $BEHIND"

if [ "$BEHIND" -eq 0 ]; then
  step "Nothing to merge"
  echo "upstream/main is already contained in this branch."
  if [ "$PUSH" -eq 1 ] && [ "$(git rev-list --count "origin/main..HEAD")" -gt 0 ]; then
    echo "this fork is ahead of origin/main by $(git rev-list --count "origin/main..HEAD") commit(s); pushing."
    git push origin "$BRANCH"
  fi
  exit 0
fi

step "Upstream commits to be merged"
git log --oneline "HEAD..upstream/main"

if [ "$DRY_RUN" -eq 1 ]; then
  step "Files both sides touch (likely conflicts)"
  comm -12 \
    <(git diff --name-only "$(git merge-base HEAD upstream/main)" HEAD | sort) \
    <(git diff --name-only "$(git merge-base HEAD upstream/main)" upstream/main | sort) \
    || true
  echo ""
  echo "dry run: not merging."
  exit 0
fi

PRE_MERGE_HEAD="$(git rev-parse HEAD)"

step "Merging upstream/main"
if git merge --no-edit upstream/main; then
  echo "merged cleanly."
else
  echo "" >&2
  echo "CONFLICTS. Resolve them, then re-run this script." >&2
  echo "" >&2
  echo "Two rules that matter here, learned the hard way on this fork:" >&2
  echo "  * tsconfig.json / tsconfig.client.json: both sides add spec files to" >&2
  echo "    the same arrays. Keep BOTH sides' entries." >&2
  echo "  * lib/: never hand-merge build output. Take either side, then let the" >&2
  echo "    rebuild below overwrite it." >&2
  git status --short >&2
  exit 1
fi

# lib/ is committed, so a merge that only brings source changes would ship a
# stale bundle — and the plugin's runtime entry points are all in lib/.
#
# The rebuild is verified *before* anything else is committed: a failed build
# can delete most of lib/, and amending that into the merge commit is the exact
# failure that made a hand-written version of this step necessary. On failure
# the script rewinds the merge commit to the pre-merge state, so a broken build
# never lands.
step "Rebuilding lib/"
if [ -d node_modules ]; then
  if command -v pnpm >/dev/null 2>&1; then
    BUILD_OK=0; pnpm run build || BUILD_OK=$?
  else
    BUILD_OK=0; corepack pnpm@10 run build || BUILD_OK=$?
  fi
else
  echo "node_modules missing; run your package manager's install first, then" >&2
  echo "'pnpm run build' and amend the merge commit." >&2
  exit 1
fi

if [ "$BUILD_OK" -ne 0 ]; then
  echo "" >&2
  echo "BUILD FAILED (exit $BUILD_OK). Rewinding the merge commit to $PRE_MERGE_HEAD" >&2
  echo "so no broken build is committed. Fix the build, then re-run." >&2
  git reset --hard "$PRE_MERGE_HEAD"
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  step "Committing rebuilt lib/"
  git add -A
  git commit --amend --no-edit
fi

if [ "$PUSH" -eq 1 ]; then
  step "Pushing to origin (the fork)"
  git push origin "$BRANCH"
else
  step "Skipping push (--no-push)"
  echo "when ready: git push origin $BRANCH"
fi
