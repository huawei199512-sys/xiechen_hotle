/**
 * 启动前确保 Playwright Chromium 已安装
 * 
 * 策略：
 *   1. 先探测系统里是否已有 Chromium（多路径搜索）
 *   2. 没有则安装到 PLAYWRIGHT_BROWSERS_PATH 指向的位置
 *   3. 安装用带实时进度的脚本（让 Render 控制台能看到进度）
 *   4. 超时设为 10 分钟（Render 海外容器微软 CDN 应该 1-3 分钟搞定）
 *   5. 安装失败不阻塞启动（搜索接口不依赖浏览器）
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// 获取 Playwright 需要的 chromium 目录名
// 从 playwright-core 的 package.json 里读 revision，或者用已知值
function getChromiumVersion() {
  try {
    // 方式 1: 从 playwright-core 包里读
    const pwCorePath = require.resolve('playwright-core');
    const pkgDir = path.dirname(pwCorePath);
    // playwright-core 有个 browsers.json 或 registry
    const registryPath = path.join(pkgDir, 'registry.json');
    if (fs.existsSync(registryPath)) {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      const chromiumRev = registry?.chromium?.revision;
      if (chromiumRev) return `chromium-${chromiumRev}`;
    }
    // 也可能在 index.js 附近
    const pkgJson = path.join(pkgDir, 'package.json');
    if (fs.existsSync(pkgJson)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
      // Playwright core 可能暴露 browsers
      if (pkg.browsers?.chromium?.revision) {
        return `chromium-${pkg.browsers.chromium.revision}`;
      }
    }
  } catch (_) { /* ignore */ }

  // 方式 2: 从 playwright 包本身找
  try {
    const pwPath = require.resolve('playwright');
    const pkgDir = path.dirname(pwPath);
    const browsersPath = path.join(pkgDir, '..', '.package-lock.json');
    // 从 package-lock 里找 playwright-core 的版本映射... 太复杂，跳过
  } catch (_) { /* ignore */ }

  // 方式 3: 已知映射表（覆盖 Playwright 1.40 ~ 1.52 常见版本）
  // Playwright → chromium build revision
  const known = {
    '1.48': '1140', '1.48.0': '1140', '1.48.1': '1140',
    '1.47': '1129', '1.47.0': '1129',
    '1.46': '1097',
    '1.45': '1084',
    '1.44': '1065',
    '1.43': '1041',
    '1.42': '1026',
    '1.41': '1012',
    '1.40': '1004',
  };
  try {
    const pwPkg = require('playwright/package.json');
    const ver = pwPkg.version;
    // 先试完整版本，再试主版本号
    if (known[ver]) return `chromium-${known[ver]}`;
    const major = ver.split('.').slice(0, 2).join('.');
    if (known[major]) return `chromium-${known[major]}`;
  } catch (_) { /* ignore */ }

  // 最终 fallback: Playwright 1.48 → chromium-1140
  return 'chromium-1140';
}

// 探测 Chromium 可执行文件
function findChromium() {
  const chromiumVer = getChromiumVersion();
  console.log('[ensure] 探测 Chromium 版本:', chromiumVer);

  const candidates = [];

  // 1. PLAYWRIGHT_BROWSERS_PATH 环境变量
  const envPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (envPath) candidates.push(path.join(envPath, chromiumVer));

  // 2. Render 特定路径
  candidates.push(`/opt/render/.cache/ms-playwright/${chromiumVer}`);
  candidates.push(`/opt/render/project/.cache/ms-playwright/${chromiumVer}`);

  // 3. 系统默认缓存
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) candidates.push(path.join(home, '.cache', 'ms-playwright', chromiumVer));

  // 4. 项目内 .local-browsers
  candidates.push(path.join(__dirname, '..', '.local-browsers', chromiumVer));

  console.log('[ensure] 搜索路径:');
  for (const dir of candidates) console.log('  -', dir);

  // 搜每个候选目录里的 chrome 可执行文件
  for (const dir of candidates) {
    if (!dir || !fs.existsSync(dir)) continue;
    
    const linuxChrome = path.join(dir, 'chrome-linux', 'chrome');
    if (fs.existsSync(linuxChrome)) return { exec: linuxChrome, dir, platform: 'linux' };
    
    const winChrome = path.join(dir, 'chrome-win', 'chrome.exe');
    if (fs.existsSync(winChrome)) return { exec: winChrome, dir, platform: 'win' };
    
    const macChrome = path.join(dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
    if (fs.existsSync(macChrome)) return { exec: macChrome, dir, platform: 'mac' };
  }
  return null;
}

// 带实时输出的安装（用 spawn 而不是 execSync，这样 Render 控制台能看到进度）
function installChromium() {
  return new Promise((resolve, reject) => {
    const targetPath = process.env.PLAYWRIGHT_BROWSERS_PATH 
      || path.join(__dirname, '..', '.local-browsers');
    
    console.log(`[ensure] 📥 开始安装 Chromium → ${targetPath}`);
    console.log('[ensure] ⏳ 首次下载约 1-3 分钟（微软 CDN 在海外很快）...');
    console.log('[ensure] 📋 安装进度将实时输出到日志...');

    const child = spawn('npx', ['playwright', 'install', 'chromium'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: targetPath },
    });

    // 10 分钟超时
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('下载超时（10 分钟），详情接口暂时不可用'));
    }, 600000);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        console.log('[ensure] ✅ playwright install 命令执行完毕');
        resolve();
      } else {
        reject(new Error(`playwright install 退出码: ${code}`));
      }
    });
  });
}

async function main() {
  console.log('========================================');
  console.log('  🚀 Playwright Chromium 检查脚本');
  console.log('========================================');
  console.log('[ensure] 平台:', process.platform);
  console.log('[ensure] Node:', process.version);
  console.log('[ensure] 时间:', new Date().toISOString());
  console.log('');

  // Step 1: 先查有没有
  let found = findChromium();
  if (found) {
    console.log(`\n✅ Chromium 已就绪 (${found.platform}): ${found.exec}`);
    console.log(`   目录: ${found.dir}`);
    process.exit(0);
  }

  // Step 2: 没有就装
  console.log('\n⚠️  Chromium 未找到，开始下载安装...');
  const startTime = Date.now();

  try {
    await installChromium();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Step 3: 装完再查一次
    found = findChromium();
    if (found) {
      console.log(`\n✅ Chromium 安装成功！耗时 ${elapsed}s`);
      console.log(`   路径: ${found.exec}`);
      process.exit(0);
    }

    console.log('\n❌ playwright install 说装完了但我还是找不到...');
    console.log('   让 Playwright 自己找吧（它可能装到别的地方了）');
    
    // 打印 Playwright 自己的状态
    try {
      const { execSync } = require('child_process');
      const pwOut = execSync('npx playwright install --dry-run chromium 2>&1 || npx playwright install chromium --dry-run 2>&1', 
        { encoding: 'utf8', timeout: 10000 });
      console.log('   playwright 状态:', pwOut.substring(0, 500));
    } catch (_) {}

  } catch (err) {
    console.log(`\n❌ Chromium 安装失败: ${err.message}`);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`   耗时: ${elapsed}s`);
    console.log('');
    console.log('   ⚠️ 详情接口暂时不可用（返回 500）');
    console.log('   ✅ 搜索接口不受影响，可正常使用');
    console.log('');
    console.log('   如需修复详情接口：');
    console.log('   1. 在 Render Dashboard 的 Shell 里手动运行:');
    console.log('      PLAYWRIGHT_BROWSERS_PATH=/opt/render/.cache/ms-playwright npx playwright install chromium');
    console.log('   2. 或者改用 Docker 部署（预装 Chromium）');
  }

  // 不让进程退出，让 start 继续
  process.exit(0);
}

main();
