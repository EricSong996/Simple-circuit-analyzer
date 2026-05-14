import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** GitHub Pages：项目页为 /<仓库名>/；用户主页仓库 *.github.io 用 `/`。由 CI 注入 GITHUB_PAGES_BASE。 */
function pagesBase(): string {
  const raw = process.env.GITHUB_PAGES_BASE?.trim()
  if (!raw || raw === '/') return '/'
  const lead = raw.startsWith('/') ? raw : `/${raw}`
  return lead.endsWith('/') ? lead : `${lead}/`
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: pagesBase(),
})
