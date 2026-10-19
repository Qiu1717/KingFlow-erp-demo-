import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3001' },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('recharts') ||
            id.includes('d3-') ||
            id.includes('victory-vendor')
          )
            return 'charts';
          if (
            id.includes('node_modules') &&
            (id.includes('antd') ||
              id.includes('@ant-design') ||
              /[\\/]rc-/.test(id))
          )
            return 'ui';
        },
      },
    },
    chunkSizeWarningLimit: 1500,
  },
});
