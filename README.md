# vitekube

**Real Kubernetes tests that feel like unit tests.**

Write a normal Vitest test. Run it on a real cluster. Rerun it, and only what you changed gets rebuilt.

```ts
test("the web server answers", async ({ k8s, namespace }) => {
  await k8s.applyFile(namespace, "web.yaml");
  await k8s.waitForRollout({ namespace, name: "web" }, { timeoutMs: 120_000 });

  await using web = await k8s.portForward({
    namespace,
    resource: "service/web",
    remotePort: 80,
  });

  expect((await fetch(web.url)).status).toBe(200);
});
```

That's a real Deployment and Service, from your own YAML, answering a real HTTP request. No mocks. No fake API server. No shell scripts wrapped around `kubectl`.

> **Status:** early. A community project, not affiliated with Vitest, Vite or the Kubernetes project.

## Why you'll like it

Kubernetes tests are slow to run and painful to debug. vitekube goes after the time they waste:

| Time sink                                    | With vitekube                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| Waiting for a new cluster on every run       | Keep the cluster. The next run starts straight away.                        |
| Rebuilding the whole system for a small edit | Only the images and stages you changed run again. A rerun can take seconds. |
| Rerunning everything to check one test       | `npx vitest run -t "exact test name"`. It's still just Vitest.              |
| Digging for clues after cleanup deleted them | Events, pod state and logs print right next to the failure.                 |
| Tests tripping over each other's leftovers   | Each test gets its own namespace, deleted afterward.                        |
| Maintaining a pile of setup scripts          | Declare the cluster, images and charts once, in TypeScript.                 |

And it's careful with everything else:

- **Your kubectl context is never touched.** vitekube uses a private kubeconfig, and you always name the cluster.
- **It won't harm a cluster it doesn't own.** It refuses to reuse or delete anything it didn't create.
- **Secrets stay out of your output.** Mark a value as sensitive and it's removed from everything captured, even its base64 form.

## What `test` gives you

Ask for what you need by name. vitekube sets it up and cleans up after it:

| Ask for     | You get                                                           |
| ----------- | ----------------------------------------------------------------- |
| `k8s`       | Apply, wait, exec, read logs and port-forward on the real cluster |
| `namespace` | A new namespace for this test, deleted afterward                  |
| `scope`     | Cleanup functions that run in reverse order                       |
| `evidence`  | Extra failure output, and control over what counts as secret      |

[See everything your tests get](#everything-your-tests-get).

### Make it yours

The real magic: wrap your whole system in one word. `.extend` adds your own fixture, and any test can ask for it by name:

```ts
// fixtures.ts
import { test as base } from "vitekube";

export const test = base.extend("web", async ({ k8s, namespace }, { onCleanup }) => {
  await k8s.applyFile(namespace, "web.yaml");
  await k8s.waitForRollout({ namespace, name: "web" }, { timeoutMs: 120_000 });

  const forward = await k8s.portForward({
    namespace,
    resource: "service/web",
    remotePort: 80,
  });
  onCleanup(() => forward.close());

  return {
    get: (path: string) => fetch(new URL(path, forward.url)),
    logs: async () => {
      const [pod] = await k8s.list({ apiVersion: "v1", kind: "Pod", namespace });
      return k8s.logs({ namespace, name: pod!.metadata!.name! });
    },
  };
});
```

Now your tests read like what your product does:

```ts
import { expect } from "vitest";
import { test } from "./fixtures";

test("the home page loads", async ({ web }) => {
  const response = await web.get("/");

  expect(response.status).toBe(200);
});

test("a missing page returns 404, and it's in the logs", async ({ web }) => {
  const response = await web.get("/nope");

  expect(response.status).toBe(404);
  expect(await web.logs()).toContain("/nope");
});
```

Each test gets its own copy of the server in its own namespace. `web` is fully typed, and a test that doesn't ask for it doesn't pay for it.

## Quick start

You need [Docker](https://docs.docker.com/get-docker/), [k3d](https://k3d.io), [kubectl](https://kubernetes.io/docs/tasks/tools/), Vitest 5 and Node `^22.18`, `^24.11` or `>=26`.

```sh
npm install --save-dev vitest vitekube
```

**1. Name your cluster** in `k8s.setup.ts`:

```ts
import { defineK8sGlobalSetup } from "vitekube/node";

export default defineK8sGlobalSetup({
  cluster: { provider: "k3d", name: "my-app-tests", reuse: true },
});
```

**2. Connect it to Vitest** in `vitest.config.ts`:

```ts
import { K8sReporter } from "vitekube/node";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./k8s.setup.ts"],
    reporters: [new K8sReporter()],
    fileParallelism: false,
    testTimeout: 180_000,
    teardownTimeout: 120_000,
  },
});
```

`K8sReporter` is Vitest's default output with readable times, `38.2s` rather than `38196ms`, and it fails a run whose `-t` filter matches nothing.

**3. Add your YAML** in `web.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - { name: web, image: nginx:1.29-alpine }
---
apiVersion: v1
kind: Service
metadata: { name: web }
spec:
  selector: { app: web }
  ports: [{ port: 80 }]
```

**4. Write a test** in `web.test.ts`:

```ts
import { test } from "vitekube";
import { expect } from "vitest";

test("the web server answers", async ({ k8s, namespace }) => {
  await k8s.applyFile(namespace, "web.yaml");
  await k8s.waitForRollout({ namespace, name: "web" }, { timeoutMs: 120_000 });

  await using web = await k8s.portForward({
    namespace,
    resource: "service/web",
    remotePort: 80,
  });

  expect((await fetch(web.url)).status).toBe(200);
});
```

**5. Run it:**

```sh
npx vitest run
```

The first run creates the cluster. With `reuse: true`, every run after that starts straight away. Leave out `reuse` to get a new cluster each run, deleted at the end.

Each run also prints a command for watching the cluster live in `k9s`.

## Everything your tests get

`test` from `vitekube` is Vitest's `test` with these fixtures. Use only the ones you ask for:

| Fixture               | What it gives you                                                                    |
| --------------------- | ------------------------------------------------------------------------------------ |
| `k8s`                 | A client for this cluster, canceled when the test times out                          |
| `namespace`           | A new namespace, deleted after the test                                              |
| `scope`               | Cleanup functions, run in reverse order, each with its own time limit                |
| `evidence`            | Extra failure output, and control over what counts as sensitive                      |
| `fileK8s`             | A client shared by a whole file, for file-scoped fixtures                            |
| `markClusterUnusable` | Stops later tests with a reason, when your own cleanup couldn't restore shared state |

Add your own with `.extend`, as [shown above](#make-it-yours). Use `{ scope: "file" }` to share one across a file, or `{ auto: true }` to run it for every test.

### The `k8s` client

| Group                  | Methods                                                                     |
| ---------------------- | --------------------------------------------------------------------------- |
| **Read and write**     | `get`, `list`, `create`, `replace`, `patch`, `delete`, `apply`, `applyFile` |
| **Wait for a result**  | `waitForJobCompletion`, `waitForPodReady`, `waitForRollout`, `waitForNone`  |
| **Interact**           | `exec`, `logs`, `portForward`                                               |
| **Simulate an outage** | `scaleTemporarily`                                                          |
| **Helm**               | `helm.status`                                                               |

`apply` takes an object. `applyFile` takes a YAML file, relative to Vitest's root, and puts it in the namespace you pass.

Two details that are easy to get wrong by hand are built in:

- **`get` tells absence from failure.** It returns `null` only when the API server confirms the resource doesn't exist. A permission or connection error throws, so a broken cluster can't pass a "was it deleted?" check.
- **Waits stop when the answer is known.** A failed Job throws straight away, without waiting out the timeout.

Use `waitForNone` when a controller or deletion needs time to remove resources:

```ts
await k8s.waitForNone(
  { apiVersion: "batch/v1", kind: "Job", namespace },
  { labelSelector: "app=my-worker", timeoutMs: 60_000 }
);
```

It waits for the API server to return an empty list. Terminating resources still count; permission and connection errors throw instead of passing. Without a selector, it waits for every resource of that kind in the requested namespace, or across namespaces when no namespace is supplied. Timeout errors list remaining resource names and whether they are terminating, never their specs.

### Matchers

```ts
expect(job).toHaveCondition("Complete");
expect(pod).toBePodReady();
expect(pod).toHaveContainerState("main", "running");
```

Failure messages describe conditions and states, not the whole object, so a Pod's environment variables don't land in your test output.

## Works great with AI agents

An agent needs what you need, only more often: a fast loop, clear failures and limited risk. A coding agent can change your code, run the real system and read why it broke, using one ordinary command.

- **One command, plain output.** No dashboard to read and no cluster to inspect by hand.
- **The failure comes with its evidence.** Events, pods and logs are in the output, so the agent can fix the bug on the next try instead of guessing.
- **Fast retries.** Only what changed gets rebuilt, so trying a fix costs little.
- **No false passes from a typo.** With `K8sReporter`, a `-t` filter that matches nothing fails the run.
- **Parallel agents stay apart.** Give each worktree its own cluster with `VITEKUBE_CLUSTER`. Two runs that share a cluster can't collide: the second fails straight away and names the process in its way.
- **A safer place to experiment.** vitekube's commands only reach the cluster you named, never the one your kubectl points at. Your agent's own shell access is still up to you.

Paste this into your `AGENTS.md` or `CLAUDE.md`:

```md
## Kubernetes tests

Tests run on a real k3d cluster using vitekube.

- Run one test: `npx vitest run <file> -t "<exact test name>"`
- Run everything: `npx vitest run`
- In a worktree, use your own cluster: `VITEKUBE_CLUSTER=<worktree-name> npx vitest run`
- After a failure, read the events, pods and logs printed above the error first.
- To inspect a failed test's namespace: add `VITEKUBE_KEEP_ON_FAILURE=1` and use the command it prints.
- To redo every image and stage: add `VITEKUBE_REBUILD=1`.
```

## Test your whole system

Declare your images, dependencies and charts in one place. Use your production charts, and your tests exercise what you actually ship:

```ts
import { defineK8sGlobalSetup } from "vitekube/node";

export default defineK8sGlobalSetup({
  cluster: { provider: "k3d", name: "my-app-tests", reuse: true, agents: 1 },

  environment: {
    images: [{ name: "my-api", dockerfile: "api/Dockerfile", context: "." }],

    stages: [
      {
        name: "database",
        manifests: ["test/k8s/postgres.yaml"],
        waitFor: [{ namespace: "default", name: "postgres" }],
      },
      {
        name: "migrations",
        dependsOn: ["database"],
        inputs: ["db/migrations"],
        run: async ({ k8s }) => {
          await using postgres = await k8s.portForward({
            namespace: "default",
            resource: "service/postgres",
            remotePort: 5432,
          });
          await migrate(`postgres://postgres:postgres@${postgres.host}:${postgres.port}/app`); // your own code
        },
      },
      {
        name: "api",
        dependsOn: ["migrations"],
        images: ["my-api"],
        charts: [
          {
            release: "api",
            chart: "charts/api",
            values: ["test/k8s/api-values.yaml"],
            privateValues: () => ({ secrets: { SIGNING_KEY: "test-only" } }),
            restart: ["api"],
          },
        ],
      },
    ],
  },
});
```

Change one source file, and the log shows that only the affected image and stage were redone:

```text
[vitekube] imported my-api:local in 1.2s
[vitekube] stage database: skipped, unchanged
[vitekube] stage migrations: skipped, unchanged
[vitekube] stage api: running, because its inputs changed
[vitekube] stage api: done in 4.1s
```

A stage reruns when its images, charts, values or `inputs` change, or when a stage it depends on runs. A stage that fails is retried on the next run.

| Stage field | Meaning                                                  |
| ----------- | -------------------------------------------------------- |
| `manifests` | YAML files to apply                                      |
| `waitFor`   | Deployments that must finish rolling out                 |
| `charts`    | Helm releases to install (needs [Helm](https://helm.sh)) |
| `images`    | Images this stage deploys, so changing one reruns it     |
| `inputs`    | Files or globs that your `run` function reads            |
| `run`       | Any code a declaration can't express                     |
| `dependsOn` | Earlier stages this one needs                            |

Need something on every run, such as a long-lived port-forward? Add a `setup` function next to `environment`, and pass values to your tests with `provide`. Vitest's [`inject`](https://vitest.dev/config/#provide) reads them.

## See why a test failed

Evidence is captured before cleanup runs, and appears next to the failure. Here's real output, shortened, from a web server whose container exits on startup:

```text
--- events in vk8s-the-web-server-answers-4fa999
Normal Pulled Pod/web-6fc4c4d4df-lzjsd: Successfully pulled image "nginx:1.29-alpine" in 13.231s
Normal Started Pod/web-6fc4c4d4df-lzjsd: Started container web
Normal ScalingReplicaSet Deployment/web: Scaled up replica set web-6fc4c4d4df from 0 to 1
--- pods in vk8s-the-web-server-answers-4fa999
web-6fc4c4d4df-lzjsd {"phase":"Running","conditions":[...]}
--- logs in vk8s-the-web-server-answers-4fa999
web-6fc4c4d4df-lzjsd:
nginx-config-is-broken

 FAIL  web.test.ts > the web server answers
TypeError: fetch failed
```

Want a closer look? `VITEKUBE_KEEP_ON_FAILURE=1 npx vitest run` keeps the failed test's namespace and prints the command to inspect it. The next run removes it.

### Evidence from shared namespaces

Tests that use shared services or application-managed namespaces can ask for the same evidence without creating a test namespace:

```ts
test("queued work resumes after an outage", async ({ evidence }) => {
  evidence.watchResources({
    namespace: "default",
    labelSelector: "app=worker",
    tailLines: 80,
  });

  // Exercise the application. If this test fails, its worker evidence prints automatically.
});
```

`watchResources` registers collectors; it does not read the cluster until evidence is captured. It uses a client that remains usable after the test's signal is canceled. Register as many namespaces or selectors as needed.

- With a selector, it collects matching Pod summaries, their Pod events (matched by UID), and logs. Without a selector, it includes every Pod and event in the namespace, including controller events.
- Logs include init, application and ephemeral containers, with 100 lines per container by default. Containers with observed restarts also get previous-container logs; set `previous: false` to disable those reads.
- Logs respect `markSensitive` and are not read at all after `restrict()`. Resource summaries exclude specs, and collection failures are reported without hiding the test's failure.
- This is a failure-time snapshot, not a log archive. Deleted Pods and older container incarnations may already be gone. Save logs before deliberate deletion if the test needs them.

The `namespace` fixture uses this same collector automatically. Explicit watchers do not own or delete the namespaces they inspect, and do not change `VITEKUBE_KEEP_ON_FAILURE` behavior.

### Keeping secrets out of the output

```ts
test("rotates the token", async ({ evidence }) => {
  const token = crypto.randomUUID();
  evidence.markSensitive(token); // Removed from all evidence, including base64 and JSON forms.

  // Or capture metadata only, with no logs at all:
  evidence.restrict();
});
```

Use `restrict()` when a secret could appear in a form `markSensitive` can't recognize, such as split across lines. Vitest's own diffs still print whatever you pass to `expect`, so compare secrets as booleans: `expect(actual === token).toBe(true)`.

## Test what happens when things break

`scaleTemporarily` takes a workload down and puts it back when the block ends, even if the test throws or times out:

```ts
test("the app survives losing its worker", async ({ k8s }) => {
  await using worker = await k8s.scaleTemporarily({ namespace: "default", name: "worker" }, 0);

  // The worker is down here. Check how the rest of the system behaves.
});
```

Call `worker.restore()` to bring it back sooner. It waits for the rollout, and it's safe to call twice.

By default, scaling down returns before the pods have gone, and a pod that is still terminating can pick up work. When a test needs the worker truly stopped, opt in to waiting:

```ts
await using worker = await k8s.scaleTemporarily({ namespace: "default", name: "worker" }, 0, {
  waitFor: "pods-gone",
  timeoutMs: 120_000,
});

// All Pods matching the Deployment's selector are gone, including terminating Pods.
// Arrange queued work here, then call worker.restore() when ready.
```

`waitFor: "pods-gone"` requires zero replicas and uses the Deployment's full selector, including selector expressions. Its wait defaults to 120 seconds; `restoreTimeoutMs` separately bounds restoration. If scaling or waiting fails, vitekube attempts to restore the original replicas before throwing the original error, even after cancellation. Restoration failure also marks the cluster unusable. This stops matching Pods, not work they already handed to external systems; an autoscaler or another actor changing replicas can also invalidate the stopped state.

If putting shared state back fails, the cluster is flagged as unusable. Later tests stop and tell you why, rather than failing in confusing ways.

## Commands

| Command                                     | What it does                                  |
| ------------------------------------------- | --------------------------------------------- |
| `npx vitest run`                            | Run everything, reusing the cluster           |
| `npx vitest run web`                        | Run only files matching `web`                 |
| `npx vitest run -t "answers"`               | Run only tests matching a name                |
| `VITEKUBE_REBUILD=1 npx vitest run`         | Redo every image and stage                    |
| `VITEKUBE_CLUSTER=other npx vitest run`     | Use another cluster, such as one per worktree |
| `VITEKUBE_KEEP_ON_FAILURE=1 npx vitest run` | Keep a failed test's namespace to inspect     |

## Cluster options

| Option    | Meaning                                                                         |
| --------- | ------------------------------------------------------------------------------- |
| `name`    | The k3d cluster's name                                                          |
| `reuse`   | Keep the cluster between runs. Otherwise each run gets a new one and deletes it |
| `agents`  | Number of worker nodes, on top of the server                                    |
| `k3sArgs` | Extra k3s flags, such as `["--disable=traefik@server:0"]`                       |

To use a cluster you already have, set `provider: "attached"` with `kubeconfigPath` and `context`. It's refused unless the cluster already carries the `vitekube` marker. To adopt one, set `allowUnmarkedContext` to the exact context name, which confirms it's disposable. Declared images need a managed k3d cluster.

## Good to know

- **Only k3d is supported** for managed clusters today.
- **Using Vite+?** Add `server: { deps: { inline: ["vitekube"] } }` to the `test` block of your `vite.config.ts`, and keep `vitest` installed. Without this, `vp test` loads a second copy of Vitest and fails with `Vitest failed to find the current suite`.
- **Run test files one at a time.** Keep `fileParallelism: false` if your tests share cluster-wide state. Namespaces isolate resources, not cluster-scoped objects or shared services.
- **One run per cluster.** A second run fails straight away. Use `lockWaitMs` to wait instead, or `VITEKUBE_CLUSTER` to use another cluster.
- **Add readiness probes to what you wait for.** `waitForRollout` follows Kubernetes, and without a probe a container that crashes moments after starting can still count as rolled out.
- **Fixture setup counts toward the test's timeout.** Set timeouts that cover your slowest real wait.
- **Docker checks images on every run.** It takes a few seconds even when nothing changed, because Docker's layer cache is the only exact way to know.
- **Generated values need a home.** Stages that don't rerun don't regenerate anything. If two charts must share a generated key, create it once in its own stage and store it in the cluster.
- **After `kill -9`:** a port-forward can be left running. The next run clears the stale lock and any leftover namespaces.

## Examples

- [`examples/hello`](examples/hello): one Job, the smallest possible setup.
- [`examples/quick-start`](examples/quick-start): the web server from this page.
- [`examples/environment`](examples/environment): an image, a manifest, a chart, a custom stage and a private value.

## Contributing

You need [Vite+](https://viteplus.dev/guide/) (`vp`), [mise](https://mise.jdx.dev) and Docker. `vp` provides Node and pnpm, and `mise` provides k3d, kubectl and Helm.

```sh
mise install
vp install           # also builds dist/, which the examples use
vp pack              # rebuild dist/
vp check             # format, lint and types
vp test              # unit tests, no Docker needed
pnpm run e2e:smoke   # one example, to show that a cluster starts and runs a test
pnpm run e2e:all     # contract tests and examples, on real k3d clusters
pnpm run e2e:tarball # the packed package, in a project outside this workspace
pnpm run e2e:clean   # delete the clusters these tests create
```

Git hooks run the staged-file check on commit, and `vp pack`, `vp check` and `vp test` on push. In CI, branches and pull requests run the smoke test, and `main` and releases run the full suite.

## License

[MIT](LICENSE)
