import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { readFileSync } from 'fs'

// Every deploy carries /build.json naming the build it serves. Open tabs poll
// it to learn whether they are still the live build (see fetchLatestBuild in
// App.jsx). Read from APP_BUILD in App.jsx, so there is one place to bump.
function buildStamp() {
  return {
    name: 'hbf-build-stamp',
    generateBundle() {
      const src = readFileSync(resolve(__dirname, 'src/App.jsx'), 'utf8')
      const m = src.match(/^const APP_BUILD = "([^"]+)";/m)
      if (!m) this.error('APP_BUILD not found in src/App.jsx')
      this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify({ build: m[1] }) + '\n' })
    },
  }
}

// Two entries, two bundles. The staff app (index.html) and the client portal
// (portal.html) share nothing but the Supabase project: the portal bundle
// contains no staff code at all, which is the point — a wedding client should
// not be shipped the diary, the rota or the Xero panel even in dead code.
export default defineConfig({
  plugins: [react(), buildStamp()],
  build: {
    rollupOptions: {
      input: {
        main:   resolve(__dirname, 'index.html'),
        portal: resolve(__dirname, 'portal.html'),
      },
    },
  },
})
