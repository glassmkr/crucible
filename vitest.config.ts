import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
  },
  resolve: {
    // .js specifier inside TS (NodeNext) needs to resolve to .ts in tests
    extensions: [".ts", ".js"],
  },
});
