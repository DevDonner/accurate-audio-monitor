import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The lab files live at the repo root (so the portfolio can copy them),
// but node_modules lives here in dev/. Alias React into the root files
// explicitly — normal node_modules walking can't reach us from one level up.
const nm = (p: string) => fileURLToPath(new URL(`./node_modules/${p}`, import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      'react/jsx-dev-runtime': nm('react/jsx-dev-runtime.js'),
      'react/jsx-runtime': nm('react/jsx-runtime.js'),
      'react-dom/client': nm('react-dom/client.js'),
      'react-dom': nm('react-dom/index.js'),
      react: nm('react/index.js'),
    },
  },
})
