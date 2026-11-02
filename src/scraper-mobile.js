// 携程搜索 —— 移动端 SSR 解析版 ✅ 可用！
//
// 🎯 核心发现（2026-10-30 逆向）：
//   PC 端 hotels.ctrip.com 的 WhaleGuard 风控会拦截无信誉会话（430 whaleguard block）
//   但移动端 m.ctrip.com 的酒店列表页通过 SSR 预渲染，HTML 里直接内嵌了 Next.js __NEXT_DATA__
//   所以 Node https 直调就能拿到完整酒店列表数据！
//
// 数据路径：
//   HTML → <script id="__NEXT_DATA__"> → props.pageProps.initialState.ssrVM.listStatus.normalHotelCardList
//
// 酒店卡片字段：
//   hotelId       → baseInfo.hotelId
//   hotelName     → baseUIInfo.name.hotelName
//   score         → baseUIInfo.commentInfo.score
//   star          → baseUIInfo.hotelStar.star
//   address       → detailInfo.detailHeadInfo.hotelPositionInfo.address
//   distance      → baseUIInfo.distanceAndPosition.distanceAndPosition
//   imageUrl      → imageInfo.mediaList[0].imageUrl
//   price         → priceInfo.price = "?" （⚠️ 价格层反爬，和 PC 端一致）
//
// ⚠️ 限制：priceInfo.price/originalPrice 都是 "?"，需要可信会话才能解锁价格

const https = require('https');
const { URL } = require('url');
const CONFIG = require('./config');

// ---------- UA 随机化 ----------
function pickUA() {
  const list = CONFIG.mobileUserAgents;
  return list[Math.floor(Math.random() * list.length)];
}

// 从 HTML 中提取最大的含 hotelName 的 JSON blob（平衡括号法）
function extractBiggestJson(html, keyword = 'hotelName') {
  let best = null;
  let idx = 0;
  while (true) {
    const pos = html.indexOf('{', idx);
    if (pos === -1) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = pos; i < html.length; i++) {
      const ch = html[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\' && inStr) { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (!inStr) {
        if (ch === '{') depth++;
        if (ch === '}') {
          depth--;
          if (depth === 0) {
            const blob = html.substring(pos, i + 1);
            if ((!best || blob.length > best.length) && blob.includes(keyword)) {
              best = blob;
            }
            idx = i + 1;
            break;
          }
        }
      }
    }
    if (depth > 0) break;
  }
  return best;
}

// Node https GET (支持 302 跟随 + 随机 UA + 硬超时)
function httpsGet(targetUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
    const parsed = new URL(targetUrl);
    const req = https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      timeout: CONFIG.timeout.searchRequestMs,
      headers: {
        'User-Agent': pickUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': CONFIG.acceptLanguage,
        'Accept-Encoding': 'identity', // 不压缩，简化处理
        'Cache-Control': 'no-cache',
        'Upgrade-Insecure-Requests': '1',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        req.destroy();
        return resolve(httpsGet(new URL(res.headers.location, targetUrl).href, redirectCount + 1));
      }
      if (res.statusCode >= 400) {
        let errBody = '';
        res.on('data', c => errBody += c);
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errBody.substring(0, 200)}`)));
        return;
      }
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.on('timeout', function () {
      this.destroy();
      reject(new Error(`请求超时（${CONFIG.timeout.searchRequestMs}ms）`));
    });
  });
}

// 构建移动端搜索 URL
function buildMobileSearchUrl({ cityId, checkin, checkout, keyword }) {
  const params = new URLSearchParams();
  params.set('cityId', String(cityId));
  params.set('checkin', checkin);
  params.set('checkout', checkout);
  if (keyword) params.set('keyword', keyword);
  return `https://m.ctrip.com/webapp/hotels/list?${params.toString()}`;
}

// 从 SSR 数据里提取酒店列表
function parseHotelsFromSSR(nextData) {
  try {
    const ssrVM = nextData?.props?.pageProps?.initialState?.ssrVM;
    if (!ssrVM) return null;

    const cards = ssrVM.listStatus?.normalHotelCardList
      || ssrVM.listStatus?.curNormalHotelCardList;
    if (!cards || !Array.isArray(cards)) return null;

    return cards.map((card) => {
      const baseInfo = card.baseInfo || {};
      const ui = card.baseUIInfo || {};
      const nameInfo = ui.name || {};
      const commentInfo = ui.commentInfo || {};
      const starInfo = ui.hotelStar || {};
      const distanceInfo = ui.distanceAndPosition || {};
      const positionInfo = card.detailInfo?.detailHeadInfo?.hotelPositionInfo || {};
      const imageList = card.imageInfo?.mediaList || [];
      const priceInfo = card.priceInfo || {};
      const hotelId = baseInfo.hotelId || baseInfo.masterHotelId || card.mapInfo?.id;

      return {
        hotelId: hotelId ? Number(hotelId) : null,
        hotelName: nameInfo.hotelName || null,
        starRating: starInfo.star ?? null,
        score: commentInfo.score ? Number(commentInfo.score) : null,
        scoreLevel: commentInfo.scoreLevelDesc || null,
        commentCount: commentInfo.commentCountDesc || null,
        collectCount: commentInfo.collectCountDesc || null,
        distance: distanceInfo.distanceAndPosition || null,
        address: positionInfo.address || null,
        latitude: card.mapInfo?.position?.lat ?? null,
        longitude: card.mapInfo?.position?.lng ?? null,
        cityId: baseInfo.hotelCoordinate?.cityId ?? null,
        provinceName: baseInfo.hotelCoordinate?.provinceName || null,
        imageUrl: imageList[0]?.imageUrl || null,
        tags: (card.tagInfo?.serviceTagList || []).map(t => t.title).filter(Boolean),
        adHotel: !!baseInfo.isAdHotel,
        isBookable: baseInfo.isBookable !== false,
        price: (priceInfo.price !== '?' && priceInfo.price != null) ? priceInfo.price : null,
        originalPrice: (priceInfo.originalPrice !== '?' && priceInfo.originalPrice != null) ? priceInfo.originalPrice : null,
        isPriceHidden: priceInfo.price === '?',
        traceInfo: card.traceInfoModel ? {
          roomId: card.traceInfoModel.roomId,
          verifyToken: card.verifyToken,
        } : null,
      };
    });
  } catch (e) {
    console.warn('[parseSSR] 解析失败:', e.message);
    return null;
  }
}

// 主入口：搜索酒店
async function searchHotelsSSR({ cityId, checkin, checkout, keyword }) {
  const resolvedCityId = typeof cityId === 'string' && /^\d+$/.test(cityId)
    ? parseInt(cityId, 10)
    : cityId;

  const url = buildMobileSearchUrl({ cityId: resolvedCityId, checkin, checkout, keyword });

  const resp = await httpsGet(url);
  console.log('[search] 📄 HTML:', resp.body.length, 'bytes, status=', resp.status);

  // 检查是否被跳登录
  if (resp.headers.location?.includes('passport')) {
    throw new Error('移动端也被跳登录（罕见！可能需要更换 IP 或等待）');
  }

  // 提取 Next.js __NEXT_DATA__ JSON
  const jsonBlob = extractBiggestJson(resp.body, 'hotelName');
  if (!jsonBlob) {
    throw new Error('HTML 里没找到酒店数据（HTML 长度: ' + resp.body.length + '）');
  }
  console.log('[search] 🧩 SSR JSON:', jsonBlob.length, 'bytes');

  const nextData = JSON.parse(jsonBlob);
  const hotels = parseHotelsFromSSR(nextData);

  if (!hotels || hotels.length === 0) {
    throw new Error('SSR 里没有酒店列表');
  }

  const hiddenCount = hotels.filter(h => h.isPriceHidden).length;

  return {
    source: 'mobile-ssr',
    url,
    total: hotels.length,
    isPriceHidden: hiddenCount === hotels.length,
    priceHideRatio: { hide: hiddenCount, show: hotels.length - hiddenCount },
    keyword: keyword || null,
    cityId: resolvedCityId,
    checkin,
    checkout,
    hotels,
    _note: '价格字段由 WhaleGuard 风控层决定；全部为 null 时说明需要可信会话才能看到价格',
  };
}

module.exports = {
  searchHotelsSSR,
  buildMobileSearchUrl,
  parseHotelsFromSSR,
  extractBiggestJson,
  httpsGet,
};
