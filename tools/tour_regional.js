// 지역 축제 사이트 4곳 파서 (내장 https만 사용)
'use strict';
const https = require('https'), zlib = require('zlib');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 사이트별 요청기: 300ms 간격, 최대 15회, 쿠키 유지, 리다이렉트·gzip 처리
function client() {
  let n = 0, last = 0, cookie = {};
  async function get(url, redirects = 0) {
    if (++n > 15) throw new Error('요청 한도(15) 초과');
    const wait = last + 300 - Date.now(); if (wait > 0) await sleep(wait);
    last = Date.now();
    const ck = Object.entries(cookie).map(([k, v]) => k + '=' + v).join('; ');
    const res = await new Promise((resolve, reject) => {
      const req = https.get(url, { headers: Object.assign({ 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate', 'Accept': '*/*', 'Accept-Language': 'ko-KR,ko;q=0.9' }, ck ? { Cookie: ck } : {}), timeout: 30000 }, s => {
        const buf = []; s.on('data', c => buf.push(c)); s.on('end', () => resolve({ s, body: Buffer.concat(buf) }));
      });
      req.on('timeout', () => req.destroy(new Error('timeout 30s: ' + url)));
      req.on('error', reject);
    });
    const { s } = res;
    (s.headers['set-cookie'] || []).forEach(c => { const m = /^([^=;]+)=([^;]*)/.exec(c); if (m) cookie[m[1]] = m[2]; });
    if (s.statusCode >= 300 && s.statusCode < 400 && s.headers.location) {
      if (redirects >= 5) throw new Error('리다이렉트 과다: ' + url);
      n--; return get(new URL(s.headers.location, url).href, redirects + 1);
    }
    if (s.statusCode !== 200) throw new Error('HTTP ' + s.statusCode + ': ' + url);
    let b = res.body; const enc = s.headers['content-encoding'];
    if (enc === 'gzip') b = zlib.gunzipSync(b); else if (enc === 'deflate') b = zlib.inflateSync(b);
    return b.toString('utf8');
  }
  return get;
}

// HTML 엔티티·태그 제거
const txt = s => String(s || '').replace(/<[^>]*>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'")
  .replace(/&middot;/g, '·').replace(/&num;/g, '#').replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();
const p2 = v => String(v).padStart(2, '0');
const okDate = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === +y && t.getUTCMonth() === m - 1 && t.getUTCDate() === +d; };

// 기간 문자열 → [s,e] ('YYYY.MM.DD'), 끝 연도/월 생략 처리, 실패 시 null
function range(str, baseYear) {
  const parts = String(str).split(/~|∼|〜/).map(x => x.trim());
  const nums = x => (x.match(/\d+/g) || []).map(Number);
  const a = nums(parts[0]); if (!parts[0]) return null;
  let sy, sm, sd;
  if (a.length >= 3 && a[0] > 1900) [sy, sm, sd] = a;
  else if (a.length >= 2 && baseYear) { sy = baseYear; [sm, sd] = a; }
  else return null;
  let ey = sy, em = sm, ed = sd;
  if (parts[1]) {
    const b = nums(parts[1]);
    if (b.length >= 3 && b[0] > 1900) [ey, em, ed] = b;
    else if (b.length === 2) { [em, ed] = b; ey = em < sm ? sy + 1 : sy; }
    else if (b.length === 1) { ed = b[0]; }
    else return null;
  }
  if (!okDate(sy, sm, sd) || !okDate(ey, em, ed)) return null;
  const s = `${sy}.${p2(sm)}.${p2(sd)}`, e = `${ey}.${p2(em)}.${p2(ed)}`;
  return s <= e ? [s, e] : null;
}
const item = o => Object.assign({ n: '', a: '', s: '', e: '', i: '', h: '', t: '', x: 0, y: 0 }, o);

// 1) 경남축제다모아: 서버렌더 축제검색 목록(진행중·예정 먼저, 종료(festa__end)는 뒤) — 종료 항목이 나오는 페이지까지
async function gn(today) {
  const get = client(), B = 'https://festa.gyeongnam.go.kr', out = [];
  for (let page = 1; page <= 6; page++) {
    const html = await get(`${B}/index.do?menuCode=001_019001000000&nowPage=${page}`);
    const lis = html.split(/<li\b/).slice(1).filter(x => x.includes('srh_list_info'));
    if (!lis.length) { if (page === 1) throw new Error('gn: 목록 없음'); break; }
    let ended = false;
    for (const li of lis) {
      if (/^[^>]*festa__end/.test(li)) ended = true;
      const n = txt((/<strong class="ellipsis">([\s\S]*?)<\/strong>/.exec(li) || [])[1]);
      const area = txt((/<span class="area">([\s\S]*?)<\/span>/.exec(li) || [])[1]);
      const r = range(txt((/<div class="srh_list_info">[\s\S]*?<p>([\s\S]*?)<\/p>/.exec(li) || [])[1]));
      if (!n || !r) continue;
      const href = (/<a href="([^"]+)"/.exec(li) || [])[1], img = (/<img src="([^"]+)"/.exec(li) || [])[1];
      out.push(item({ n, a: ('경상남도 ' + area).trim(), s: r[0], e: r[1],
        i: img ? new URL(txt(img), B).href : '', h: href && !/^javascript/i.test(href) ? encodeURI(new URL(txt(href), B).href).replace(/%25/g, '%') : '' }));
    }
    if (ended) break;
  }
  if (!out.length) throw new Error('gn: 파싱 결과 0건');
  return out;
}

// 2) 충남 tour.chungnam: 축제 목록(list.do, 48개/페이지, 기간은 썸네일 alt에만 있음)
async function cn(today) {
  const get = client(), B = 'https://tour.chungnam.go.kr', L = B + '/prog/fstvl/kor/sub02_02_02/';
  const out = [], seen = new Set();
  let last = 1;
  for (let page = 1; page <= Math.min(last, 10); page++) {
    const html = await get(`${L}list.do?pageIndex=${page}&pageUnit=48`);
    if (page === 1) { const m = /program--division-line">[\s\S]*?\/\s*(\d+)/.exec(html); last = m ? +m[1] : 1; }
    const blocks = html.split('class="link button_view" data-key-no="').slice(1);
    if (!blocks.length) { if (page === 1) throw new Error('cn: 목록 없음'); break; }
    for (const b of blocks) {
      const no = (/^(\d+)/.exec(b) || [])[1]; if (!no || seen.has(no)) continue;
      const alt = txt((/<img [^>]*alt="([^"]*)"/.exec(b) || [])[1]);
      const dm = /(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/.exec(alt);
      const r = dm && range(dm[1] + '~' + dm[2]);
      const n = txt((/class="cb-title">([\s\S]*?)<\/strong>/.exec(b) || [])[1]);
      if (!n || !r) continue;
      seen.add(no);
      let a = txt((/class="cb-tit">[\s\S]*?<span>([\s\S]*?)<\/span>/.exec(b) || [])[1]);
      a = /^충(청)?남(도)?\s/.test(a) ? a.replace(/^충(청)?남(도)?\s/, '충청남도 ') : ('충청남도 ' + a).trim();
      const img = (/<img src="([^"]+)"/.exec(b) || [])[1];
      out.push(item({ n, a, s: r[0], e: r[1], i: img ? new URL(txt(img), B).href : '', h: `${L}view.do?fstvlNo=${no}` }));
    }
  }
  if (!out.length) throw new Error('cn: 파싱 결과 0건');
  return out;
}

// 3) 충북 tour.chungbuk: 연간축제일정 게시판(카드형 목록, 올해 + 다음 연도 선택지가 있으면)
async function cb(today) {
  const get = client(), B = 'https://tour.chungbuk.go.kr/www/', y0 = +String(today).slice(0, 4);
  const out = [], seen = new Set();
  let years = [y0];
  for (let i = 0; i < years.length; i++) {
    const y = years[i];
    const html = await get(`${B}selectBbsNttList.do?bbsNo=10&key=80&searchCtgry=${y}`);
    if (i === 0 && new RegExp(`<option value="${y0 + 1}"`).test(html)) years.push(y0 + 1);
    const cards = html.split('class="schdule_item').slice(1);
    if (!cards.length && y === y0) throw new Error('cb: 목록 없음');
    for (const c of cards) {
      const href = (/<a href="([^"]+)"/.exec(c) || [])[1];
      const ntt = href && (/nttNo=(\d+)/.exec(href) || [])[1];
      const n = txt(((/<div class="title">([\s\S]*?)<\/div>/.exec(c) || [])[1] || '').replace(/<span class="p-icon[\s\S]*?<\/span>/g, ''));
      const r = range(txt((/<div class="date">([\s\S]*?)<\/div>/.exec(c) || [])[1]), y);
      if (!n || !r || (ntt && seen.has(ntt))) continue;
      if (ntt) seen.add(ntt);
      const sg = txt((/class="place_mark[^"]*">([\s\S]*?)<\/span>/.exec(c) || [])[1]);
      const img = (/background-image:url\('([^']+)'\)/.exec(c) || [])[1];
      out.push(item({ n, a: sg && !/충청북도|충북/.test(sg) ? '충청북도 ' + sg : '충청북도', s: r[0], e: r[1],
        i: img ? new URL(txt(img), B).href : '',
        h: ntt ? `${B}selectBbsNttView.do?key=80&bbsNo=10&nttNo=${ntt}&searchCtgry=${y}` : '' }));
    }
  }
  if (!out.length) throw new Error('cb: 파싱 결과 0건');
  return out;
}

// 4) 경기 ggtour: 월별 JSON API(이번 달부터 3개월, size=100로 1회씩), cotId로 중복 제거
const GG_SGG = { 6: '여주시', 7: '이천시', 8: '광주시', 9: '오산시', 10: '수원시', 11: '용인시', 12: '안성시', 13: '평택시', 14: '화성시', 15: '안산시', 16: '시흥시', 17: '남양주시', 18: '양평군', 19: '가평군', 20: '포천시', 21: '광명시', 22: '부천시', 23: '안양시', 24: '군포시', 25: '의왕시', 26: '과천시', 27: '성남시', 28: '하남시', 29: '구리시', 30: '고양시', 31: '의정부시', 32: '양주시', 33: '김포시', 34: '파주시', 35: '연천군', 36: '동두천시' };
async function gg(today) {
  const get = client(), B = 'https://ggtour.or.kr', m0 = +String(today).slice(4, 6);
  const out = [], seen = new Set();
  for (let k = 0; k < 3; k++) {
    const month = (m0 - 1 + k) % 12 + 1;
    const j = JSON.parse(await get(`${B}/api/v1/travel-info/festival?month=${month}&page=0&size=100`));
    const items = j && j.data && j.data.items;
    if (!Array.isArray(items)) throw new Error('gg: 응답 형식 변경 (month=' + month + ')');
    for (const o of items) {
      const id = o.cotId || o.contentId || o.title, f = o.additionalFestivalMo || {};
      if (seen.has(id)) continue;
      const r = /^\d{8}$/.test(f.eventStartDate || '') && /^\d{8}$/.test(f.eventEndDate || '')
        ? range(f.eventStartDate.replace(/(\d{4})(\d\d)(\d\d)/, '$1.$2.$3') + '~' + f.eventEndDate.replace(/(\d{4})(\d\d)(\d\d)/, '$1.$2.$3')) : null;
      if (!o.title || !r) continue;
      seen.add(id);
      const place = txt(f.eventPlace).replace(/^경기(도)?\s*/, '');
      const c = o.coordinate || {}, x = +(c.mapX || c.longitude) || 0, y = +(c.mapY || c.latitude) || 0;
      const img = o.image ? new URL(o.image, 'https://image.ggtour.or.kr').href : (o.imageUrl || '');
      out.push(item({ n: txt(o.title), a: ['경기도', GG_SGG[o.sgg] || '', place].filter(Boolean).join(' '), s: r[0], e: r[1],
        i: img, h: o.cotId ? `${B}/travel-info/festival/${o.cotId}` : '', x, y }));
    }
  }
  if (!out.length) throw new Error('gg: 파싱 결과 0건');
  return out;
}

module.exports = { gn, cn, cb, gg };

// 자체 테스트: node regional_parsers.js [YYYYMMDD]
if (require.main === module) {
  (async () => {
    const k = new Date(Date.now() + 9 * 3600e3), today = process.argv[2] || `${k.getUTCFullYear()}${p2(k.getUTCMonth() + 1)}${p2(k.getUTCDate())}`;
    const td = today.replace(/(\d{4})(\d\d)(\d\d)/, '$1.$2.$3');
    for (const [name, fn] of Object.entries(module.exports)) {
      try {
        const t0 = Date.now(), list = await fn(today);
        const live = list.filter(o => o.e >= td);
        console.log(`\n[${name}] 전체 ${list.length}건, 진행중+예정 ${live.length}건 (${Date.now() - t0}ms)`);
        live.slice(0, 3).forEach(o => console.log(JSON.stringify(o)));
      } catch (e) { console.log(`\n[${name}] 실패: ${e.message}`); }
    }
  })();
}
