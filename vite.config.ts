import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { generatePwa } from './scripts/pwa.ts';
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'newbie-cloud-pwa',
      apply: 'build',
      async closeBundle() {
        await generatePwa('dist');
      },
    },
  ],
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  build: { outDir: 'dist' },
});
