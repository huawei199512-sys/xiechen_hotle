// 携程 API 随机测试脚本
// 随机城市 + 随机关键字 → 搜索 → 详情 → 生成报告

const http = require('http');
const fs = require('fs');
const path = require('path');

const API_BASE = 'http://localhost:3123';
const REPORT_OUT = path.join(__dirname, '../_test_report');
fs.mkdirSync(REPORT_OUT, { recursive: true });

// ============= 随机选择 =============
const CITIES = {
  '北京': 1, '上海': 2, '广州': 32, '深圳': 30,
  '杭州': 17, '成都': 28, '重庆': 35, '南京': 22,
  '武汉': 16, '西安': 7, '苏州': 15, '厦门': 14,
};

const KEYWORDS = [
  '如家', '汉庭', '锦江', '维也纳', '全季',
  '希尔顿', '万豪', '香格里拉', '洲际', '凯悦',
  '温泉', '度假', '精品', '设计', '商务',
  '迪士尼', '外滩', '西湖', '故宫', '天安门',
];

function pickRandom(arr, n) {
  const copy = [...arr];
  const picked = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    picked.push(copy.splice(idx, 1)[0]);
  }
  return picked;
}

// 日期：今天 + 明天
const today = new Date();
const tomorrow = new Date(today.getTime() + 86400000);
const fmt = d => d.toISOString().slice(0, 10);
const CHECKIN = fmt(today);
const CHECKOUT = fmt(tomorrow);

const TEST_CITIES = pickRandom(Object.keys(CITIES), 5);
const TEST_KEYWORDS = pickRandom(KEYWORDS, 5);

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║          携程 API 随机测试                                 ║');
console.log('╠══════════════════════════════════════════════════════════╣');
console.log('║  日期: ' + CHECKIN + ' → ' + CHECKOUT.padEnd(30) + '║');
console.log('║  城市: ' + TEST_CITIES.join(' / ').padEnd(30) + '║');
console.log('║  关键字: ' + TEST_KEYWORDS.join(' / ').padEnd(26) + '║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

// ============= HTTP GET =============
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    http.get(url, { timeout: 120000 }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        const latency = Date.now() - start;
        try {
          const json = JSON.parse(body);
          resolve({ status: res.statusCode, latency, json });
        } catch {
          resolve({ status: res.statusCode, latency, body });
        }
      });
    }).on('error', reject).on('timeout', function () {
      this.destroy();
      reject(new Error('timeout'));
    });
  });
}

// ============= 测试执行 =============
const report = {
  timestamp: new Date().toISOString(),
  checkin: CHECKIN,
  checkout: CHECKOUT,
  cities: TEST_CITIES,
  keywords: TEST_KEYWORDS,
  searchTests: [],
  detailTests: [],
  summary: {
    searchTotal: 0, searchPassed: 0, searchFailed: 0,
    detailTotal: 0, detailPassed: 0, detailFailed: 0,
  },
};

async function run() {
  // ---------- 阶段 1: 搜索测试 ----------
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  阶段 1: 搜索接口测试');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const searchResults = [];

  for (const city of TEST_CITIES) {
    // 测试 1: 纯城市（不带 keyword）
    report.summary.searchTotal++;
    const url1 = `${API_BASE}/api/ctrip/search?city=${encodeURIComponent(city)}&checkin=${CHECKIN}&checkout=${CHECKOUT}`;
    console.log(`🔍 搜索: ${city} (无 keyword)`);
    console.log(`   GET /api/ctrip/search?city=${city}&checkin=${CHECKIN}&checkout=${CHECKOUT}`);

    try {
      const { status, latency, json } = await httpGet(url1);
      const ok = status === 200 && json.ok === true && Array.isArray(json.hotels) && json.hotels.length > 0;
      const result = {
        city, keyword: null, checkin: CHECKIN, checkout: CHECKOUT,
        status, latency, ok,
        total: json.total || json.hotels?.length || 0,
        priceHideRatio: json.priceHideRatio,
        error: json.ok === false ? json.error : null,
      };
      report.searchTests.push(result);
      searchResults.push({ city, keyword: null, hotels: json.hotels || [] });

      if (ok) {
        report.summary.searchPassed++;
        console.log(`   ✅ PASS  [${status}] ${latency}ms → ${result.total} 家酒店 (hide ${json.priceHideRatio?.hide || '?'} / show ${json.priceHideRatio?.show || '?'})`);
      } else {
        report.summary.searchFailed++;
        console.log(`   ❌ FAIL  [${status}] ${latency}ms → ${json.error || 'no hotels'}`);
      }
    } catch (e) {
      report.summary.searchFailed++;
      report.searchTests.push({ city, keyword: null, ok: false, error: e.message });
      console.log(`   ❌ ERROR  ${e.message}`);
    }
    console.log('');
  }

  // 测试 2: 城市 + keyword（配对测试）
  for (let i = 0; i < Math.min(TEST_CITIES.length, TEST_KEYWORDS.length); i++) {
    const city = TEST_CITIES[i];
    const keyword = TEST_KEYWORDS[i];
    report.summary.searchTotal++;
    const url = `${API_BASE}/api/ctrip/search?city=${encodeURIComponent(city)}&checkin=${CHECKIN}&checkout=${CHECKOUT}&keyword=${encodeURIComponent(keyword)}`;
    console.log(`🔍 搜索: ${city} + keyword="${keyword}"`);
    console.log(`   GET /api/ctrip/search?city=${city}&keyword=${keyword}`);

    try {
      const { status, latency, json } = await httpGet(url);
      const ok = status === 200 && json.ok === true && Array.isArray(json.hotels) && json.hotels.length > 0;
      const result = {
        city, keyword, checkin: CHECKIN, checkout: CHECKOUT,
        status, latency, ok,
        total: json.total || json.hotels?.length || 0,
        priceHideRatio: json.priceHideRatio,
        error: json.ok === false ? json.error : null,
      };
      report.searchTests.push(result);
      searchResults.push({ city, keyword, hotels: json.hotels || [] });

      if (ok) {
        report.summary.searchPassed++;
        // 检查是否有酒店名包含 keyword
        const matched = json.hotels.filter(h => h.hotelName?.includes(keyword)).length;
        console.log(`   ✅ PASS  [${status}] ${latency}ms → ${result.total} 家 (名称匹配 "${keyword}": ${matched})`);
      } else {
        report.summary.searchFailed++;
        console.log(`   ❌ FAIL  [${status}] ${latency}ms → ${json.error || 'no hotels'}`);
      }
    } catch (e) {
      report.summary.searchFailed++;
      report.searchTests.push({ city, keyword, ok: false, error: e.message });
      console.log(`   ❌ ERROR  ${e.message}`);
    }
    console.log('');
  }

  // ---------- 阶段 2: 详情测试 ----------
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  阶段 2: 酒店详情测试（从搜索结果中挑选）');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // 从每个有结果的搜索里挑最多 2 家
  const detailTargets = [];
  for (const sr of searchResults) {
    const toPick = sr.hotels.slice(0, 2);
    for (const h of toPick) {
      if (h.hotelId) detailTargets.push({ hotelId: h.hotelId, hotelName: h.hotelName, city: sr.city, keyword: sr.keyword });
    }
  }

  console.log(`📋 待测试详情: ${detailTargets.length} 家酒店\n`);

  for (const target of detailTargets) {
    report.summary.detailTotal++;
    const url = `${API_BASE}/api/ctrip/detail?hotelId=${target.hotelId}&checkin=${CHECKIN}&checkout=${CHECKOUT}`;
    console.log(`🏨 详情: [${target.hotelId}] ${target.hotelName}`);
    console.log(`   GET /api/ctrip/detail?hotelId=${target.hotelId}`);

    try {
      const { status, latency, json } = await httpGet(url);
      const ok = status === 200 && json.ok === true && Array.isArray(json.rooms) && json.rooms.length > 0;
      const result = {
        hotelId: target.hotelId, hotelName: target.hotelName, city: target.city,
        status, latency, ok,
        totalRoomTypes: json.totalRoomTypes,
        totalSaleRooms: json.totalSaleRooms,
        priceHideRatio: json.priceHideRatio,
        source: json.source,
        error: json.ok === false ? json.error : null,
      };
      report.detailTests.push(result);

      if (ok) {
        report.summary.detailPassed++;
        console.log(`   ✅ PASS  [${status}] ${latency}ms → ${json.totalRoomTypes} 房型 / ${json.totalSaleRooms} 销售房`);
        console.log(`      source=${json.source} hide=${json.priceHideRatio?.hide}/${json.priceHideRatio?.show}`);
      } else {
        report.summary.detailFailed++;
        console.log(`   ❌ FAIL  [${status}] ${latency}ms → ${json.error || 'no rooms'}`);
      }
    } catch (e) {
      report.summary.detailFailed++;
      report.detailTests.push({ hotelId: target.hotelId, ok: false, error: e.message });
      console.log(`   ❌ ERROR  ${e.message}`);
    }
    console.log('');
  }

  // ---------- 阶段 3: 汇总报告 ----------
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  阶段 3: 测试汇总');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const s = report.summary;
  const searchPassRate = s.searchTotal > 0 ? (s.searchPassed / s.searchTotal * 100).toFixed(1) : '0';
  const detailPassRate = s.detailTotal > 0 ? (s.detailPassed / s.detailTotal * 100).toFixed(1) : '0';
  const totalPassRate = ((s.searchPassed + s.detailPassed) / (s.searchTotal + s.detailTotal) * 100).toFixed(1);

  console.log(`  📊 搜索接口: ${s.searchPassed}/${s.searchTotal} 通过 (${searchPassRate}%)`);
  console.log(`  📊 详情接口: ${s.detailPassed}/${s.detailTotal} 通过 (${detailPassRate}%)`);
  console.log(`  📊 总计: ${s.searchPassed + s.detailPassed}/${s.searchTotal + s.detailTotal} 通过 (${totalPassRate}%)\n`);

  // 价格隐藏统计
  const allPriceHidden = report.searchTests.filter(t => t.priceHideRatio && t.priceHideRatio.show === 0).length;
  const detailPriceHidden = report.detailTests.filter(t => t.priceHideRatio && t.priceHideRatio.show === 0).length;
  console.log(`  💰 搜索结果价格全隐藏: ${allPriceHidden}/${report.searchTests.filter(t => t.ok).length} 次`);
  console.log(`  💰 详情页价格全隐藏: ${detailPriceHidden}/${report.detailTests.filter(t => t.ok).length} 次\n`);

  // 延迟统计
  const searchLatencies = report.searchTests.filter(t => t.ok).map(t => t.latency);
  const detailLatencies = report.detailTests.filter(t => t.ok).map(t => t.latency);
  if (searchLatencies.length > 0) {
    const avg = (searchLatencies.reduce((a, b) => a + b, 0) / searchLatencies.length).toFixed(0);
    const min = Math.min(...searchLatencies);
    const max = Math.max(...searchLatencies);
    console.log(`  ⏱ 搜索延迟: avg=${avg}ms min=${min}ms max=${max}ms`);
  }
  if (detailLatencies.length > 0) {
    const avg = (detailLatencies.reduce((a, b) => a + b, 0) / detailLatencies.length).toFixed(0);
    const min = Math.min(...detailLatencies);
    const max = Math.max(...detailLatencies);
    console.log(`  ⏱ 详情延迟: avg=${avg}ms min=${min}ms max=${max}ms`);
  }

  // 保存 JSON 报告
  const jsonPath = path.join(REPORT_OUT, 'test-report.json');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(`\n💾 JSON 报告: ${jsonPath}`);

  // 保存 Markdown 报告
  const mdPath = path.join(REPORT_OUT, 'test-report.md');
  const md = generateMarkdown(report);
  fs.writeFileSync(mdPath, md);
  console.log(`💾 Markdown 报告: ${mdPath}`);

  return report;
}

function generateMarkdown(r) {
  const s = r.summary;
  const lines = [];
  lines.push(`# 携程 API 随机测试报告`);
  lines.push('');
  lines.push(`**测试时间**: ${r.timestamp}`);
  lines.push(`**日期**: ${r.checkin} → ${r.checkout}`);
  lines.push('');
  lines.push(`## 测试参数`);
  lines.push('');
  lines.push(`| 项目 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| 随机城市 | ${r.cities.join(', ')} |`);
  lines.push(`| 随机关键字 | ${r.keywords.join(', ')} |`);
  lines.push('');
  lines.push(`## 汇总`);
  lines.push('');
  lines.push(`| 接口 | 通过 | 总计 | 通过率 |`);
  lines.push(`|------|------|------|--------|`);
  const sr = s.searchTotal > 0 ? (s.searchPassed / s.searchTotal * 100).toFixed(1) : 0;
  const dr = s.detailTotal > 0 ? (s.detailPassed / s.detailTotal * 100).toFixed(1) : 0;
  lines.push(`| 搜索 /api/ctrip/search | ${s.searchPassed} | ${s.searchTotal} | ${sr}% |`);
  lines.push(`| 详情 /api/ctrip/detail | ${s.detailPassed} | ${s.detailTotal} | ${dr}% |`);
  lines.push(`| **合计** | **${s.searchPassed + s.detailPassed}** | **${s.searchTotal + s.detailTotal}** | **${((s.searchPassed + s.detailPassed) / (s.searchTotal + s.detailTotal) * 100).toFixed(1)}%** |`);
  lines.push('');
  lines.push(`### 搜索接口详细结果`);
  lines.push('');
  lines.push(`| # | 城市 | 关键字 | 状态 | 延迟(ms) | 酒店数 | 价格(隐藏/显示) |`);
  lines.push(`|---|------|--------|------|----------|--------|-----------------|`);
  r.searchTests.forEach((t, i) => {
    const status = t.ok ? '✅' : '❌';
    const kw = t.keyword || '(无)';
    const hide = t.priceHideRatio ? `${t.priceHideRatio.hide}/${t.priceHideRatio.show}` : '-';
    lines.push(`| ${i+1} | ${t.city} | ${kw} | ${status} ${t.status} | ${t.latency || '-'} | ${t.total || 0} | ${hide} |`);
  });
  lines.push('');
  lines.push(`### 详情接口详细结果`);
  lines.push('');
  lines.push(`| # | 酒店 | 状态 | 延迟(ms) | 房型 | 销售房 | 价格(隐藏/显示) | 来源 |`);
  lines.push(`|---|------|------|----------|------|--------|-----------------|------|`);
  r.detailTests.forEach((t, i) => {
    const status = t.ok ? '✅' : '❌';
    const hide = t.priceHideRatio ? `${t.priceHideRatio.hide}/${t.priceHideRatio.show}` : '-';
    const name = (t.hotelName || '').substring(0, 25);
    lines.push(`| ${i+1} | [${t.hotelId}] ${name} | ${status} ${t.status} | ${t.latency || '-'} | ${t.totalRoomTypes || 0} | ${t.totalSaleRooms || 0} | ${hide} | ${t.source || '-'} |`);
  });
  lines.push('');
  lines.push(`### 延迟统计`);
  lines.push('');
  const searchLat = r.searchTests.filter(t => t.ok).map(t => t.latency);
  const detailLat = r.detailTests.filter(t => t.ok).map(t => t.latency);
  lines.push(`| 接口 | 平均 | 最小 | 最大 |`);
  lines.push(`|------|------|------|------|`);
  if (searchLat.length > 0) {
    lines.push(`| 搜索 | ${(searchLat.reduce((a,b)=>a+b,0)/searchLat.length).toFixed(0)}ms | ${Math.min(...searchLat)}ms | ${Math.max(...searchLat)}ms |`);
  }
  if (detailLat.length > 0) {
    lines.push(`| 详情 | ${(detailLat.reduce((a,b)=>a+b,0)/detailLat.length).toFixed(0)}ms | ${Math.min(...detailLat)}ms | ${Math.max(...detailLat)}ms |`);
  }
  lines.push('');
  lines.push(`## 反爬说明`);
  lines.push('');
  lines.push(`- **价格字段**: 当前全部被 WhaleGuard 风控层隐藏（显示为 null 或 "?"），这是正常行为，需要可信会话（真实浏览器 / 付费住宅代理）才能解锁`);
  lines.push(`- **搜索接口**: 走移动端 SSR 路径（Node https 直调 m.ctrip.com），不依赖 Playwright，速度快稳定性好`);
  lines.push(`- **详情接口**: 走 PC 端 Playwright XHR 拦截路径（soa2/33278），每次请求启动浏览器，较慢但数据完整`);
  lines.push('');

  return lines.join('\n');
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
