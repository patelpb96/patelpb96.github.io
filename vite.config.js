import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  base: '/', // <-- this is correct for your repo name
  plugins: [react()],
  build: {
    rollupOptions: {
      // Each HTML entry builds to the same path under dist/, so the alchemy page lands at
      // /projects/alchemy/ beside the tennis explorer's static /projects/atp/ (from public/).
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        alchemy: fileURLToPath(new URL('./projects/alchemy/index.html', import.meta.url)),
        newsroom: fileURLToPath(new URL('./projects/newsroom/index.html', import.meta.url)),
        search: fileURLToPath(new URL('./search/index.html', import.meta.url)),
        searchAdvanced: fileURLToPath(new URL('./search/advanced/index.html', import.meta.url)),
      },
    },
  },
  // Dev only: /search/ and /search/advanced/ talk to the live API (its config and the Lambda behind CloudFront).
  server: {
    proxy: {
      '/api/search': { target: 'https://patelpb.com', changeOrigin: true },
      '/live/search': { target: 'https://patelpb.com', changeOrigin: true },
    },
  },
})
