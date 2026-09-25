import { resolve } from "node:path";
import { defineConfig } from "vite";

// Two pages: the job globe (index.html) and the day/night Earth. Dev serves
// both as-is; the build needs them listed or only index.html is emitted.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        jobs: resolve(import.meta.dirname, "index.html"),
        dayNight: resolve(import.meta.dirname, "day-night.html"),
      },
    },
  },
});
