import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Read VITE_* variables from the repo-root .env instead of apps/web/.env,
  // so there is a single env file for both the server and the browser build.
  envDir: "../..",
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
});
