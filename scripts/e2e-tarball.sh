#!/bin/sh
# Installs the packed package in a new project outside this workspace, type-checks the quick-start
# and hello tests against it, and runs them on a real k3d cluster.
set -eu

root="$(pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

npm pack --silent --pack-destination "$work" >/dev/null
cp examples/quick-start/*.ts examples/quick-start/tsconfig.json "$work"
# Uses a custom matcher, so both the published types and the matcher at runtime are checked.
cp examples/hello/hello.test.ts "$work"
cd "$work"
sed -i.bak 's/name: "vitekube-quick-start"/name: "vitekube-tarball"/; s/, reuse: true//' k8s.setup.ts
rm k8s.setup.ts.bak
cat > package.json <<'JSON'
{ "name": "vitekube-tarball-test", "private": true, "type": "module" }
JSON
npm install --silent --save-dev ./vitekube-*.tgz "vitest@$(node -p "require('$root/package.json').devDependencies.vitest")" "typescript@$(node -p "require('$root/package.json').devDependencies.typescript")" @types/node@24
npx tsc --noEmit
npx vitest run --testTimeout 180000
