import { describe, expect, it } from "vitest";

import { createEvidence, sanitize } from "./evidence.ts";

describe("sanitize", () => {
  it("removes raw, base64 and JSON-escaped forms", () => {
    const secret = 'line one\nquote" snow雪';
    const text = [secret, Buffer.from(secret).toString("base64"), JSON.stringify({ value: secret })].join(" | ");

    const result = sanitize(text, [secret]);

    expect(result).toBe(`*** | *** | {"value":"***"}`);
  });

  it("removes a value that contains another one whole", () => {
    expect(sanitize("token-abc-long", ["token", "token-abc-long"])).toBe("***");
  });

  it("ignores empty values, which would otherwise match everywhere", () => {
    expect(sanitize("unchanged", [""])).toBe("unchanged");
  });
});

describe("createEvidence", () => {
  it("reports a failing collector and still includes the others", async () => {
    const evidence = createEvidence();
    evidence.add("broken", () => Promise.reject(new Error("no access")));
    evidence.add("working", () => Promise.resolve("pod state"));

    const captured = await evidence.capture();

    expect(captured).toContain("could not collect: Error: no access");
    expect(captured).toContain("pod state");
  });

  it("removes sensitive values from collector errors too", async () => {
    const evidence = createEvidence();
    evidence.add("broken", () => Promise.reject(new Error("failed with secret-value")));
    evidence.markSensitive("secret-value");

    expect(await evidence.capture()).not.toContain("secret-value");
  });

  it("drops sections that may contain sensitive data when restricted", async () => {
    const evidence = createEvidence();
    evidence.add("logs", () => Promise.resolve("application output"), { mayContainSensitiveData: true });
    evidence.add("state", () => Promise.resolve("Running"));
    evidence.restrict();

    const captured = await evidence.capture();

    expect(captured).not.toContain("application output");
    expect(captured).toContain("Running");
  });

  it("keeps the end of a long section", async () => {
    const evidence = createEvidence();
    evidence.add("logs", () => Promise.resolve(`${"x".repeat(30_000)}the failure`));

    const captured = await evidence.capture();

    expect(captured.length).toBeLessThan(21_000);
    expect(captured).toContain("the failure");
  });
});
