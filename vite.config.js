import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5000,
    host: "0.0.0.0",
    strictPort: true, // Fail if port 5000 is in use
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://localhost:5500",
        changeOrigin: true,
      },
      "/pdfs": {
        target: "http://localhost:5500",
        changeOrigin: true,
      },
      "/page-images": {
        target: "http://localhost:5500",
        changeOrigin: true,
      },
    },
  },
});
