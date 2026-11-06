# vitekube

**Vitest on real Kubernetes clusters. Write integration tests that feel like unit tests.**

`vitekube` gives Vitest a real, disposable Kubernetes cluster. Declare the cluster, images and charts your system needs, then write ordinary `test()` calls against them. The first run builds everything. After that, only what you changed gets rebuilt, so a rerun can take seconds.

Declare a cluster:

```ts
// k8s.setup.ts
import { defineK8sGlobalSetup } from "vitekube/node";

export default defineK8sGlobalSetup({
  cluster: { provider: "k3d", name: "my-app-tests", reuse: true },
});
```

Then write a test against it:

```ts
// hello.test.ts
import { test } from "vitekube";
import { expect } from "vitest";

const helloJob = {
  apiVersion: "batch/v1",
  kind: "Job",
  metadata: { name: "hello" },
  spec: {
    backoffLimit: 0,
    template: {
      spec: {
        restartPolicy: "Never",
        containers: [{ name: "hello", image: "busybox:1.37", command: ["sh", "-c", "echo hello"] }],
      },
    },
  },
};

test("a Job runs to completion", async ({ k8s, namespace }) => {
  await k8s.apply(namespace, helloJob);

  const job = await k8s.waitForJobCompletion({ namespace, name: "hello" }, { timeoutMs: 120_000 });

  expect(job).toHaveCondition("Complete");
});
```

`npx vitest run` creates the cluster, runs the test, and keeps the cluster for next time. There's no default cluster: you always name one, so nothing can land on a cluster you didn't choose. The [quick start](#quick-start) has the full setup, including the small `vitest.config.ts` that connects these files.

No mocks, no fake API server, and no shell scripts wrapped around `kubectl`. Each test gets its own namespace, and it's cleaned up afterward.

> **Status:** early. This is a community project, not affiliated with Vitest, Vite or the Kubernetes project.

## Why use it

- **It's still just Vitest.** `vitest run my-group -t "exact test name"` selects one test, like any other suite.
- **Reruns skip what didn't change.** Fingerprints of your images, charts and declared inputs decide what runs, and the log tells you why.
- **Failures explain themselves.** Events, pod state and logs are captured _before_ cleanup deletes them.
- **Your kubectl context is never touched.** Every command uses a private kubeconfig, so a test can't reach the cluster you happen to be pointed at.
- **It won't damage a cluster it doesn't own.** It only reuses or deletes clusters it created, and refuses anything else.
- **Secrets stay out of your output.** Mark a value as sensitive and it's removed from everything captured, including its base64 form.

## Quick start

You need [Docker](https://docs.docker.com/get-docker/), [k3d](https://k3d.io), [kubectl](https://kubernetes.io/docs/tasks/tools/) and Node. Add [Helm](https://helm.sh) if you deploy charts. It needs Vitest 5 and Node `^22.18`, `^24.11` or `>=26`.

```sh
npm install --save-dev vitest vitekube
```

**`k8s.setup.ts`** declares the cluster:

```ts
import { defineK8sGlobalSetup } from "vitekube/node";

export default defineK8sGlobalSetup({
  cluster: { provider: "k3d", name: "my-app-tests", reuse: true },
});
```

**`vitest.config.ts`** connects it to Vitest. The `globalSetup` line is the only link, so the setup file can have any name and live anywhere:

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

`K8sReporter` is Vitest's default output with readable times, `38.2s` rather than `38196ms`, and a check that a `-t` filter matched something.

**`web.test.ts`** deploys a real web server and sends it a real request:

```ts
import { test } from "vitekube";
import { expect } from "vitest";

const web = {
  apiVersion: "v1",
  kind: "List",
  items: [
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "web" },
      spec: {
        selector: { matchLabels: { app: "web" } },
        template: {
          metadata: { labels: { app: "web" } },
          spec: { containers: [{ name: "web", image: "nginx:1.29-alpine", ports: [{ containerPort: 80 }] }] },
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "web" },
      spec: { selector: { app: "web" }, ports: [{ port: 80 }] },
    },
  ],
};

test("the web server answers", async ({ k8s, namespace }) => {
  await k8s.apply(namespace, web);
  await k8s.waitForRollout({ namespace, name: "web" }, { timeoutMs: 120_000 });

  await using forward = await k8s.portForward({ namespace, resource: "service/web", remotePort: 80 });
  const response = await fetch(forward.url);

  expect(response.status).toBe(200);
});
```

Run it:

```sh
npx vitest run
```

Vitest runs the setup file once, before any test. It creates or reuses the cluster, then shares the cluster's location with your tests through Vitest's [`provide`](https://vitest.dev/config/#provide), which is how the `k8s` fixture finds it.

The first run creates the cluster. Because of `reuse: true`, the next runs start straight away. Leave out `reuse` to get a new cluster each run, deleted when it finishes.

Each run also prints a line for watching the cluster live:

```text
[vitekube] watch the cluster with: KUBECONFIG=/tmp/.../kubeconfig.yaml k9s --context k3d-my-app-tests
```

## Test your real system

Declare your images, dependencies and charts in one place. This is what makes reruns fast:

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
          await migrate(`postgres://postgres:postgres@${postgres.host}:${postgres.port}/app`);
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

`migrate` stands for your own migration code. Using your production charts here means your tests exercise what you actually ship.

The log shows exactly what each run did. Change one source file, and only the affected image and stage are redone:

```text
[vitekube] imported my-api:local in 1.2s
[vitekube] stage database: skipped, unchanged
[vitekube] stage migrations: skipped, unchanged
[vitekube] stage api: running, because its inputs changed
[vitekube] stage api: done in 4.1s
```

A stage reruns when its images, charts, values or declared `inputs` change, or when a stage it depends on runs. A stage that fails is retried on the next run. To redo everything, set `VITEKUBE_REBUILD=1`.

| Stage field | Meaning                                              |
| ----------- | ---------------------------------------------------- |
| `manifests` | YAML files to apply                                  |
| `waitFor`   | Deployments that must finish rolling out             |
| `charts`    | Helm releases to install                             |
| `images`    | Images this stage deploys, so changing one reruns it |
| `inputs`    | Files or globs that your `run` function reads        |
| `run`       | Any code a declaration can't express                 |
| `dependsOn` | Earlier stages this one needs                        |

Need something on every run, such as a long-lived port-forward? Add a `setup` function next to `environment`, and pass values to your tests with `provide`. Vitest's [`inject`](https://vitest.dev/config/#provide) reads them.

## What your tests get

`test` from `vitekube` is Vitest's `test` with these fixtures. Use only the ones you ask for:

| Fixture               | What it gives you                                                                    |
| --------------------- | ------------------------------------------------------------------------------------ |
| `k8s`                 | A client for this cluster, canceled when the test times out                          |
| `namespace`           | A new namespace, deleted after the test                                              |
| `scope`               | Cleanup functions, run in reverse order, each with its own time limit                |
| `evidence`            | Extra failure output, and control over what counts as sensitive                      |
| `fileK8s`             | A client shared by a whole file, for file-scoped fixtures                            |
| `markClusterUnusable` | Stops later tests with a reason, when your own cleanup couldn't restore shared state |

Extend it with your own, as you would with any Vitest test:

```ts
import { test as base } from "vitekube";

export const test = base.extend("api", async ({ k8s, scope }) => {
  const forward = await k8s.portForward({ namespace: "default", resource: "service/api", remotePort: 80 });
  scope.defer(() => forward.close());
  return forward.url;
});
```

### The `k8s` client

| Group                  | Methods                                                        |
| ---------------------- | -------------------------------------------------------------- |
| **Read and write**     | `get`, `list`, `create`, `replace`, `patch`, `delete`, `apply` |
| **Wait for a result**  | `waitForJobCompletion`, `waitForPodReady`, `waitForRollout`    |
| **Interact**           | `exec`, `logs`, `portForward`                                  |
| **Simulate an outage** | `scaleTemporarily`                                             |
| **Helm**               | `helm.status`                                                  |

Two behaviors that are easy to get wrong by hand are built in:

- **`get` tells absence apart from failure.** It returns `null` only when the API server confirms the resource doesn't exist. A permission or connection error throws, so a broken cluster can't pass a "was it deleted?" check.
- **Waits stop when the answer is known.** A failed Job throws straight away, without waiting out the timeout.

### Matchers

```ts
expect(job).toHaveCondition("Complete");
expect(pod).toBePodReady();
expect(pod).toHaveContainerState("main", "running");
```

Failure messages describe conditions and states, not the whole object, so a Pod's environment variables don't land in your test output.

## Test what happens when things break

`scaleTemporarily` puts the original replica count back when its block ends, even if the test throws or times out:

```ts
test("the app survives losing its worker", async ({ k8s }) => {
  await using worker = await k8s.scaleTemporarily({ namespace: "default", name: "worker" }, 0);

  // The worker is down here. Check how the rest of the system behaves.
});
```

If putting shared state back fails, the cluster is flagged as unusable. Later tests then stop and report why, rather than failing in confusing ways.

## When a test fails

Evidence is captured before any cleanup runs, and appears next to the failure. Here's real output, shortened, from the web server above with a container that exits on startup:

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

To keep a failed test's namespace for a closer look:

```sh
VITEKUBE_KEEP_ON_FAILURE=1 npx vitest run
```

It prints the command for inspecting the namespace, and the next run removes it.

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

## Running your tests

| Command                                 | What it does                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `npx vitest run`                        | Everything, reusing the cluster                                                                             |
| `npx vitest run web`                    | Only files matching `web`                                                                                   |
| `npx vitest run -t "answers"`           | Only tests matching a name. With `K8sReporter`, a typo fails the run instead of passing with nothing tested |
| `VITEKUBE_REBUILD=1 npx vitest run`     | Redo every image and stage                                                                                  |
| `VITEKUBE_CLUSTER=other npx vitest run` | Use another cluster, such as one per worktree                                                               |

### Cluster options

| Option    | Meaning                                                                         |
| --------- | ------------------------------------------------------------------------------- |
| `name`    | The k3d cluster's name                                                          |
| `reuse`   | Keep the cluster between runs. Otherwise each run gets a new one and deletes it |
| `agents`  | Number of worker nodes, on top of the server                                    |
| `k3sArgs` | Extra k3s flags, such as `["--disable=traefik@server:0"]`                       |

To use a cluster you already have, set `provider: "attached"` with `kubeconfigPath` and `context`. It's refused unless the cluster already carries the `vitekube` marker. To adopt one, set `allowUnmarkedContext` to the exact context name, which confirms it's disposable. Declared images need a managed k3d cluster.

## Good to know

- **Using Vite+?** Add `server: { deps: { inline: ["vitekube"] } }` to the `test` block of your `vite.config.ts`, and keep `vitest` installed. `vp test` runs its own copy of Vitest, and without this `vitekube` loads a second one and fails with `Vitest failed to find the current suite`.
- **Run test files one at a time.** Keep `fileParallelism: false` if your tests share cluster-wide state. Namespaces isolate resources, not cluster-scoped objects or shared services.
- **One run per cluster.** A second run on the same cluster fails straight away and names the process using it. Use `lockWaitMs` to wait, or `VITEKUBE_CLUSTER` to use a different cluster.
- **Add readiness probes to what you wait for.** `waitForRollout` follows Kubernetes, and without a probe a container that crashes moments after starting can still count as rolled out.
- **Fixture setup counts toward the test's timeout.** Set timeouts that cover your slowest real wait.
- **Docker checks images on every run.** It takes a few seconds even when nothing changed, because Docker's layer cache is the only exact way to know.
- **Generated values need a home.** Stages that don't rerun don't regenerate anything. If two charts must share a generated key, create it once in its own stage and store it in the cluster.
- **After `kill -9`:** nothing can catch this signal, so a port-forward can be left running. The next run clears the stale lock and any leftover namespaces.
- **Only k3d is supported** for managed clusters today.

## Examples

- [`examples/hello`](examples/hello): one Job, the smallest possible setup.
- [`examples/quick-start`](examples/quick-start): the web server from this page.
- [`examples/environment`](examples/environment): an image, a manifest, a chart, a custom stage and a private value.

## Contributing

You need [Vite+](https://viteplus.dev/guide/) (`vp`), [mise](https://mise.jdx.dev) and Docker. `vp` provides Node and pnpm, and `mise` provides k3d, kubectl and Helm.

```sh
mise install
vp install          # also builds dist/, which the examples use
vp pack             # rebuild dist/
vp check            # format, lint and types
vp test             # unit tests, no Docker needed
pnpm run e2e:smoke  # one example, to show that a cluster starts and runs a test
pnpm run e2e:all    # contract tests and examples, on real k3d clusters
pnpm run e2e:tarball # the packed package, in a project outside this workspace
pnpm run e2e:clean   # delete the clusters these tests create
```

Git hooks run the staged-file check on commit, and `vp pack`, `vp check` and `vp test` on push. In CI, branches and pull requests run the smoke test, and `main` and releases run the full suite.

## License

[MIT](LICENSE)
