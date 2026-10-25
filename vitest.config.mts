import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  // 30 s: the Windows release runner's disk has taken over 5 s for a few temp-dir tests (0.8.1 failed on skills.test.ts at 5.8 s)
  test: { include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 30_000 }
})
