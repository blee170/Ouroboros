// Builds the helper scripts that run OUTSIDE the app bundle (from app.asar.unpacked with a plain
// node binary) as ONE self-contained CommonJS file each, no shared chunks:
//   mcp-server.js  — the board MCP server Claude/Codex/Gemini cards talk to
//   agent-hook.js  — Codex notify / Gemini hooks → Ouroboros hook events
// `--mode agent-hook` selects the second entry; `npm run build:mcp` runs both.
import { defineConfig } from 'vite'
import { builtinModules } from 'node:module'
import { resolve } from 'node:path'

export default defineConfig(({ mode }) => {
  const entry = mode === 'agent-hook' ? 'agent-hook' : 'mcp-server'
  return {
  build: {
    outDir: 'out/main',
    emptyOutDir: false,
    target: 'node20',
    minify: false,
    sourcemap: false,
    lib: {
      entry: resolve(__dirname, `src/main/${entry}.ts`),
      formats: ['cjs'],
      fileName: () => `${entry}.js`
    },
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: { codeSplitting: false }
    }
  }
  }
})
