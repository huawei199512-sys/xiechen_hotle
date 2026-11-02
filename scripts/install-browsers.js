// 自动安装 Playwright Chromium 浏览器
// 在 package.json 的 postinstall 里调用，确保 Render 上一定装上
// 浏览器装到项目内的 .local-browsers/ 目录（Render 肯定有写权限）

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const BROWSERS_DIR = path.join(__dirname, '.local-browsers');

console.log('📦 安装 Playwright Chromium 浏览器...');
console.log('   存放路径:', BROWSERS_DIR);

// 设置环境变量让 Playwright 装到项目内
process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_DIR;

try {
  // 先确保 playwright 已安装
  try {
    require.resolve('playwright');
  } catch (e) {
    console.log('   playwright 未安装，先 npm install...');
    execSync('npm install playwright@1.48.0', { stdio: 'inherit' });
  }

  // 安装 Chromium + 系统依赖
  console.log('   执行 playwright install chromium --with-deps...');
  execSync('npx playwright install chromium --with-deps', {
    stdio: 'inherit',
    timeout: 120000,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: BROWSERS_DIR },
  });

  // 验证
  const chromiumPath = path.join(BROWSERS_DIR, 'chromium-1140', 'chrome-linux', 'chrome');
  if (fs.existsSync(chromiumPath)) {
    console.log('✅ Chromium 安装成功:', chromiumPath);
  } else {
    console.log('⚠️ 找不到预期路径，搜索一下...');
    // 搜索实际安装位置
    const findChrome = (dir, depth = 0) => {
      if (depth > 5) return null;
      try {
        for (const f of fs.readdirSync(dir)) {
          const full = path.join(dir, f);
          if (f === 'chrome' || f === 'chrome.exe') return full;
          if (fs.statSync(full).isDirectory()) {
            const r = findChrome(full, depth + 1);
            if (r) return r;
          }
        }
      } catch {}
      return null;
    };
    // 在多个可能位置搜
    const searchPaths = [
      BROWSERS_DIR,
      path.join(process.env.HOME || '', '.cache', 'ms-playwright'),
      path.join(process.env.USERPROFILE || '', '.cache', 'ms-playwright'),
    ];
    for (const p of searchPaths) {
      if (fs.existsSync(p)) {
        const found = findChrome(p);
        if (found) { console.log('✅ 找到 Chromium:', found); break; }
      }
    }
  }
} catch (e) {
  console.log('❌ Chromium 安装失败:', e.message);
  console.log('   详情接口会 fallback 到错误返回，搜索接口不受影响');
  // 不 rethrow，让构建继续
}
