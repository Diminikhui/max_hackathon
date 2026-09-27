#!/usr/bin/env bash
set -Eeuo pipefail

repo=/srv/max-hackathon/repo
env_file=/etc/max-hackathon/compose.env
key=/root/.ssh/k08_deploy_ed25519
state_dir=/var/lib/max-hackathon
host=135.106.227.207

exec 9>/run/lock/max-hackathon-deploy.lock
flock -n 9 || exit 0

test -f "$env_file"
test -r "$key"
test -d "$repo/.git"
mkdir -p "$state_dir"

if test -n "$(git -C "$repo" status --porcelain)"; then
  echo 'Deployment checkout has local changes; refusing to overwrite them.' >&2
  exit 1
fi

export GIT_SSH_COMMAND="ssh -i $key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"
export COMPOSE_PARALLEL_LIMIT=1
git -C "$repo" fetch --quiet origin main
target=$(git -C "$repo" rev-parse refs/remotes/origin/main)
previous=$(git -C "$repo" rev-parse HEAD)
deployed=$(cat "$state_dir/deployed-sha" 2>/dev/null || true)

if [[ "$target" == "$deployed" && "${1:-}" != --force ]]; then
  exit 0
fi

deploy_revision() {
  local revision=$1
  git -C "$repo" switch --detach --quiet "$revision"
  docker compose --project-directory "$repo" --env-file "$env_file" \
    -f "$repo/compose.yaml" up -d --build --remove-orphans
  local attempt
  for attempt in {1..15}; do
    if curl --fail --silent --max-time 5 --output /dev/null "https://$host/"; then
      return 0
    fi
    sleep 2
  done
  echo 'Mini-app did not become available over HTTPS.' >&2
  return 1
}

if ! deploy_revision "$target"; then
  echo "Deployment failed for $target; restoring $previous" >&2
  if [[ "$previous" != "$target" ]]; then
    deploy_revision "$previous" || true
  fi
  exit 1
fi

printf '%s\n' "$target" >"$state_dir/deployed-sha"
echo "Deployed $target"
