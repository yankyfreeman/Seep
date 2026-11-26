import { defineConfig } from 'vite';

const SERVER = `http://localhost:${process.env.PORT ?? 3000}`;

export default defineConfig({
  root: 'src/client',
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/socket.io': { target: SERVER, ws: true },
    },
  },
});
