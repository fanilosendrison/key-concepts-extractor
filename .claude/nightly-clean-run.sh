#!/usr/bin/env bash
# nightly-clean-run.sh — Pre/post git orchestration for nightly-clean Routine.
#
# Subcommands:
#   pre  — skip-check, fetch, create/reset claude/nightly-clean from default.
#          Exits 1 if skip conditions met, >=2 on hard failures.
#   post — commit scoped changes, tag archive (fallback log), force-push with
#          lease, upsert PR.
#
# Env vars:
#   GH_TOKEN                — required (PR metadata, tag push).
#   NIGHTLY_BRANCH          — override branch name (default: claude/nightly-clean).
#   ARCHIVE_RETENTION_DAYS  — GC threshold for archive tags (default: 14).
#   CLAUDE_COMMITTER_EMAIL  — author email (default: claude-nightly@anthropic.com).

set -euo pipefail

readonly BRANCH="${NIGHTLY_BRANCH:-claude/nightly-clean}"
readonly RETENTION_DAYS="${ARCHIVE_RETENTION_DAYS:-14}"
readonly SKIP_LABEL="wip-review"
readonly TODAY="$(date -u +%Y-%m-%d)"
readonly ARCHIVE_TAG="nightly-clean-archive-${TODAY}"

# Parse owner/repo from origin URL (ssh or https). `gh pr *` defaults to
# auto-detection but that fails in sandboxed cloud envs where the git remote
# doesn't resolve against a known GitHub host — pass --repo explicitly.
_repo_slug() {
	local url
	url=$(git config --get remote.origin.url 2>/dev/null || echo "")
	echo "$url" | sed -E 's|^git@github\.com:||; s|^https?://github\.com/||; s|\.git$||'
}
readonly REPO_SLUG="$(_repo_slug)"

_log() { echo "[nightly-clean-run] $*"; }
_warn() { echo "[nightly-clean-run] WARN: $*" >&2; }
_err() { echo "[nightly-clean-run] ERROR: $*" >&2; exit 2; }

_default_branch() {
	local ref out
	ref=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || true)
	if [[ -n "$ref" ]]; then
		out="${ref#refs/remotes/origin/}"
	else
		git remote set-head origin -a >/dev/null 2>&1 || true
		ref=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || true)
		if [[ -n "$ref" ]]; then
			out="${ref#refs/remotes/origin/}"
		else
			out=$(git remote show origin 2>/dev/null | awk '/HEAD branch/ {print $NF; exit}')
		fi
	fi
	[[ -z "$out" || "$out" == "(unknown)" ]] && return 1
	echo "$out"
}

_current_pr_number() {
	gh pr list --repo "$REPO_SLUG" --head "$BRANCH" --state open --json number \
		--jq '.[0].number // empty' 2>/dev/null || true
}

_has_skip_label() {
	local pr="$1"
	[[ -z "$pr" ]] && return 1
	gh pr view "$pr" --repo "$REPO_SLUG" --json labels --jq ".labels[].name" 2>/dev/null \
		| grep -qxF "$SKIP_LABEL"
}

_has_non_claude_commits() {
	local bot_email="${CLAUDE_COMMITTER_EMAIL:-claude-nightly@anthropic.com}"
	if ! git fetch origin "$BRANCH" 2>/dev/null; then
		_warn "fetch of origin/$BRANCH failed; assuming non-Claude commits present"
		return 0
	fi
	local commits
	commits=$(git log "origin/$BRANCH" --pretty='%ae|%s' 2>/dev/null || true)
	[[ -z "$commits" ]] && return 1
	while IFS='|' read -r email subject; do
		if [[ "$email" != "$bot_email" ]] && [[ ! "$subject" =~ nightly-clean ]]; then
			return 0
		fi
	done <<< "$commits"
	return 1
}

cmd_pre() {
	local default
	if ! default=$(_default_branch); then
		_err "cannot determine default branch (origin/HEAD not set and remote lookup failed)"
	fi
	_log "default branch: $default"
	_log "nightly branch: $BRANCH"

	git fetch origin --prune --prune-tags --tags >/dev/null 2>&1 || {
		_err "git fetch origin failed"
	}

	if ! git rev-parse --verify "origin/$default" >/dev/null 2>&1; then
		_err "origin/$default not found after fetch"
	fi

	# Skip conditions (only relevant if branch already exists remotely).
	if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
		local pr
		pr=$(_current_pr_number)
		if [[ -n "$pr" ]] && _has_skip_label "$pr"; then
			_log "SKIP: open PR #$pr has label $SKIP_LABEL"
			exit 1
		fi
		if _has_non_claude_commits; then
			_log "SKIP: non-Claude commits detected on origin/$BRANCH"
			exit 1
		fi
	else
		_log "first run detected (origin/$BRANCH does not exist yet)"
	fi

	git checkout -B "$BRANCH" "origin/$default"
	_log "reset $BRANCH to origin/$default"

	# GC old archive tags.
	local cutoff_ts
	if date -u -d "${RETENTION_DAYS} days ago" +%s >/dev/null 2>&1; then
		cutoff_ts=$(date -u -d "${RETENTION_DAYS} days ago" +%s)
	else
		cutoff_ts=$(date -u -v "-${RETENTION_DAYS}d" +%s 2>/dev/null || echo 0)
	fi
	if [[ "$cutoff_ts" -gt 0 ]]; then
		git tag -l 'nightly-clean-archive-*' | while read -r tag; do
			local tag_date="${tag#nightly-clean-archive-}"
			local tag_ts
			tag_ts=$(date -u -d "$tag_date" +%s 2>/dev/null \
				|| date -u -j -f "%Y-%m-%d" "$tag_date" +%s 2>/dev/null \
				|| echo 0)
			if [[ "$tag_ts" -gt 0 && "$tag_ts" -lt "$cutoff_ts" ]]; then
				git tag -d "$tag" >/dev/null 2>&1 || true
				git push origin --delete "$tag" >/dev/null 2>&1 || true
				_log "GC: deleted tag $tag"
			fi
		done
	fi
}

cmd_post() {
	command -v gh >/dev/null 2>&1 || _err "gh CLI not installed"
	[[ -z "$REPO_SLUG" ]] && _err "cannot parse owner/repo from origin URL"

	local default
	default=$(_default_branch) || _err "cannot determine default branch in post"

	# Stage all modifications to already-tracked files (src, tests, lib, docs,
	# config, etc.). `-u` only touches tracked paths — safe from accidental
	# adds of stray files produced by the agent.
	git add -u
	# Additionally add expected new/untracked files (backlog.md may be new,
	# nightly-runs.log may be created by the tag-fallback path below).
	for extra in backlog.md .claude/nightly-runs.log; do
		[[ -f "$extra" ]] && git add "$extra"
	done

	if git diff --cached --quiet; then
		_log "no changes produced by nightly run — nothing to push"
		local pr
		pr=$(_current_pr_number)
		if [[ -n "$pr" ]]; then
			gh pr comment "$pr" --repo "$REPO_SLUG" --body "Nightly run produced no changes on $TODAY." \
				>/dev/null 2>&1 || _warn "gh pr comment failed"
		fi
		return 0
	fi

	local author_name author_email
	author_name="${GIT_AUTHOR_NAME:-Claude Nightly}"
	author_email="${GIT_AUTHOR_EMAIL:-${CLAUDE_COMMITTER_EMAIL:-claude-nightly@anthropic.com}}"
	export CLAUDE_COMMITTER_EMAIL="$author_email"

	# Archive fallback log written BEFORE commit to avoid brittle amend.
	local prev_sha="" archive_fallback_written=0
	if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
		prev_sha=$(git rev-parse "origin/$BRANCH" 2>/dev/null || true)
		if [[ -n "$prev_sha" ]]; then
			if ! git tag -a "$ARCHIVE_TAG" "$prev_sha" \
					-m "Archive of $BRANCH before nightly run $TODAY" 2>/dev/null; then
				_log "FALLBACK: tag create failed; writing to .claude/nightly-runs.log"
				mkdir -p .claude
				echo "$TODAY archive_sha=$prev_sha" >> .claude/nightly-runs.log
				git add .claude/nightly-runs.log
				archive_fallback_written=1
			fi
		fi
	fi

	git -c "user.name=$author_name" -c "user.email=$author_email" \
		commit -m "chore(nightly-clean): cleanup run $TODAY" \
		-m "Automated /loop-clean + /backlog-deep-crush sweep."
	_log "committed nightly changes"

	if [[ -n "$prev_sha" && "$archive_fallback_written" -eq 0 ]]; then
		if git push origin "$ARCHIVE_TAG" 2>/dev/null; then
			_log "pushed archive tag $ARCHIVE_TAG"
		else
			_log "FALLBACK: tag push blocked; appending to .claude/nightly-runs.log"
			git tag -d "$ARCHIVE_TAG" >/dev/null 2>&1 || true
			mkdir -p .claude
			echo "$TODAY archive_sha=$prev_sha" >> .claude/nightly-runs.log
			git add .claude/nightly-runs.log
			if ! git -c "user.name=$author_name" -c "user.email=$author_email" \
					commit --amend --no-edit >/dev/null 2>&1; then
				_warn "amend failed; continuing without log in commit"
			fi
		fi
	fi

	# --force-with-lease: reject if origin moved since cmd_pre's fetch.
	local lease_ref="refs/heads/$BRANCH"
	if [[ -n "$prev_sha" ]]; then
		if ! git push --force-with-lease="$lease_ref:$prev_sha" origin "$BRANCH"; then
			_err "push rejected: origin/$BRANCH changed since fetch. Aborting to preserve that work."
		fi
	else
		git push origin "$BRANCH"
	fi
	_log "force-pushed $BRANCH (with lease)"

	# Upsert PR.
	local pr
	pr=$(_current_pr_number)
	if [[ -z "$pr" ]]; then
		if gh pr create --repo "$REPO_SLUG" --base "$default" --head "$BRANCH" \
				--title "chore(nightly-clean): cleanup run $TODAY" \
				--body "Automated nightly cleanup. Review and merge if looks good." \
				>/dev/null 2>&1; then
			_log "opened new PR"
		else
			_warn "gh pr create failed; checking again"
			pr=$(_current_pr_number)
			[[ -n "$pr" ]] && _log "PR #$pr detected on retry" || _err "gh pr create failed and no PR exists"
		fi
	else
		gh pr edit "$pr" --repo "$REPO_SLUG" \
			--title "chore(nightly-clean): cleanup run $TODAY" \
			--body "Automated nightly cleanup. Latest run: $TODAY." \
			>/dev/null 2>&1 || _warn "gh pr edit failed for PR #$pr"
		_log "updated PR #$pr"
	fi
}

usage() {
	cat >&2 <<EOF
Usage:
  nightly-clean-run.sh pre
  nightly-clean-run.sh post
EOF
	exit 2
}

main() {
	[[ $# -lt 1 ]] && usage
	case "$1" in
		pre) cmd_pre ;;
		post) cmd_post ;;
		*) usage ;;
	esac
}

main "$@"
