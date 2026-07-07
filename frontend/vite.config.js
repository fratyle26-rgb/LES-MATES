import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: false,
    proxy: {
      '/api/auth': 'http://localhost:3001',
      '/api/rbac': 'http://localhost:3002',
      '/api/org': 'http://localhost:3003',
      '/api/finance': 'http://localhost:3004',
    }
  }
})
