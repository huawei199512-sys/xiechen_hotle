'use strict';

/**
 * 采集规范（沿用 api_goofish / amazon_image_api 约定）：
 * 1. 业务响应不落缓存（响应头 X-Data-Version / meta.cached=false）
 * 2. 遵守 robots.txt：已核实 m.ctrip.com / hotels.ctrip.com User-agent:* 仅禁极少路径
 * 3. 搜索接口走 SSR（Node https 直调 m.ctrip.com），详情走 Playwright XHR 拦截
 * 4. 单次请求硬超时：详情 ≤ 60s（含浏览器启动），搜索 ≤ 15s（纯 https）
 * 5. 匿名采集，不使用任何登录 Cookie
 * 6. 客户端限流：每 IP 每分钟 12 次（人类节奏）
 * 7. 不伪造 / 注入 Cookie 参数，走 SSR 预渲染的公开数据通道
 */

const path = require('path');

module.exports = {
  root: path.resolve(__dirname, '..'),
  dataVersion: '0.3.0',

  port: Number(process.env.PORT || 3123),

  appName: 'api-ctrip',
  description: '携程酒店搜索（移动端 SSR）+ 酒店详情（PC XHR 拦截）— 匿名采集',

  // ---------- 上游 ----------
  mobileHost: 'https://m.ctrip.com',
  pcHost: 'https://hotels.ctrip.com',
  acceptLanguage: 'zh-CN,zh;q=0.9',

  // ---------- User-Agent ----------
  // 搜索（移动端 SSR）用 iPhone UA；详情（PC 页 Playwright）用 Chrome UA
  mobileUserAgents: [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ],
  pcUserAgent:
    process.env.CTRIP_UA ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',

  // ---------- 超时 ----------
  timeout: {
    // 搜索接口（Node https 直调 SSR）
    searchRequestMs: Number(process.env.CTRIP_SEARCH_TIMEOUT || 15000),
    searchTotalMs: Number(process.env.CTRIP_SEARCH_TOTAL || 20000),
    // 详情接口（Playwright Chromium）
    detailBrowserMs: Number(process.env.CTRIP_DETAIL_BROWSER_TIMEOUT || 30000),
    detailWaitAfterLoadMs: 8000,
    detailTotalMs: Number(process.env.CTRIP_DETAIL_TOTAL || 60000),
  },

  // ---------- 限流 ----------
  rateLimit: {
    maxPerWindow: Number(process.env.CTRIP_RATE_MAX || 12),
    windowMs: Number(process.env.CTRIP_RATE_WINDOW || 60000),
  },

  // ---------- 城市 ----------
  cityMap: {
    '北京': 1, '上海': 2, '广州': 32, '深圳': 30,
    '杭州': 17, '成都': 28, '重庆': 35, '南京': 22,
    '武汉': 16, '西安': 7, '苏州': 15, '厦门': 14,
    '天津': 3, '青岛': 5, '长沙': 150, '昆明': 39,
    '三亚': 42, '福州': 13, '郑州': 8, '济南': 4,
  },

  // ---------- Playwright ----------
  headless: process.env.CTRIP_HEADLESS !== '0',
  noSandbox: true,
};
