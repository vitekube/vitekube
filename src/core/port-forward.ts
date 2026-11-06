import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { startBackground } from "./process.ts";
import type { KubernetesTarget } from "./kubernetes.ts";

export type PortForwardOptions = {
  namespace: string;
  /** In kubectl's form, such as `service/api` or `pod/worker-0`. */
  resource: string;
  remotePort: number;
  /** Defaults to a free port chosen at startup. */
  localPort?: number;
  startupTimeoutMs?: number;
};

export type PortForward = {
  host: string;
  port: number;
  url: string;
  isRunning: () => boolean;
  close: () => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
};

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

const canConnect = (host: string, port: number): Promise<boolean> => {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = connect({ host, port });
  socket.setTimeout(1_000);
  socket.once("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("timeout", () => {
    socket.destroy();
    resolve(false);
  });
  socket.once("error", () => resolve(false));
  return promise;
};

/** Ready means a real TCP connection worked, not that some time has passed. */
export const startPortForward = async (target: KubernetesTarget, options: PortForwardOptions): Promise<PortForward> => {
  const description = `${options.namespace}/${options.resource}:${options.remotePort}`;
  const timeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const forward = startBackground("kubectl", [
    "--kubeconfig",
    target.kubeconfigPath,
    "--context",
    target.context,
    "port-forward",
    options.resource,
    `${options.localPort ?? ""}:${options.remotePort}`,
    "--namespace",
    options.namespace,
    `--pod-running-timeout=${Math.ceil(timeoutMs / 1000)}s`,
  ]);

  let stdout = "";
  let stderr = "";
  forward.child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  forward.child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));

  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      if (!forward.isRunning()) {
        throw new Error(`Port-forward to ${description} exited during startup: ${stderr.trim()}`);
      }
      const match = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(stdout);
      if (match) {
        const port = Number(match[1]);
        if (await canConnect("127.0.0.1", port)) {
          const close = (): Promise<void> => forward.stop();
          return {
            host: "127.0.0.1",
            port,
            url: `http://127.0.0.1:${port}`,
            isRunning: forward.isRunning,
            close,
            [Symbol.asyncDispose]: close,
          };
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`Port-forward to ${description} was not ready after ${timeoutMs}ms: ${stderr.trim()}`);
      }
      await delay(100);
    }
  } catch (error) {
    await forward.stop();
    throw error;
  }
};
