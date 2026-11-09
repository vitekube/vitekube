# Lifecycle waits and resource evidence

## Summary

Make shared-namespace integration tests easier to stop safely and debug, based on the Pump reconciler suite's repeated worker shutdown and evidence code.

## Decisions and scope

- Add selector-based `k8s.waitForNone` for any listable resource. Only a successful empty API response proves absence; terminating resources still count.
- Extend temporary Deployment scaling with opt-in `waitFor: "pods-gone"` for zero replicas. Derive the full label selector from the Deployment, wait for matching Pods to disappear, and restore replicas if acquisition fails. Keep patch-only behavior by default.
- Add `evidence.watchResources` for namespace events, Pod summaries and bounded container logs. Filter selected evidence by Pod identity, support init/multiple containers and previous logs, and retain redaction/restriction behavior.
- Reuse the same evidence implementation for generated test namespaces and explicitly watched shared namespaces. Collect using the uncanceled file client.
- Do not edit the external Pump checkout. Helm mutations, JSON Patch, broader cleanup APIs and test-bound custom waits are follow-ups.

## Behavior to preserve

- Permission and transport errors must throw, never pass an absence check.
- Restoration is uncanceled, idempotent, and marks shared state unusable when it fails.
- Evidence runs before fixture teardown, cannot hide the primary failure, and never prints raw resource specs.
- Failed test namespace retention remains unchanged.

## Slices

### Slice 1: Absence waits and quiescent temporary scaling

Status: `[x]` Done

- Implement selector-based absence waits with identity-only timeout summaries.
- Support Deployment match labels and selector expressions when waiting for Pods to exit.
- Test default behavior, cancellation, terminating resources, failed acquisition rollback and failed restoration.
- Verification: focused unit tests, followed by real-cluster absence/scaling tests.

### Slice 2: Public resource evidence

Status: `[x]` Done

- Extract namespace evidence and expose it through `Evidence.watchResources`.
- Add selector-aware events, per-container logs, and optional previous-container logs.
- Verify selection, privacy, collector failures, and collection after cancellation.
- Verification: focused unit tests and a real-cluster evidence test.

### Slice 3: Documentation and final validation

Status: `[x]` Done

- Document API contracts, examples, and limits; update the public helper inventory.
- Run `vp pack`, `vp check`, `vp test`, and focused real-cluster tests.
- Record exact checks and any limitations here.

## Working notes

- 2026-11-09: Initial repository is clean. Docker responds; k3d, kubectl, Helm and Vite+ are available.
- 2026-11-09: Initial validation passed 136 unit tests and all 37 real-cluster contract tests. `vp check` initially could not resolve workspace example imports; `vp install --frozen-lockfile` restored local dependency links, after which `vp check` passed.
- 2026-11-09: Added a real finalizer-held deletion case. It exposed both Kubernetes' automatically created `kube-root-ca.crt` ConfigMap (the test must explicitly select its own resource) and a preexisting `patch` bug: spreading metadata changes over the reference erased the name needed by the API client. Preserve the reference identity when patching metadata and cover this with a unit regression and the finalizer test. The subsequent full validation is pending.
- 2026-11-09: Completed all three slices. `vp pack` passed; `vp check` passed with no lint/type warnings or errors; `vp test` passed all 139 tests across 15 files; `git diff --check` passed. The pack command emits its existing warning that TypeScript 7's API is experimental.
- 2026-11-09: `mise exec -- env VITEKUBE_CLUSTER=vitekube-dx-evidence vp test run --config e2e/vitest.config.ts` passed all 38 real-cluster contract tests across five files, including the finalizer-held deletion case. Each run created and deleted its own test cluster. The final patch cleanup after this run only replaced class-typed metadata spreads with equivalent explicit reference fields; unit tests, pack and clean lint/type checks were rerun afterward.
- 2026-11-09: The external Pump repository was not edited or tested. The complete example runner (`e2e:all`) and tarball consumer tests were not run.

## Next slice

No implementation remains in this increment. Candidate follow-ups are Helm uninstall/JSON Patch support, shared-state restoration cleanup, and test-bound custom waits. A Pump adoption pass should replace its manual worker-gone wait and register selected resource evidence; attach that repository before making any changes there.
