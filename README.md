# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

## 公网一键部署

本项目为 **Vite 静态站点**（`npm run build` 输出 `dist/`）。任选一种方式即可上线。

### 方式 A：脚本（推荐，本机一条命令）

1. 安装 [Node.js](https://nodejs.org/)，在项目根目录执行。
2. **Vercel（默认）**  
   ```bash
   npm run deploy
   ```  
   或 PowerShell：`.\deploy.ps1`
3. **Netlify**  
   ```bash
   npm run deploy:netlify
   ```  
   或：`.\deploy.ps1 netlify`  
   首次使用 Netlify CLI 时按提示登录并 `link` 站点。

首次运行 `vercel` / `netlify` 会在浏览器中完成登录；成功后 CLI 会打印 **HTTPS 公网地址**。

### 方式 B：控制台「导入 Git 仓库」（零本地 CLI）

- **Vercel**： [vercel.com/new](https://vercel.com/new) → Import 本仓库 → Framework Preset 选 **Vite** → Deploy（已含根目录 `vercel.json`）。
- **Netlify**： [app.netlify.com](https://app.netlify.com) → Add new site → Import → Build command `npm run build`，Publish directory `dist`（与仓库内 `netlify.toml` 一致）。

### 方式 C：只用 GitHub（GitHub Pages + Actions）

适合无法使用 Vercel / Netlify 时。仓库内已有工作流：`.github/workflows/deploy-github-pages.yml`。`vite.config.ts` 会在 CI 里根据仓库名自动设置 `base`（普通仓库为 `/<仓库名>/`，用户主页仓库 `*.github.io` 为 `/`），本地 `npm run dev` 仍为根路径 `/`，不影响开发。

按顺序做即可：

1. **把项目推到 GitHub**  
   在 GitHub 新建空仓库，本地执行 `git init`（若尚未初始化）、`git remote add origin …`、`git add -A`、`git commit`、`git push -u origin main`（若默认分支是 `master`，工作流也已支持；或与 YAML 里分支名保持一致）。

2. **打开 Pages 并选用 Actions 发布**  
   打开仓库 → **Settings** → **Pages** → **Build and deployment** → **Source** 选 **GitHub Actions**（不要选 Deploy from a branch 指向 `dist`，我们由 Action 上传构建产物）。

3. **触发一次部署**  
   推送任意提交到 `main` 或 `master`，或到 **Actions** 页打开 **Deploy GitHub Pages** → **Run workflow**。

4. **等绿色勾完成**  
   在 **Actions** 里查看最新运行；`deploy`  job 成功后，**Settings → Pages** 里会出现站点地址（约 `https://<用户名>.github.io/<仓库名>/`；若仓库名为 `<用户名>.github.io` 则为 `https://<用户名>.github.io/`）。

5. **打不开或白屏时**  
   确认浏览器地址栏路径与仓库类型一致：普通仓库必须带 **`/<仓库名>/`** 这一段；若你后来改了仓库名，需再推一次让 CI 用新名字重新算 `base`。

6. **本地模拟子路径构建（可选）**  
   PowerShell：`$env:GITHUB_PAGES_BASE='/你的仓库名/'; npm run build`，再用 `npx vite preview` 检查资源是否正常。

### 说明

- 仓库内已有 `netlify.toml`，Netlify 会自动使用 `npm run build` 与 `dist`。
- `dist` 在 `.gitignore` 中忽略属正常；云端会重新执行 `build`，无需提交 `dist`。
- 若需国内访问优化，可自行绑定备案域名或使用支持国内访问的静态托管商，构建流程不变。
