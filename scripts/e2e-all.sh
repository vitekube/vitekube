#!/bin/sh
# Contract tests and every example, each on a real k3d cluster reached through a private kubeconfig.
set -eu

# Also on failure, so a failed run leaves no cluster behind.
trap 'sh scripts/e2e-clean.sh' EXIT

pnpm run e2e
pnpm --dir examples/hello run e2e
pnpm --dir examples/quick-start run e2e
KUBECONFIG="$(mktemp)" k3d cluster delete vitekube-quick-start
EXAMPLE_FRESH=1 pnpm --dir examples/environment run e2e
