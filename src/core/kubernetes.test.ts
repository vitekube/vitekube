import { ApiException } from "@kubernetes/client-node";
import { describe, expect, test } from "vitest";

import { isNamedNotFound } from "./kubernetes.ts";
import { isReleaseNotFound, parseHelmStatus } from "./helm.ts";

const apiError = (code: number, body: unknown) => new ApiException(code, "failed", body, {});

const notFoundBody = { kind: "Status", reason: "NotFound", details: { name: "hello" } };

describe("isNamedNotFound", () => {
  test("accepts the API server saying this name does not exist", () => {
    expect(isNamedNotFound(apiError(404, notFoundBody), "hello")).toBe(true);
    expect(isNamedNotFound(apiError(404, JSON.stringify(notFoundBody)), "hello")).toBe(true);
  });

  test.each([
    ["Forbidden", apiError(403, { reason: "Forbidden", details: { name: "hello" } })],
    ["Unauthorized", apiError(401, { reason: "Unauthorized" })],
    ["a 404 without a Status body, such as from a proxy", apiError(404, "<html>not found</html>")],
    ["a 404 about a different name", apiError(404, { reason: "NotFound", details: { name: "other" } })],
    ["a connection failure", new Error("connect ECONNREFUSED")],
  ])("rejects %s", (_name, error) => {
    expect(isNamedNotFound(error, "hello")).toBe(false);
  });
});

describe("helm", () => {
  test("recognizes only Helm's own not-found message", () => {
    expect(isReleaseNotFound("Error: release: not found\n")).toBe(true);
    expect(isReleaseNotFound("Error: Kubernetes cluster unreachable: connection refused\n")).toBe(false);
    expect(isReleaseNotFound("Error: configmaps is forbidden: not found in role\n")).toBe(false);
  });

  test("status keeps identity and leaves values out", () => {
    const output = JSON.stringify({
      name: "api",
      namespace: "n",
      version: 3,
      info: { status: "deployed" },
      config: { token: "hunter2" },
      manifest: "token: hunter2",
    });

    const release = parseHelmStatus(output);

    expect(release).toEqual({ name: "api", namespace: "n", status: "deployed", revision: 3 });
    expect(JSON.stringify(release)).not.toContain("hunter2");
  });
});
