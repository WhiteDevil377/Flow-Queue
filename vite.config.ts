import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    emptyOutDir: true,
    outDir: "dist",
    sourcemap: false,
    minify: "esbuild",
    cssMinify: "esbuild",
    reportCompressedSize: false,
    rollupOptions: {
      input: {
        sidepanel: "src/sidepanel/index.html",
        background: "src/background/index.ts",
        content: "src/content/index.ts"
      },
      output: {
        generatedCode: "es2015",
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  }
});
