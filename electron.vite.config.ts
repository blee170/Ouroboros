import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    // Bundle the MCP SDK into mcp-server.js so it runs from the unpacked file without node_modules.
    plugins: [externalizeDepsPlugin({ exclude: ['@modelcontextprotocol/sdk', 'zod'] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'mcp-server': resolve(__dirname, 'src/main/mcp-server.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared'), '@': resolve(__dirname, 'src/renderer/src') }
    },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    }
  }
})
