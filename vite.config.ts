import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // Fixed port, one below Plass's 5199 — failing beats silently coming up
  // on another port once file-handler/PWA testing points at this origin.
  server: { port: 5198, strictPort: true },
});
