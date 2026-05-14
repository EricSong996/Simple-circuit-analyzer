# 一键构建并部署到公网（需已安装 Node.js，首次需浏览器登录对应平台）
# 用法:
#   .\deploy.ps1           # 默认 Vercel 生产环境
#   .\deploy.ps1 netlify   # 使用 Netlify
#   .\deploy.ps1 preview   # Vercel 预览部署（非生产域名）

param(
  [ValidateSet('', 'vercel', 'netlify', 'preview')]
  [string]$Target = 'vercel'
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

npm run build

if ($Target -eq 'netlify') {
  Write-Host '>>> Netlify 生产部署（若未关联站点，按 CLI 提示执行 netlify init 或 link）' -ForegroundColor Cyan
  npx --yes netlify deploy --prod --dir=dist
} elseif ($Target -eq 'preview') {
  Write-Host '>>> Vercel 预览部署' -ForegroundColor Cyan
  npx --yes vercel deploy
} else {
  Write-Host '>>> Vercel 生产部署' -ForegroundColor Cyan
  npx --yes vercel deploy --prod
}
