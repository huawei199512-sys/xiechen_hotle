'use strict';

/**
 * 携程 API —— Express 服务（遵循全局采集安全规范）
 *   酒店详情 ✅ Playwright XHR 拦截 (soa2/33278)
 *   酒店搜索 ✅ 移动端 SSR Node https 直调（最快最稳）
 *
 * Render Free 层启动超时问题解决：
 *   Express 立即 listen → health check 秒通 → Render 不杀容器
 *   浏览器后台异步安装（不阻塞启动）
 *   详情接口在浏览器就绪前返回 503，就绪后自动可用
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const CONFIG = require('./config');
const { ApiError, CODES } = require('./errors');
const { getHotelDetail, resolveCityId } = require('./scraper');
const { searchHotelsSSR } = require('./scraper-mobile');

// ---------- 浏览器就绪状态 ----------
let browserStatus = {
  checked: false,
  installed: false,
  installing: false,
  lastError: null,
};

function checkChromiumExists() {
  const candidates = [];
  const envPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (envPath) candidates.push(path.join(envPath, 'chrome-linux', 'chrome'));
  candidates.push('/opt/render/.cache/ms-playwright/chromium-1140/chrome-linux/chrome');
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) candidates.push(path.join(home, '.cache', 'ms-playwright', 'chromium-1140', 'chrome-linux', 'chrome'));
  candidates.push(path.join(__dirname, '..', '.local-browsers', 'chromium-1140', 'chrome-win', 'chrome.exe'));
  candidates.push(path.join(__dirname, '..', '.local-browsers', 'chromium-1140', 'chrome-linux', 'chrome'));

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function installChromiumAsync() {
  if (browserStatus.installing) return;
  browserStatus.installing = true;
  browserStatus.lastError = null;

  const targetPath = process.env.PLAYWRIGHT_BROWSERS_PATH
    || path.join(__dirname, '..', '.local-browsers');

  console.log('[browser] 📥 后台安装 Chromium →', targetPath);
  console.log('[browser] ⏳ 首次下载约 1-3 分钟...');

  const child = spawn('npx', ['playwright', 'install', 'chromium'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: process.platform === 'win32',
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: targetPath },
    detached: false,
  });

  child.on('exit', (code) => {
    if (code === 0) {
      const exe = checkChromiumExists();
      browserStatus.installed = !!exe;
      browserStatus.installing = false;
      browserStatus.checked = true;
      if (exe) console.log('[browser] ✅ Chromium 安装成功 →', exe);
      else console.log('[browser] ⚠️ playwright 说装完了但找不到 chrome');
    } else {
      browserStatus.installing = false;
      browserStatus.lastError = 'exit code ' + code;
      console.log('[browser] ❌ Chromium 安装失败, code:', code);
    }
  });

  child.on('error', (err) => {
    browserStatus.installing = false;
    browserStatus.lastError = err.message;
    console.log('[browser] ❌ spawn error:', err.message);
  });
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------- 安全响应头 ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Data-Version', CONFIG.dataVersion);
  next();
});

// ---------- 客户端 IP 限流 ----------
const limiterStore = new Map();
setInterval(() => {
  const now = Date.now();
  limiterStore.forEach((arr, k) => {
    const recent = arr.filter(t => now - t < CONFIG.rateLimit.windowMs);
    if (recent.length) limiterStore.set(k, recent);
    else limiterStore.delete(k);
  });
}, 60000).unref();

function rateLimit(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || req.ip || 'unknown').toString().split(',')[0].trim();
  const now = Date.now();
  const arr = (limiterStore.get(ip) || []).filter(t => now - t < CONFIG.rateLimit.windowMs);
  if (arr.length >= CONFIG.rateLimit.maxPerWindow) {
    return fail(res, new ApiError(CODES.RISK_CONTROL,
      `请求过于频繁，限流：每 IP 每分钟最多 ${CONFIG.rateLimit.maxPerWindow} 次`));
  }
  arr.push(now);
  limiterStore.set(ip, arr);
  next();
}

// ---------- 统一响应 ----------
function send(res, payload, meta = {}) {
  res.json({
    code: CODES.OK,
    msg: 'ok',
    data: payload,
    meta: { data_version: CONFIG.dataVersion, cached: false, ...meta },
  });
}

function fail(res, err) {
  const code = err instanceof ApiError ? err.code :
    (err.code === 400 ? CODES.PARAM :
     err.code === 429 ? CODES.RISK_CONTROL :
     err.code === 404 ? CODES.NOT_FOUND : CODES.INTERNAL);
  const status =
    code === CODES.PARAM ? 400 :
    code === CODES.NOT_FOUND ? 404 :
    code === CODES.RISK_CONTROL ? 429 : 500;
  res.status(status).json({
    code,
    msg: err.message,
    details: err.details || undefined,
    meta: { data_version: CONFIG.dataVersion },
  });
}

// ---------- 全局硬超时包装 ----------
function withDeadline(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new ApiError(CODES.INTERNAL,
        `${label} 超时（${Math.round(ms / 1000)}s）`)), ms)),
  ]);
}

// ---------- 路由 ----------
app.get('/health', (req, res) => {
  res.json({
    code: CODES.OK,
    status: 'up',
    data_version: CONFIG.dataVersion,
    browser: browserStatus.installed ? 'ready'
      : browserStatus.installing ? 'installing'
      : browserStatus.lastError ? 'error: ' + browserStatus.lastError
      : 'pending',
    time: new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  res.json({
    service: 'Ctrip Hotel API',
    data_version: CONFIG.dataVersion,
    description: '携程酒店搜索（移动端 SSR）+ 酒店详情（PC XHR 拦截）— 匿名采集',
    endpoints: [
      'GET  /health',
      'GET  /api/ctrip/cities',
      'GET  /api/ctrip/detail?hotelId=&checkin=&checkout=',
      'GET  /api/ctrip/search?city=&checkin=&checkout=&keyword=',
    ],
    limits: {
      rate: `${CONFIG.rateLimit.maxPerWindow}次/分钟/IP`,
      detail_timeout: `${Math.round(CONFIG.timeout.detailTotalMs / 1000)}s`,
      search_timeout: `${Math.round(CONFIG.timeout.searchTotalMs / 1000)}s`,
    },
  });
});

app.get('/api/ctrip/cities', rateLimit, (req, res) => {
  send(res, Object.entries(CONFIG.cityMap).map(([name, id]) => ({ name, id })));
});

// ---------- 酒店详情 ----------
app.get('/api/ctrip/detail', rateLimit, async (req, res) => {
  try {
    if (!browserStatus.installed) {
      return res.status(503).json({
        code: CODES.INTERNAL,
        msg: browserStatus.installing
          ? '浏览器正在安装中，请稍后再试（约 1-3 分钟）'
          : '浏览器尚未就绪，请联系管理员',
        meta: {
          data_version: CONFIG.dataVersion,
          browser_status: browserStatus.installing ? 'installing' : 'not_ready',
        },
      });
    }
    const { hotelId, checkin, checkout } = req.query;
    if (!hotelId || !checkin || !checkout) {
      throw new ApiError(CODES.PARAM, '缺少参数 hotelId / checkin / checkout');
    }
    const result = await withDeadline(
      getHotelDetail({ hotelId, checkin, checkout }),
      CONFIG.timeout.detailTotalMs, '详情接口');
    send(res, result);
  } catch (e) { fail(res, e); }
});

// ---------- 酒店搜索 ----------
app.get('/api/ctrip/search', rateLimit, async (req, res) => {
  try {
    const { city, cityId, checkin, checkout, keyword } = req.query;
    if (!checkin || !checkout) {
      throw new ApiError(CODES.PARAM, '缺少 checkin / checkout');
    }
    const resolved = resolveCityId(cityId || city);
    if (!resolved) {
      throw new ApiError(CODES.PARAM,
        `无法解析城市: ${cityId || city}（支持中文名 北京/上海/广州... 或数字 cityId）`);
    }
    const result = await withDeadline(
      searchHotelsSSR({ cityId: resolved, checkin, checkout, keyword: keyword || null }),
      CONFIG.timeout.searchTotalMs, '搜索接口');
    send(res, result);
  } catch (e) { fail(res, e); }
});

// ---------- 404 兜底 ----------
app.use((req, res) => {
  res.status(404).json({
    code: CODES.NOT_FOUND,
    msg: `路径不存在: ${req.method} ${req.path}`,
    meta: { data_version: CONFIG.dataVersion },
    endpoints: [
      'GET /health',
      'GET /api/ctrip/cities',
      'GET /api/ctrip/detail?hotelId=&checkin=&checkout=',
      'GET /api/ctrip/search?city=&checkin=&checkout=',
    ],
  });
});

// ---------- 全局异常 ----------
app.use((err, req, res, next) => fail(res, err));

process.on('uncaughtException', (e) =>
  console.error('[uncaughtException]', e && e.message));
process.on('unhandledRejection', (e) =>
  console.error('[unhandledRejection]', (e && e.message) || e));

// ---------- 启动 ----------
const server = app.listen(CONFIG.port, '0.0.0.0', () => {
  console.log('========================================');
  console.log('  Ctrip Hotel API 已启动');
  console.log('  端口:', CONFIG.port, '  版本:', CONFIG.dataVersion);
  console.log('  搜索: 移动端 SSR (Node https)');
  console.log('  详情: PC XHR 拦截 (Playwright)');
  console.log('  限流: ' + CONFIG.rateLimit.maxPerWindow + '次/分钟/IP');
  console.log('========================================');

  // 先检查有没有 Chromium
  const exe = checkChromiumExists();
  if (exe) {
    browserStatus.installed = true;
    browserStatus.checked = true;
    console.log('[browser] ✅ Chromium 已就绪:', exe);
  } else {
    console.log('[browser] ⚠️ 未找到 Chromium，后台启动安装...');
    // 延迟 5 秒再开始装，让 health check 先稳定
    setTimeout(installChromiumAsync, 5000);
  }
});

module.exports = { app, server };
