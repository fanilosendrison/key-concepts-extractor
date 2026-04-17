#!/usr/bin/env bash
# routine-setup.sh — Runs at the start of every nightly-clean Routine.
# 1. Hard-fail without GH_TOKEN (required for gh CLI + cc-skills clone).
# 2. Install missing CLIs: gh, jq, node.
# 3. Clone fanilosendrison/cc-skills into .claude/ (skills + scripts only;
#    agents are committed in the target repo — see _copy_and_patch_agents).
# 4. Patch ~/.claude/... refs to .claude/... in all .md files.
set -euo pipefail

if [[ -z "${GH_TOKEN:-}" ]]; then
	echo "ERROR: GH_TOKEN env var not set. Set it in the Routine's env vars (scope: repo)." >&2
	exit 1
fi

# Install gh via direct binary download (bypass apt entirely).
# The cloud env has pre-installed node/jq; broken 3rd-party PPAs
# (deadsnakes, ondrej/php) cause `apt-get update` to fail with 403.
# Pinned version avoids github.com API rate limits on shared cloud IPs
# (anon GitHub API = 60 req/h per IP). Bump GH_VERSION manually.
readonly GH_VERSION="2.64.0"
if ! command -v gh >/dev/null 2>&1; then
	echo "Installing gh CLI ${GH_VERSION} via direct binary download..."
	GH_ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"
	GH_TARBALL="gh_${GH_VERSION}_linux_${GH_ARCH}"
	curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${GH_TARBALL}.tar.gz" -o /tmp/gh.tar.gz
	tar -xzf /tmp/gh.tar.gz -C /tmp
	sudo install "/tmp/${GH_TARBALL}/bin/gh" /usr/local/bin/gh
	rm -rf /tmp/gh.tar.gz "/tmp/${GH_TARBALL}"
	echo "gh installed: $(gh --version | head -1)"
fi

# jq and node should be pre-installed on Anthropic cloud env.
for bin in gh jq node; do
	command -v "$bin" >/dev/null 2>&1 || {
		echo "ERROR: $bin missing from cloud env and cannot be auto-installed reliably." >&2
		exit 1
	}
done

# Clone cc-skills vendor repo fresh each run. Path into .claude/ directly so
# references like .claude/skills/loop-clean/loop-clean.sh resolve naturally.
# NOTE: .claude/agents/ is NOT touched here — agents are committed directly
# in the repo because the cloud Routine registry is frozen BEFORE this
# setup script runs. Agents added to disk post-clone are never registered.
rm -rf .claude/.vendor .claude/skills .claude/scripts
git clone --depth 1 --branch "dev" \
	"https://x-access-token:${GH_TOKEN}@github.com/fanilosendrison/cc-skills.git" \
	.claude/.vendor 2>&1 | tail -3

mv .claude/.vendor/skills .claude/skills
mv .claude/.vendor/scripts .claude/scripts
rm -rf .claude/.vendor

# Patch ~/.claude/ refs to .claude/ project-local (cloud has no home dir).
# Agents are already patched at enroll-time, but re-patching is idempotent.
find .claude/skills .claude/agents -type f -name '*.md' -exec sed -i \
	-e 's|~/\.claude/skills/|.claude/skills/|g' \
	-e 's|~/\.claude/scripts/|.claude/scripts/|g' \
	-e 's|~/\.claude/agents/|.claude/agents/|g' \
	-e 's|$HOME/\.claude/skills/|.claude/skills/|g' \
	-e 's|$HOME/\.claude/scripts/|.claude/scripts/|g' \
	-e 's|$HOME/\.claude/agents/|.claude/agents/|g' \
	{} +

echo "routine-setup: cc-skills cloned + patched"
