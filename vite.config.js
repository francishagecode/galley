import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: true,
  },
  build: {
    target: "es2021",
    minify: false,
    sourcemap: true,
  },
});
