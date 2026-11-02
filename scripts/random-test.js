// 携程 API 随机测试脚本 — 适配 v0.3.0 统一响应格式 {code, msg, data}
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
console.log('║          携程 API v0.3.0 随机测试                          ║');
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
  console.log('  阶段 1: 搜索接口测试 /api/ctrip/search');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const searchResults = [];

  for (const city of TEST_CITIES) {
    // 测试 1: 纯城市（不带 keyword）
    report.summary.searchTotal++;
    const url1 = `${API_BASE}/api/ctrip/search?city=${encodeURIComponent(city)}&checkin=${CHECKIN}&checkout=${CHECKOUT}`;
    console.log(`🔍 ${city} (无 keyword)`);

    try {
      const { status, latency, json } = await httpGet(url1);
      const data = json.data || {};
      const hotels = data.hotels || [];
      const ok = status === 200 && json.code === 0 && Array.isArray(hotels) && hotels.length > 0;
      const result = {
        city, keyword: null, checkin: CHECKIN, checkout: CHECKOUT,
        status, latency, ok,
        total: data.total || hotels.length,
        ssrTotal: data.ssrTotal || null,
        filteredByKeyword: data.filteredByKeyword || false,
        priceHideRatio: data.priceHideRatio,
        error: json.code !== 0 ? json.msg : null,
      };
      report.searchTests.push(result);
      searchResults.push({ city, keyword: null, hotels });

      if (ok) {
        report.summary.searchPassed++;
        const hide = data.priceHideRatio;
        console.log(`   ✅ PASS [${status}] ${latency}ms → ${result.total} 家 (hide ${hide?.hide || '?'}/${hide?.show || '?'})`);
      } else {
        report.summary.searchFailed++;
        console.log(`   ❌ FAIL [${status}] ${latency}ms → ${json.msg || 'no hotels'}`);
      }
    } catch (e) {
      report.summary.searchFailed++;
      report.searchTests.push({ city, keyword: null, ok: false, error: e.message });
      console.log(`   ❌ ERROR ${e.message}`);
    }
  }

  // 测试 2: 城市 + keyword（配对测试）
  for (let i = 0; i < Math.min(TEST_CITIES.length, TEST_KEYWORDS.length); i++) {
    const city = TEST_CITIES[i];
    const keyword = TEST_KEYWORDS[i];
    report.summary.searchTotal++;
    const url = `${API_BASE}/api/ctrip/search?city=${encodeURIComponent(city)}&checkin=${CHECKIN}&checkout=${CHECKOUT}&keyword=${encodeURIComponent(keyword)}`;
    console.log(`🔍 ${city} + keyword="${keyword}"`);

    try {
      const { status, latency, json } = await httpGet(url);
      const data = json.data || {};
      const hotels = data.hotels || [];
      const ok = status === 200 && json.code === 0 && Array.isArray(hotels);
      const result = {
        city, keyword, checkin: CHECKIN, checkout: CHECKOUT,
        status, latency, ok,
        total: data.total || hotels.length,
        ssrTotal: data.ssrTotal || null,
        filteredByKeyword: data.filteredByKeyword || false,
        priceHideRatio: data.priceHideRatio,
        error: json.code !== 0 ? json.msg : null,
      };
      report.searchTests.push(result);
      searchResults.push({ city, keyword, hotels });

      if (ok) {
        report.summary.searchPassed++;
        const matched = hotels.filter(h => h.hotelName?.includes(keyword)).length;
        const ratio = data.ssrTotal ? ` SSR ${data.ssrTotal}→${result.total}` : '';
        console.log(`   ✅ PASS [${status}] ${latency}ms → ${result.total} 家${ratio} (名称匹配 "${keyword}": ${matched})`);
      } else {
        report.summary.searchFailed++;
        console.log(`   ❌ FAIL [${status}] ${latency}ms → ${json.msg}`);
      }
    } catch (e) {
      report.summary.searchFailed++;
      report.searchTests.push({ city, keyword, ok: false, error: e.message });
      console.log(`   ❌ ERROR ${e.message}`);
    }
  }

  // ---------- 阶段 2: 详情测试 ----------
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  阶段 2: 详情接口测试 /api/ctrip/detail');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

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
    console.log(`🏨 [${target.hotelId}] ${target.hotelName}`);

    try {
      const { status, latency, json } = await httpGet(url);
      const data = json.data || {};
      const rooms = data.rooms || [];
      const ok = status === 200 && json.code === 0 && Array.isArray(rooms) && rooms.length > 0;
      const result = {
        hotelId: target.hotelId, hotelName: target.hotelName, city: target.city,
        status, latency, ok,
        totalRoomTypes: data.totalRoomTypes,
        totalSaleRooms: data.totalSaleRooms,
        priceHideRatio: data.priceHideRatio,
        source: data.source,
        error: json.code !== 0 ? json.msg : null,
      };
      report.detailTests.push(result);

      if (ok) {
        report.summary.detailPassed++;
        const hide = data.priceHideRatio;
        console.log(`   ✅ PASS [${status}] ${latency}ms → ${data.totalRoomTypes} 房型 / ${data.totalSaleRooms} 销售房 (hide ${hide?.hide || '?'}/${hide?.show || '?'})`);
      } else {
        report.summary.detailFailed++;
        console.log(`   ❌ FAIL [${status}] ${latency}ms → ${json.msg || 'no rooms'}`);
      }
    } catch (e) {
      report.summary.detailFailed++;
      report.detailTests.push({ hotelId: target.hotelId, ok: false, error: e.message });
      console.log(`   ❌ ERROR ${e.message}`);
    }
  }

  // ---------- 阶段 3: 汇总 ----------
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  阶段 3: 测试汇总');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const s = report.summary;
  const sr = s.searchTotal > 0 ? (s.searchPassed / s.searchTotal * 100).toFixed(1) : '0';
  const dr = s.detailTotal > 0 ? (s.detailPassed / s.detailTotal * 100).toFixed(1) : '0';
  const tr = ((s.searchPassed + s.detailPassed) / (s.searchTotal + s.detailTotal) * 100).toFixed(1);

  console.log(`  📊 搜索: ${s.searchPassed}/${s.searchTotal} (${sr}%)`);
  console.log(`  📊 详情: ${s.detailPassed}/${s.detailTotal} (${dr}%)`);
  console.log(`  📊 总计: ${s.searchPassed + s.detailPassed}/${s.searchTotal + s.detailTotal} (${tr}%)\n`);

  // 价格隐藏统计
  const searchOk = report.searchTests.filter(t => t.ok);
  const searchAllHidden = searchOk.filter(t => t.priceHideRatio && t.priceHideRatio.show === 0).length;
  const detailOk = report.detailTests.filter(t => t.ok);
  const detailAllHidden = detailOk.filter(t => t.priceHideRatio && t.priceHideRatio.show === 0).length;
  console.log(`  💰 搜索价格全隐藏: ${searchAllHidden}/${searchOk.length}`);
  console.log(`  💰 详情价格全隐藏: ${detailAllHidden}/${detailOk.length}\n`);

  // 延迟统计
  const searchLatencies = searchOk.map(t => t.latency);
  const detailLatencies = detailOk.map(t => t.latency);
  if (searchLatencies.length > 0) {
    const avg = Math.round(searchLatencies.reduce((a, b) => a + b, 0) / searchLatencies.length);
    console.log(`  ⏱ 搜索延迟: avg=${avg}ms min=${Math.min(...searchLatencies)}ms max=${Math.max(...searchLatencies)}ms`);
  }
  if (detailLatencies.length > 0) {
    const avg = Math.round(detailLatencies.reduce((a, b) => a + b, 0) / detailLatencies.length);
    console.log(`  ⏱ 详情延迟: avg=${avg}ms min=${Math.min(...detailLatencies)}ms max=${Math.max(...detailLatencies)}ms`);
  }

  // 保存报告
  const jsonPath = path.join(REPORT_OUT, 'test-report.json');
  fs.mkdirSync(REPORT_OUT, { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(`\n💾 JSON: ${jsonPath}`);

  const mdPath = path.join(REPORT_OUT, 'test-report.md');
  fs.writeFileSync(mdPath, generateMarkdown(report));
  console.log(`💾 Markdown: ${mdPath}`);

  return report;
}

function generateMarkdown(r) {
  const s = r.summary;
  const lines = [];
  lines.push(`# 携程 API v0.3.0 随机测试报告`);
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
  lines.push(`### 搜索详细结果`);
  lines.push('');
  lines.push(`| # | 城市 | 关键字 | 状态 | 延迟(ms) | 酒店数 | SSR总数 | 过滤 | 价格(隐藏/显示) |`);
  lines.push(`|---|------|--------|------|----------|--------|---------|------|-----------------|`);
  r.searchTests.forEach((t, i) => {
    const status = t.ok ? '✅' : '❌';
    const kw = t.keyword || '(无)';
    const hide = t.priceHideRatio ? `${t.priceHideRatio.hide}/${t.priceHideRatio.show}` : '-';
    const ssr = t.ssrTotal || '-';
    const flt = t.filteredByKeyword ? '🔍' : '';
    lines.push(`| ${i+1} | ${t.city} | ${kw} | ${status} ${t.status} | ${t.latency || '-'} | ${t.total || 0} | ${ssr} | ${flt} | ${hide} |`);
  });
  lines.push('');
  lines.push(`### 详情详细结果`);
  lines.push('');
  lines.push(`| # | 酒店 | 状态 | 延迟(ms) | 房型 | 销售房 | 价格(隐藏/显示) | 来源 |`);
  lines.push(`|---|------|------|----------|------|--------|-----------------|------|`);
  r.detailTests.forEach((t, i) => {
    const status = t.ok ? '✅' : '❌';
    const hide = t.priceHideRatio ? `${t.priceHideRatio.hide}/${t.priceHideRatio.show}` : '-';
    const name = (t.hotelName || '').substring(0, 30);
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
    lines.push(`| 搜索 | ${Math.round(searchLat.reduce((a,b)=>a+b,0)/searchLat.length)}ms | ${Math.min(...searchLat)}ms | ${Math.max(...searchLat)}ms |`);
  }
  if (detailLat.length > 0) {
    lines.push(`| 详情 | ${Math.round(detailLat.reduce((a,b)=>a+b,0)/detailLat.length)}ms | ${Math.min(...detailLat)}ms | ${Math.max(...detailLat)}ms |`);
  }
  lines.push('');
  lines.push(`### 价格层反爬说明`);
  lines.push('');
  lines.push(`- **价格字段**: WhaleGuard 风控层根据会话信誉决定是否返回价格；匿名采集全部被隐藏（show=0），属正常行为`);
  lines.push(`- **搜索接口**: 移动端 SSR 路径（Node https），不依赖 Playwright，速度快稳定性好。SSR 预渲染固定约 13 家酒店，关键字在客户端过滤`);
  lines.push(`- **详情接口**: PC 端 Playwright XHR 拦截路径（soa2/33278），每次启动浏览器约 13s，完整房型数据`);
  lines.push('');

  return lines.join('\n');
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
