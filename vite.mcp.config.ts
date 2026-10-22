// Builds the board MCP server as ONE self-contained CommonJS file (no shared chunks),
// because it runs outside the app bundle: from app.asar.unpacked with a plain node binary.
import { defineConfig } from 'vite'
import { builtinModules } from 'node:module'
import { resolve } from 'node:path'

export default defineConfig({
  build: {
    outDir: 'out/main',
    emptyOutDir: false,
    target: 'node20',
    minify: false,
    sourcemap: false,
    lib: {
      entry: resolve(__dirname, 'src/main/mcp-server.ts'),
      formats: ['cjs'],
      fileName: () => 'mcp-server.js'
    },
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: { inlineDynamicImports: true }
    }
  }
})
