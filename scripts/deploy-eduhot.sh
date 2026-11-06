#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$repo_dir/docker-compose.eduhot.yml"

cd "$repo_dir"
if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "EduHOT deploy requires the main branch." >&2
  exit 1
fi
if [[ ! -f .env ]]; then
  echo "Missing $repo_dir/.env; keep production secrets outside Git." >&2
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo "The Git worktree must be clean before deployment." >&2
  exit 1
fi

git fetch origin main
git pull --ff-only origin main
git rev-parse --short HEAD

docker compose -f "$compose_file" config -q
docker compose -f "$compose_file" build
docker compose -f "$compose_file" up -d setup
docker compose -f "$compose_file" up -d api worker web

for attempt in {1..30}; do
  if curl -fsS --max-time 5 http://127.0.0.1:3001/api/health; then
    printf '\nEduHOT API is healthy.\n'
    exit 0
  fi
  sleep 2
done

echo "EduHOT API did not become healthy; inspect docker compose logs." >&2
exit 1
