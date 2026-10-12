import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  test: {
    // Engine/audio/session tests run in Node; UI tests opt into jsdom per file with
    // `// @vitest-environment jsdom`.
    environment: 'node',
  },
});
