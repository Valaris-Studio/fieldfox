import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  server: {
    host: "127.0.0.1",
    port: 4188,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:4189" },
  },
  build: {
    rollupOptions: {
      output: {
        onlyExplicitManualChunks: true,
        manualChunks(id) {
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id))
            return "react";
          if (id.includes("/node_modules/three/")) return "three";
        },
      },
    },
  },
});
