#!/usr/bin/env bash
# Package-local setup; never starts agents or changes existing secrets.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"
PROFILE="${1:-core}"
if [ "${PROFILE}" = "--help" ] || [ "${PROFILE}" = "-h" ]; then
  echo "Usage: npm run setup -- [core|services|packages|attestation]"
  echo "Installs the selected dependency graph, checks it, and builds it. Requires Node 22."
  exit 0
fi
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" != "22" ]; then
  echo "Node 22 is required. Run nvm use (see .nvmrc), then rerun setup."
  exit 1
fi
node scripts/workspace.mjs plan "${PROFILE}" --task install
node scripts/workspace.mjs install "${PROFILE}"
node scripts/workspace.mjs verify "${PROFILE}" --task build
node scripts/workspace.mjs verify "${PROFILE}" --task check
if [ ! -f .env ]; then
  (umask 077; cp .env.example .env)
  echo "Created a local .env template; existing environment files are never overwritten."
fi
echo "Setup passed for ${PROFILE}. See docs/WORKSPACE.md for component configuration."
echo "Local gateway + MCP: npm run stack"
echo "Isolated integration check: npm run stack:check"
