#!/usr/bin/env bash
# routine-setup.sh — Runs at the start of every nightly-clean Routine.
# 1. Hard-fail without GH_TOKEN (required for gh CLI + cc-skills clone).
# 2. Install missing CLIs: gh, jq, node.
# 3. Clone fanilosendrison/cc-skills into .claude/ (skills, agents, scripts).
# 4. Patch ~/.claude/... refs to .claude/... in all .md files.
set -euo pipefail

if [[ -z "${GH_TOKEN:-}" ]]; then
	echo "ERROR: GH_TOKEN env var not set. Set it in the Routine's env vars (scope: repo)." >&2
	exit 1
fi

_need_install=()
command -v gh >/dev/null 2>&1 || _need_install+=(gh)
command -v jq >/dev/null 2>&1 || _need_install+=(jq)
command -v node >/dev/null 2>&1 || _need_install+=(nodejs)

if [[ ${#_need_install[@]} -gt 0 ]]; then
	echo "Installing: ${_need_install[*]}"
	if ! command -v apt-get >/dev/null 2>&1; then
		echo "ERROR: apt-get not available; cannot auto-install ${_need_install[*]}." >&2
		exit 1
	fi
	sudo apt-get -qq update

	if [[ " ${_need_install[*]} " == *" gh "* ]]; then
		type -p curl >/dev/null || sudo apt-get -qq install -y curl
		sudo mkdir -p -m 755 /etc/apt/keyrings
		curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
			| sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
		sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
		echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
			| sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
		sudo apt-get -qq update
	fi
	sudo apt-get -qq install -y "${_need_install[@]}"
fi

for bin in gh jq node; do
	command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: $bin still missing after install." >&2; exit 1; }
done

# Clone cc-skills vendor repo fresh each run. Path into .claude/ directly so
# references like .claude/skills/loop-clean/loop-clean.sh resolve naturally.
rm -rf .claude/.vendor .claude/skills .claude/agents .claude/scripts
git clone --depth 1 --branch "dev" \
	"https://x-access-token:${GH_TOKEN}@github.com/fanilosendrison/cc-skills.git" \
	.claude/.vendor 2>&1 | tail -3

mv .claude/.vendor/skills .claude/skills
mv .claude/.vendor/agents .claude/agents
mv .claude/.vendor/scripts .claude/scripts
rm -rf .claude/.vendor

# Patch ~/.claude/ refs to .claude/ project-local (cloud has no home dir).
find .claude/skills .claude/agents -type f -name '*.md' -exec sed -i \
	-e 's|~/\.claude/skills/|.claude/skills/|g' \
	-e 's|~/\.claude/scripts/|.claude/scripts/|g' \
	-e 's|~/\.claude/agents/|.claude/agents/|g' \
	-e 's|$HOME/\.claude/skills/|.claude/skills/|g' \
	-e 's|$HOME/\.claude/scripts/|.claude/scripts/|g' \
	-e 's|$HOME/\.claude/agents/|.claude/agents/|g' \
	{} +

echo "routine-setup: cc-skills cloned + patched"
