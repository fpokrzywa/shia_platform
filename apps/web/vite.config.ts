import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export default defineConfig({
  envDir: resolve(fileURLToPath(new URL("../..", import.meta.url))),
});
