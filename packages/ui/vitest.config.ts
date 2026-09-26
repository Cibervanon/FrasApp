import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `ui` es presentacional. En T0 no hay DOM que testear: el smoke test es
    // de tipos. Los tests de render llegan con los componentes reales, en T6.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
