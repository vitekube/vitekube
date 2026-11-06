import { randomBytes } from "node:crypto";

/** On every per-test namespace, so one left by a killed run can be found and removed. */
export const EPHEMERAL_NAMESPACE_LABEL = "vitekube.dev/ephemeral";

const MAX_NAME_LENGTH = 63;

/** A valid, unique namespace name that still shows which test it belongs to. */
export const ephemeralNamespaceName = (testName: string): string => {
  const suffix = randomBytes(3).toString("hex");
  const room = MAX_NAME_LENGTH - "vk8s--".length - suffix.length;
  const slug = testName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, room)
    .replace(/-+$/, "");
  return slug ? `vk8s-${slug}-${suffix}` : `vk8s-${suffix}`;
};
