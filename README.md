# api-ctrip — 携程酒店采集 API

v0.3.0 — 匿名采集，安全优先。

## 功能

| 接口 | 数据来源 | 说明 |
|---|---|---|
| `GET /api/ctrip/search` | 移动端 SSR (`m.ctrip.com`) | Node https 直调 Next.js 预渲染，最快最稳 |
| `GET /api/ctrip/detail` | PC 页 Playwright XHR 拦截 (`soa2/33278`) | 完整房型列表（名称/面积/楼层/床型/窗型） |
| `GET /api/ctrip/cities` | 内置城市表 | 20 个主要城市 id 映射 |
| `GET /health` | — | 健康检查 |

## 已知限制

- **价格字段全为 null**：WhaleGuard 应用层反爬，需可信会话才能解锁（所有匿名采集方案都一样）
- 详情接口冷启动约 13s（Playwright 浏览器启动），搜索约 2s（纯 https）

## 本地运行

```bash
npm install
npx playwright install chromium
npm start
```

默认端口 3123。可通过环境变量覆盖：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3123 | 监听端口 |
| `CTIP_HEADLESS` | 1 | 是否无头运行 Playwright |
| `CTIP_UA` | Chrome 131 | PC 端 User-Agent |
| `CTIP_SEARCH_TIMEOUT` | 15000 | 单次搜索请求超时(ms) |
| `CTIP_DETAIL_BROWSER_TIMEOUT` | 30000 | Playwright 页加载超时(ms) |
| `CTIP_DETAIL_TOTAL` | 60000 | 详情总超时(ms) |
| `CTIP_RATE_MAX` | 12 | 每 IP 每分钟最大请求数 |

## 请求示例

```
GET /api/ctrip/search?city=上海&checkin=2026-11-15&checkout=2026-11-16
GET /api/ctrip/detail?hotelId=1114675&checkin=2026-11-15&checkout=2026-11-16
```

## 响应格式

```json
{
  "code": 0,
  "msg": "ok",
  "data": { ... },
  "meta": { "data_version": "0.3.0", "cached": false }
}
```

错误码：`0=OK` `400=参数错误` `404=路径不存在` `429=限流` `500=内部错误`

## 部署到 Render

详见下方「部署教程」章节。

## 项目结构

```
src/
  server.js           Express 服务（统一响应/限流/超时/安全头）
  config.js           配置（超时/UA/限流/城市）
  errors.js           ApiError + 错误码
  scraper-mobile.js   搜索爬虫（Node https → m.ctrip.com SSR）
  scraper.js          详情爬虫（Playwright → PC XHR 拦截）
scripts/
  random-test.js      本地冒烟测试脚本
render.yaml           Render Blueprint 配置
package.json          依赖: cors + express + playwright
```
