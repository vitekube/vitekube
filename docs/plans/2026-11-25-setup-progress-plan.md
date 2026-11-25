# Setup progress output

## Summary

Global setup can go quiet for a minute or more. In the Pump reconciler suite, a fresh run prints `creating k3d cluster …` and then nothing more while k3d creates the cluster, four images build in parallel, the images are imported, and stages apply manifests, wait for rollouts and install charts. The user sees only Vitest's clock counting up. Make every step that can take more than a few seconds print when it starts, show progress while it runs, and print when it ends.

## Where the silence comes from

All child processes go through `run` in `src/core/process.ts`, which buffers stdout and stderr until the process exits. The only log lines come from `global-setup.ts` and `environment.ts`, and most of them are printed when a step finishes:

| Step                                    | Code                          | What is printed today                        |
| --------------------------------------- | ----------------------------- | -------------------------------------------- |
| `k3d cluster create --wait`             | `cluster/k3d.ts` `create`     | `creating …` before, `ready in …` after      |
| `docker build` ×N, run in parallel      | `environment.ts` `buildImage` | `image X checked in …` after each one only   |
| `k3d image import`                      | `k3d.ts` `importImages`       | `imported … in …` after                      |
| `kubectl apply` for each manifest       | `runStage`                    | nothing                                      |
| `waitForRollout` for each deployment    | `runStage`, `installChart`    | nothing                                      |
| `helm upgrade --install` for each chart | `installChart`                | nothing                                      |
| stage `run` callback                    | `runStage`                    | `stage X: running` before, `done in …` after |

## Decisions and scope

- **Plain log lines, no spinner or redrawn status line.** Global setup runs in Vitest's main process, and Vitest already prints its `console.log` output above the live summary. Plain lines also work unchanged in CI logs and in non-TTY output. A status line drawn by `K8sReporter` is a possible follow-up, but it would only help users who use that reporter.
- **Print a line when each step starts.** Add start lines for image builds, the import, each manifest apply, each rollout wait, each Helm release, and each stage `run`. Each line names its object, such as `stage api: helm upgrade api (namespace default)`.
- **Relay selected output from the child process.** Add an optional `onLine(stream, line)` callback to `RunOptions`. It is called for each complete line while the output is still being buffered for the result. `private: true` commands never call it.
  - k3d: relay its `INFO[…]` lines with the `INFO[0012]` prefix removed, such as `k3d: Starting node 'k3d-…-server-0'`. These lines are short, there are about 15 of them, and they show the stages of cluster creation. Lines at warning level and above are relayed too.
  - docker build: BuildKit uses plain progress when output is not a TTY. Relay only the first line of each build step (`#8 [api 3/5] RUN pnpm install`) and `CACHED` markers, prefixed with the image name, because several builds run at the same time. Pass `--progress=plain` explicitly so the format does not depend on how it is detected.
  - helm and kubectl: they print almost nothing useful while running, so the start lines and the heartbeat cover them.
- **Heartbeat for long silent steps.** A small `withProgress(label, fn)` helper in `environment.ts` or `core/` prints `still <label> (30s)` every 15s while the step runs. This covers k3s readiness inside `k3d --wait`, `helm --wait`, rollout waits and user `run` callbacks. Heartbeat timers are `unref`'d and cleared in `finally`.
- **Verbosity.** The default is the start and end lines, relayed k3d and build steps, and heartbeats. `VITEKUBE_VERBOSE=1` relays every output line of every non-private command, which helps when a build hangs. Lines are not shortened.
- **Ordering with parallel builds.** Every relayed build line starts with `image <name>:`, so lines from different builds can be told apart. No buffering per build is needed.
- **End summary.** `environment ready in …` already exists. Add the total time for cluster creation, builds, import and stages to that line, so the slow part is clear without scrolling back.

## Out of scope / follow-ups

- Starting the image builds at the same time as `k3d cluster create`. The builds do not need the cluster, so this would shorten fresh runs by up to the length of the build. It is worth doing, but it changes failure handling and is a separate change.
- A redrawn status line in `K8sReporter`.
- Progress for `deleting k3d cluster` at teardown. It is usually fast, and a heartbeat can be added later if it is not.

## Behavior to preserve

- Output of `private: true` commands (Helm with `privateValues`) is never printed, live or in errors.
- `RunResult.stdout` and `stderr` stay complete. Relaying lines does not consume them.
- Error messages from `CommandFailedError` are unchanged.
- Nothing extra is printed for `vitest list`, which skips setup.

## Slices

### Slice 1: Line streaming in `run`

Status: `[x]` Done

- Add `onLine` to `RunOptions`. Split each stream into lines separately, flush a final partial line on close, and skip private commands.
- Unit tests: lines split across chunks, CRLF, a final line with no newline, private commands that never call `onLine`, and a result that stays byte-identical.

### Slice 2: Start lines and heartbeat

Status: `[x]` Done

- Add the `withProgress` helper and wrap cluster creation, each build, the import, each apply, rollout wait and chart install, and stage `run`.
- Unit tests with fake timers: heartbeat interval, cleanup when the step fails, and no heartbeat for steps that finish quickly.

### Slice 3: Relay k3d and BuildKit output

Status: `[x]` Done

- Add pure line filters `k3dProgressLine(line)` and `buildProgressLine(image, line)` that return the text to print or `undefined`, and pass them to `run` through `onLine`. Add `--progress=plain` to `docker build`.
- Add `VITEKUBE_VERBOSE=1` passthrough.
- Unit tests that run the filters on recorded k3d v5.8 and buildx output.
- Verification: a fresh run of `examples/environment` and of the Pump reconciler suite (`RECONCILER_IT_FRESH=1`), checking that no quiet gap is longer than about 15s. Document the new output and `VITEKUBE_VERBOSE` in the README.

## Resolved questions

- The heartbeat interval is 15s.
- Verbosity is set only through `VITEKUBE_VERBOSE`, with no setup option.
- In verbose mode, only the commands that setup runs relay their output: k3d, docker build, helm, and kubectl apply and restart. Commands that tests run through `k8s` never relay, because their output can include resource contents.
