import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // The default environment is deliberately `node`: the domain is pure
    // TypeScript and must stay testable without a DOM. Files that genuinely
    // need one opt in with a `// @vitest-environment jsdom` pragma.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
