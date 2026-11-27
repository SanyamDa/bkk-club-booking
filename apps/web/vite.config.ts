import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1', // live.ts health-checks IPv4; macOS resolves localhost to ::1
    port: 5173,
    // Allow tunnel hostnames (Cloudflare Tunnel / ngrok) so LINE can reach the dev server.
    allowedHosts: true,
    proxy: {
      '/api': api,
      '/line': api,
      '/media': api,
      '/integrations': api,
      '/health': api,
    },
  },
});
