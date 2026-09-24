#!/usr/bin/env bash

set -euo pipefail

required_files=(
  README.md
  TEAM_GUIDE.md
  AGENTS.md
  CLAUDE.md
  CONTRIBUTING.md
  SECURITY.md
  .env.example
  .github/PULL_REQUEST_TEMPLATE.md
  .github/ISSUE_TEMPLATE/config.yml
  docs/roadmap.md
  docs/plan-dependencies.md
  docs/agents/work-packages.md
  docs/agents/start-prompts.md
  scripts/wp.sh
  scripts/check-pr-overlap.sh
  scripts/work_packages.py
)

missing_files=()
for file in "${required_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    missing_files+=("$file")
  fi
done

if (( ${#missing_files[@]} > 0 )); then
  printf 'Missing required repository file: %s\n' "${missing_files[@]}"
  exit 1
fi

forbidden_files="$({ git ls-files | grep -E '(^|/)\.env($|\.)|\.(pem|key)$' | grep -vE '(^|/)\.env\.example$'; } || true)"
if [[ -n "$forbidden_files" ]]; then
  echo 'Forbidden credential files are tracked:'
  echo "$forbidden_files"
  exit 1
fi

if git grep -nE '^(<<<<<<< |=======|>>>>>>> )' -- .; then
  echo 'Unresolved merge-conflict markers found.'
  exit 1
fi

python3 scripts/work_packages.py validate
python3 scripts/work_packages.py report --check

tls_bypass="$(git grep -nE 'NODE_TLS_REJECT_UNAUTHORIZED[= ]+.?0|rejectUnauthorized: *false|verify *= *False|InsecureSkipVerify' -- . ':!docs' ':!*.md' ':!scripts/verify-repository.sh' || true)"
if [[ -n "$tls_bypass" ]]; then
  echo 'TLS certificate verification must not be disabled:'
  echo "$tls_bypass"
  exit 1
fi

git diff --check HEAD

echo 'Repository checks passed.'
