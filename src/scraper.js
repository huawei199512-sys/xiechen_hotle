'use strict';

/**
 * 携程详情爬虫 —— PC 页 Playwright XHR 拦截（soa2/33278）
 *
 * 反爬说明：
 *   - PC 端 hotels.ctrip.com 的 WhaleGuard 会对"无信誉会话"做 server-side 价格隐藏
 *   - 详情页 URL 不跳登录 ✅，房型信息完整；但价格字段 `isHidePrice=true`
 *   - 搜索列表页已完全由 scraper-mobile.js（移动端 SSR）接管
 *   - 本模块仅负责：Playwright 拦截 soa2 XHR → 解析房型 JSON
 *
 * 安全规范（与 api_goofish / amazon_image_api 对齐）：
 *   1. 浏览器启动硬超时（detailBrowserMs），外层还有 detailTotalMs 兜底
 *   2. UA 从 config 读取；不伪造/注入 Cookie
 *   3. 统一错误码（ApiError + CODES）
 *
 * Playwright 浏览器位置探测：
 *   优先用项目内 .local-browsers/（postinstall 安装）
 *   fallback 到 PLAYWRIGHT_BROWSERS_PATH 环境变量指向的位置
 *   再 fallback 到 Playwright 默认 ~/.cache/ms-playwright/
 */

const fs = require('fs');
const path = require('path');

// 设置浏览器查找路径优先级
const localBrowsers = path.resolve(__dirname, '..', '.local-browsers');
if (fs.existsSync(localBrowsers)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = localBrowsers;
}

const { chromium } = require('playwright');
const CONFIG = require('./config');
const { ApiError, CODES } = require('./errors');

// =====================================================================
// BrowserEngine —— 管理浏览器 + XHR 拦截
// =====================================================================

class BrowserEngine {
  constructor() {
    this.headless = CONFIG.headless;
    this.browserTimeout = CONFIG.timeout.detailBrowserMs;
    this.waitAfterLoad = CONFIG.timeout.detailWaitAfterLoadMs;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.xhrLog = [];
  }

  async launch() {
    // 安全网：Playwright 找不到浏览器时，现场装一次
    try {
      await this._doLaunch();
    } catch (e) {
      if (e.message && e.message.includes("Executable doesn't exist")) {
        console.log('🔧 浏览器不存在，执行 playwright install chromium...');
        const { execSync } = require('child_process');
        try {
          execSync('npx playwright install chromium', {
            stdio: 'inherit',
            timeout: 180000,
          });
          console.log('✅ Chromium 安装完成，重试启动浏览器...');
          await this._doLaunch();
        } catch (installErr) {
          throw new Error(
            `Playwright 安装 Chromium 也失败了: ${installErr.message}\n` +
            `原始错误: ${e.message}`
          );
        }
      } else {
        throw e;
      }
    }
  }

  async _doLaunch() {
    this.browser = await chromium.launch({
      headless: this.headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-infobars',
        '--disable-dev-shm-usage',
      ],
    });
    this.context = await this.browser.newContext({
      userAgent: CONFIG.pcUserAgent,
      viewport: { width: 1920, height: 1080 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      colorScheme: 'light',
      acceptLanguage: CONFIG.acceptLanguage,
    });
    this.page = await this.context.newPage();

    // 基础反检测（仅覆盖 webdriver 标记；TLS 指纹层 WhaleGuard 仍可识别 —— 但详情页不拦 TLS）
    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });

    // 用 page.route 拦截 soa2 / restapi XHR
    await this.page.route('**', async (route) => {
      const url = route.request().url();
      if (!url.includes('ctrip.com')) { await route.continue(); return; }
      if (!url.includes('soa2') && !url.includes('restapi') && !url.includes('rest/soa')) {
        await route.continue(); return;
      }

      const response = await route.fetch();
      const bodyText = await response.text();
      let parsed = null;
      try { parsed = JSON.parse(bodyText); } catch (_) { /* 不是 JSON */ }

      this.xhrLog.push({
        url,
        status: response.status(),
        method: route.request().method(),
        postData: route.request().postData(),
        body: parsed,
      });

      await route.fulfill({ response });
    });
  }

  async goto(url) {
    if (!this.page) await this.launch();
    this.xhrLog = [];

    await this.page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: this.browserTimeout,
    });
    await this.page.waitForTimeout(this.waitAfterLoad);

    const finalUrl = this.page.url();
    if (finalUrl.includes('passport.ctrip.com')) {
      throw new ApiError(CODES.RISK_CONTROL, '被重定向到登录页（反爬 gate）');
    }
    return finalUrl;
  }

  getXhrLog() { return this.xhrLog; }

  async eval(fn, ...args) { return await this.page.evaluate(fn, ...args); }

  async close() {
    if (this.page) { try { await this.page.close(); } catch (_) { /* noop */ } }
    if (this.context) { try { await this.context.close(); } catch (_) { /* noop */ } }
    if (this.browser) { try { await this.browser.close(); } catch (_) { /* noop */ } }
    this.browser = this.context = this.page = null;
  }
}

// =====================================================================
// 详情页主入口
// =====================================================================

/**
 * 获取酒店详情
 * @param {object} params
 * @param {number|string} params.hotelId
 * @param {string} params.checkin  YYYY-MM-DD
 * @param {string} params.checkout YYYY-MM-DD
 * @returns {Promise<object>}
 */
async function getHotelDetail({ hotelId, checkin, checkout }) {
  if (!hotelId) throw new ApiError(CODES.PARAM, '缺少 hotelId');

  const url = `${CONFIG.pcHost}/hotel/${hotelId}.html?checkin=${checkin}&checkout=${checkout}`;

  const engine = new BrowserEngine();
  try {
    await engine.goto(url);
    const xhrLog = engine.getXhrLog();

    // 1. 优先从 soa2/33278/getHotelRoomListInland 解析
    const roomListHit = xhrLog.find(h =>
      h.url.includes('getHotelRoomListInland') && h.body?.data);

    if (roomListHit) {
      const detail = parseHotelDetailFromXHR(roomListHit.body, { hotelId, checkin, checkout });
      if (detail && detail.rooms && detail.rooms.length > 0) {
        // 补充酒店名 + 评分（DOM 取，XHR 不直接给）
        const domMeta = await engine.eval(() => {
          const text = document.body.innerText;
          const el = document.querySelector('.hotel-title, h1, [class*="hotel-name" i]');
          const scoreMatch = text.match(/([4-5]\.\d)\s*超棒/);
          return {
            hotelName: el ? el.innerText.trim() : null,
            score: scoreMatch ? parseFloat(scoreMatch[1]) : null,
          };
        });
        return {
          ...domMeta,
          ...detail,
          source: 'xhr-33278',
          _note: '价格字段由 WhaleGuard 根据会话信誉决定；isPriceHidden=true 表示需要可信会话',
        };
      }
    }

    // 2. 降级 DOM 解析
    console.warn('[detail] XHR 未命中，降级 DOM');
    const domDetail = await engine.eval(parseHotelDetailFromDOM);
    domDetail.source = 'dom';
    domDetail.hotelId = Number(hotelId);
    domDetail.checkin = checkin;
    domDetail.checkout = checkout;
    return domDetail;
  } finally {
    await engine.close();
  }
}

// =====================================================================
// XHR JSON 解析 —— soa2/33278/getHotelRoomListInland
// =====================================================================

function parseHotelDetailFromXHR(body, params) {
  const data = body.data || {};
  const physicRoomMap = data.physicRoomMap || {};
  const saleRoomMap = data.saleRoomMap || {};

  // 价格隐藏统计
  let hideCount = 0, showCount = 0;
  const allSaleRooms = Object.values(saleRoomMap);
  for (const s of allSaleRooms) {
    if (s.bookingStatusInfo?.isHidePrice) hideCount++;
    else showCount++;
  }
  const isPriceHidden = hideCount > 0 && showCount === 0;

  // 构建房型列表
  const rooms = [];
  for (const physKey of Object.keys(physicRoomMap)) {
    const phys = physicRoomMap[physKey];
    const subRooms = allSaleRooms.filter(s => String(s.physicalRoomId) === physKey);

    let displayPrice = null, deletePrice = null;
    for (const s of subRooms) {
      const pi = s.priceInfo || {};
      if (pi.displayPrice) displayPrice = pi.displayPrice;
      if (pi.deletePrice) deletePrice = pi.deletePrice;
    }

    const minRemain = subRooms.reduce((m, s) => {
      const r = s.bookingStatusInfo?.remainRoomQuantity ?? 0;
      return Math.min(m, r > 0 ? r : m);
    }, 999);

    rooms.push({
      physicalRoomId: phys.id,
      name: phys.name,
      area: phys.areaInfo?.title || null,
      floor: phys.floorInfo?.title || null,
      bedType: phys.bedInfo?.title || null,
      window: phys.windowInfo?.title || null,
      smoking: phys.smokeInfo?.title || null,
      pictures: (phys.pictureInfo || []).map(p => p.url),
      saleRoomCount: subRooms.length,
      minRemainRoom: minRemain === 999 ? null : minRemain,
      displayPrice,
      deletePrice,
      isPriceHidden,
      guaranteeText: subRooms[0]?.bookingStatusInfo?.guaranteeText || null,
      cancelInfo: subRooms[0]?.cancelInfo || null,
      mealInfo: subRooms[0]?.mealInfo || null,
      subSaleRooms: subRooms.map(s => ({
        saleRoomId: s.id,
        roomCode: s.roomCode,
        subHotelId: s.subHotelId,
        displayPrice: s.priceInfo?.displayPrice || null,
        deletePrice: s.priceInfo?.deletePrice || null,
        isHidePrice: s.bookingStatusInfo?.isHidePrice,
        buttonText: s.bookingStatusInfo?.buttonText,
      })),
    });
  }

  return {
    hotelId: Number(params.hotelId),
    checkin: params.checkin,
    checkout: params.checkout,
    totalRoomTypes: rooms.length,
    totalSaleRooms: Object.keys(saleRoomMap).length,
    isPriceHidden,
    priceHideRatio: { hide: hideCount, show: showCount },
    rooms,
  };
}

// =====================================================================
// DOM 降级解析
// =====================================================================

function parseHotelDetailFromDOM() {
  const text = document.body.innerText;
  const hotelNameEl = document.querySelector('.hotel-title, h1, [class*="hotel-name" i]');
  const hotelName = hotelNameEl ? hotelNameEl.innerText.trim() : null;
  const scoreMatch = text.match(/([4-5]\.\d)\s*超棒/);
  const score = scoreMatch ? parseFloat(scoreMatch[1]) : null;
  const addrMatch = text.match(/([\u4e00-\u9fa5]+(?:省|市|区|县|路|街|号)[^\n]{0,50})/);
  const address = addrMatch ? addrMatch[1].trim() : null;

  return {
    hotelName,
    score,
    address,
    rooms: [],
    isPriceHidden: true,
    _domOnly: true,
    _note: 'DOM 降级解析，房型和价格信息不可用。需 Playwright XHR 拦截才能获取完整数据。',
  };
}

// =====================================================================
// 工具：城市解析（供 server.js 调用）
// =====================================================================

function resolveCityId(input) {
  if (typeof input === 'number') return input;
  if (input == null) return null;
  if (/^\d+$/.test(String(input))) return parseInt(input, 10);
  return CONFIG.cityMap[input] || null;
}

module.exports = {
  getHotelDetail,
  resolveCityId,
  BrowserEngine,
};
