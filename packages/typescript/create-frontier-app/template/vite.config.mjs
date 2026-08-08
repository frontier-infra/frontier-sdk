const apiTarget = `http://127.0.0.1:${process.env.PORT || '8787'}`;

const proxyTarget = {
  target: apiTarget,
  changeOrigin: true,
};

const proxy = {
  '/api': proxyTarget,
  '/.agent': proxyTarget,
  '/agent-view.agent': proxyTarget,
  '/agent.txt': proxyTarget,
  '/llms.txt': proxyTarget,
  '/.well-known': proxyTarget,
  '^/.*\\.agent$': proxyTarget,
};

export default {
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: '127.0.0.1',
    port: Number.parseInt(process.env.VITE_PORT || '5173', 10),
    proxy,
  },
  preview: {
    host: '127.0.0.1',
    port: Number.parseInt(process.env.VITE_PORT || '5173', 10),
    proxy,
  },
};
