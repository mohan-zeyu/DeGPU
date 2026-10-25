import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the GUI on :5173 calls /api, which Vite forwards to the DeGPU app on :8700.
// Build: the files go to degpu/web/, which the app serves at http://127.0.0.1:8700/.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8700" } },
  build: { outDir: "../degpu/web", emptyOutDir: true },
});
