import { defineConfig } from 'vite';

// The engine the dev page talks to (SAME_ORIGIN.md, "Development"): vite
// proxies the page's WebSocket to it, so in development as in production
// the page speaks only to the origin that served it, and the engine sees
// the Origin it serves itself on — one code path, no --origin opt-in.
const engine = process.env.KNUTH_ENGINE ?? 'http://127.0.0.1:5197';

export default defineConfig({
  base: './',
  // Fixed port, one below Plass's 5199 — failing beats silently coming up
  // on another port once file-handler/PWA testing points at this origin.
  server: {
    port: 5198,
    strictPort: true,
    proxy: {
      // The page opens its socket at the root of its own origin (kernel.ts,
      // kernelUrl): exactly '/', which this regex matches and nothing else —
      // vite's own HMR socket is '/?token=…' and stays vite's. Only
      // WebSocket upgrades go to the engine; the one plain request at '/'
      // (the page itself) is vite's, by the bypass.
      '^/$': {
        target: engine,
        ws: true,
        bypass: (req) => (req.headers.upgrade?.toLowerCase() === 'websocket' ? undefined : req.url),
        configure: (proxy) => {
          // The engine trusts the Origin it serves the app on; the dev page
          // arrives as that origin, not as vite's.
          proxy.on('proxyReqWs', (proxyReq) => proxyReq.setHeader('origin', engine));
        },
      },
    },
  },
});
