import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Allow tunnel hostnames (Cloudflare Tunnel / ngrok) so LINE can reach the dev server.
    allowedHosts: true,
    proxy: {
      '/api': api,
      '/line': api,
      '/media': api,
      '/health': api,
    },
  },
});
