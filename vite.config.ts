/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Babel packages reference these build-time flags; the browser has no `process`.
  // (Vitest runs in Node, where `process` exists, so the shim is browser-only.)
  define: process.env.VITEST
    ? {}
    : {
        'process.env.BABEL_8_BREAKING': 'false',
        'process.env.BABEL_TYPES_8_BREAKING': 'false',
        'process.env.IS_PUBLISH': 'false',
      },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    testTimeout: 20000,
  },
});
