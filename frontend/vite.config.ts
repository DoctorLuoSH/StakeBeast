import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Split heavyweight vendors out of the app chunk (>500 kB warning).
        manualChunks(id: string) {
          const p = id.replace(/\\/g, '/')
          if (!p.includes('node_modules/')) return undefined
          if (p.includes('node_modules/ethers/')) return 'ethers'
          if (/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom)\//.test(p)) {
            return 'react'
          }
          return undefined
        },
      },
    },
  },
})
