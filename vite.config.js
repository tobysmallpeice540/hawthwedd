import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Two entries, two bundles. The staff app (index.html) and the client portal
// (portal.html) share nothing but the Supabase project: the portal bundle
// contains no staff code at all, which is the point — a wedding client should
// not be shipped the diary, the rota or the Xero panel even in dead code.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main:   resolve(__dirname, 'index.html'),
        portal: resolve(__dirname, 'portal.html'),
      },
    },
  },
})
