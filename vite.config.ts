import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/cli.ts"],
    dts: {
      tsgo: true,
    },
    exports: {
      // cli.ts is a bin-only entry (see package.json#bin), not part of the public API.
      exclude: ["cli"],
      bin: { "scss-codemod": "./src/cli.ts" },
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
