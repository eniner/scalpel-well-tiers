import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    alias: { '@scalpelpoe/plugin-sdk': resolve(__dirname, 'src/test/sdk-mock.tsx') },
  },
})
