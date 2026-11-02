// 启动前确保 Playwright Chromium 已安装
// 双重保险：postinstall 装一次，start 时再查一次
// 找不到就当场装，装不上也不让服务挂掉（搜索接口不依赖浏览器）

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// 自动探测：支持 Windows (chrome-win/chrome.exe) 和 Linux (chrome-linux/chrome)
function findChromium() {
  const candidates = [];

  // 1. PLAYWRIGHT_BROWSERS_PATH 环境变量
  const envPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (envPath) candidates.push(path.join(envPath, 'chromium-1140'));

  // 2. 项目内 .local-browsers
  candidates.push(path.join(__dirname, '..', '.local-browsers', 'chromium-1140'));

  // 3. 系统默认缓存
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) candidates.push(path.join(home, '.cache', 'ms-playwright', 'chromium-1140'));

  // 4. Render 特定路径
  candidates.push('/opt/render/.cache/ms-playwright/chromium-1140');

  // 搜每个候选目录里的 chrome 可执行文件
  for (const dir of candidates) {
    if (!dir || !fs.existsSync(dir)) continue;
    // chrome-linux/chrome (Linux/Render)
    const linuxChrome = path.join(dir, 'chrome-linux', 'chrome');
    if (fs.existsSync(linuxChrome)) return linuxChrome;
    // chrome-win/chrome.exe (Windows)
    const winChrome = path.join(dir, 'chrome-win', 'chrome.exe');
    if (fs.existsSync(winChrome)) return winChrome;
    // chrome-mac/Chromium.app (macOS)
    const macChrome = path.join(dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
    if (fs.existsSync(macChrome)) return macChrome;
  }
  return null;
}

const found = findChromium();
if (found) {
  console.log('✅ Chromium 已就绪:', found);
  process.exit(0);
}

console.log('⚠️ Chromium 未找到，开始安装 (这可能需要 1-3 分钟)...');
try {
  // 装到项目内，确保 Render 容器有写权限
  const target = path.join(__dirname, '..', '.local-browsers');
  execSync('npx playwright install chromium', {
    stdio: 'inherit',
    timeout: 300000, // 5 分钟足够
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: target },
  });

  const after = findChromium();
  if (after) {
    console.log('✅ Chromium 安装成功:', after);
    process.exit(0);
  }

  console.log('❌ 装完还是找不到... 让 Playwright 自己找');
} catch (e) {
  console.log('❌ Chromium 安装失败:', e.message);
  console.log('   详情接口会返回 500，搜索接口不受影响');
  // 不让进程退出，让 start 继续（搜索接口能正常工作）
}
