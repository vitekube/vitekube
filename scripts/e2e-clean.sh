#!/bin/sh
# Deletes the clusters this repository's tests create, and their private directories.
# Names are listed exactly, so no other k3d cluster on the machine can be affected.
set -u

temp="${TMPDIR:-/tmp}"
for name in vitekube-e2e vitekube-hello vitekube-quick-start vitekube-environment vitekube-tarball; do
  if docker ps -a --format '{{.Names}}' | grep -q "^k3d-$name-server-0$"; then
    KUBECONFIG="$(mktemp)" k3d cluster delete "$name"
  fi
  rm -rf "${temp%/}/vitekube/$name"
done
