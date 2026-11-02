'use strict';

/**
 * 携程 API —— Express 服务（遵循全局采集安全规范）
 *   酒店详情 ✅ Playwright XHR 拦截 (soa2/33278)
 *   酒店搜索 ✅ 移动端 SSR Node https 直调（最快最稳）
 *
 * 部署: Dockerfile 基于 mcr.microsoft.com/playwright:v1.48.0-noble
 *       Chromium 已预装在镜像里（零运行时下载）
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const CONFIG = require('./config');
const { ApiError, CODES } = require('./errors');
const { getHotelDetail, resolveCityId } = require('./scraper');
const { searchHotelsSSR } = require('./scraper-mobile');

// ---------- 浏览器就绪状态（Docker 镜像里已预装，启动时探测一次） ----------
let browserStatus = {
  installed: false,
  chromiumPath: null,
};

function checkChromiumExists() {
  // Playwright 官方 Docker 镜像预装 chromium 的位置
  // 版本号从 1140 开始探测（Playwright 1.48）
  const revisions = ['1140', '1129', '1097', '1084', '1065', '1041', '1026'];
  const searchDirs = [];

  const envPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (envPath) searchDirs.push(envPath);
  searchDirs.push('/root/.cache/ms-playwright');
  searchDirs.push('/home/pwuser/.cache/ms-playwright');

  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) searchDirs.push(path.join(home, '.cache', 'ms-playwright'));

  // Windows 本地开发
  searchDirs.push(path.join(__dirname, '..', '.local-browsers'));

  for (const baseDir of searchDirs) {
    for (const rev of revisions) {
      const linuxChrome = path.join(baseDir, `chromium-${rev}`, 'chrome-linux', 'chrome');
      if (fs.existsSync(linuxChrome)) return linuxChrome;
      const winChrome = path.join(baseDir, `chromium-${rev}`, 'chrome-win', 'chrome.exe');
      if (fs.existsSync(winChrome)) return winChrome;
    }
  }
  return null;
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
    browser: browserStatus.installed ? 'ready' : 'not_found',
    chromium: browserStatus.chromiumPath,
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
    const { hotelId, checkin, checkout } = req.query;
    if (!hotelId || !checkin || !checkout) {
      throw new ApiError(CODES.PARAM, '缺少参数 hotelId / checkin / checkout');
    }
    if (!browserStatus.installed) {
      return res.status(503).json({
        code: CODES.INTERNAL,
        msg: 'Chromium 浏览器未就绪，请检查 Docker 镜像是否包含 Playwright',
        meta: { data_version: CONFIG.dataVersion },
      });
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
// Docker 镜像里 Chromium 已预装 → 启动时探测一次，不需要运行时下载
const server = app.listen(CONFIG.port, '0.0.0.0', () => {
  const exe = checkChromiumExists();
  browserStatus.installed = !!exe;
  browserStatus.chromiumPath = exe;

  console.log('========================================');
  console.log('  Ctrip Hotel API 已启动');
  console.log('  端口:', CONFIG.port, '  版本:', CONFIG.dataVersion);
  console.log('  搜索: 移动端 SSR (Node https)');
  console.log('  详情: PC XHR 拦截 (Playwright)');
  console.log('  限流: ' + CONFIG.rateLimit.maxPerWindow + '次/分钟/IP');
  console.log('========================================');
  if (exe) {
    console.log('[browser] ✅ Chromium 就绪:', exe);
  } else {
    console.log('[browser] ⚠️  未找到 Chromium！');
    console.log('   Docker 镜像可能不包含 Playwright 浏览器。');
    console.log('   detail 接口将返回 503，search 接口不受影响。');
  }
});

module.exports = { app, server };
