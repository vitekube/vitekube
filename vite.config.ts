import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  pack: {
    entry: { "index": "src/index.ts", "node": "src/node.ts", "core/index": "src/core/index.ts" },
    dts: true,
    target: "node22",
  },
  fmt: {
    printWidth: 120,
    trailingComma: "es5",
    quoteProps: "consistent",
    proseWrap: "preserve",
    ignorePatterns: ["**/templates/*.yaml", "pnpm-lock.yaml", "dist/**"],
  },
  lint: {
    ignorePatterns: ["dist/**"],
    options: { typeAware: true, typeCheck: true },
  },
  staged: {
    "*": "vp check --fix",
  },
});
