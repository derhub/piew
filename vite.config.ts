import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "~": path.resolve(import.meta.dirname, "./src/client"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4175",
      "/events": "http://127.0.0.1:4175",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
