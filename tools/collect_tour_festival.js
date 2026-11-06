// 여행끝판왕 '이달의 축제' 수집 → tour/festival.json
//  · 기본: 한국관광공사 TourAPI(KorService2/searchFestival2) 전국 진행중+다가오는 축제
//  · 보충(관광공사에 없는 것만, 같은 지역 안 이름 일치/포함이면 중복 처리): 이미지 있는 소스부터
//      gb 경북 tour.gb.go.kr 목록 JSON / dj 대전 daejeontour.co.kr 페이지 내장 calEvents
//      gw 강원 gangwon.to 목록 HTML / jb 전북 tour.jb.go.kr 목록 HTML(세션 쿠키)
//      vj 제주 VisitJeju 시드(tour/jeju_vj.json — 세션 토큰이 필요해 로컬 브라우저로 수집해 올림)
//      se 서울 열린데이터 문화행사(축제-*, env SEOUL_KEY) / bs 부산 data.go.kr 부산축제정보(기간 자유 텍스트 해석)
//      std 전국문화축제표준데이터(data.go.kr, 시군구 직접 등록, 이미지 없음)
//  · 소스별 격리: 보충 소스가 실패하면 이전 festival.json의 그 소스 항목(미종료분)을 이어 씀.
// GitHub Actions에서 실행(env DATAGO_KEY = data.go.kr 일반 인증키 decoding). 키는 출력에 절대 쓰지 않음.
// 지역(ar)은 앱 탭의 areaCode 체계. 관광공사는 lDongRegnCd, 나머지는 주소 시도명으로 매핑.
// 전남광주통합특별시는 자치구(동·서·남·북·광산구)면 광주, 아니면 전남.
// 안전장치: 관광공사 API 오류·결과 급감(이전 대비 50% 미만 또는 50건 미만)이면 실패 종료 → 기존 파일 유지.
// 사용: node tools/collect_tour_festival.js [--js <data_tour_festival.js 경로>]   (--js: 앱 번들용 var festData 파일도 생성)
'use strict';
const fs = require('fs');
const TL = require('./tour_lib');
const https = require('https');
const http = require('http');
const tls = require('tls');

const KEY = process.env.DATAGO_KEY;
const OUT = 'tour/festival.json';
const JEJU = 'tour/jeju_vj.json';
const BASE = 'https://apis.data.go.kr/B551011/KorService2/searchFestival2';
const STD = 'https://api.data.go.kr/openapi/tn_pubr_public_cltur_fstvl_api';
const ROWS = 500;

if (!KEY) { console.error('DATAGO_KEY 미설정'); process.exit(1); }

const GJ = ['동구', '서구', '남구', '북구', '광산구'];
const CODE = { '11': 1, '28': 2, '30': 3, '27': 4, '29': 5, '26': 6, '31': 7,
  '41': 31, '42': 32, '51': 32, '43': 33, '44': 34, '47': 35,
  '48': 36, '45': 37, '52': 37, '46': 38, '50': 39 };
const SIDO = [[/^서울/, 1], [/^인천/, 2], [/^대전/, 3], [/^대구/, 4], [/^광주/, 5], [/^부산/, 6], [/^울산/, 7], [/^세종/, 8],
  [/^경기/, 31], [/^강원/, 32], [/^충청북도|^충북/, 33], [/^충청남도|^충남/, 34], [/^경상북도|^경북/, 35], [/^경상남도|^경남/, 36],
  [/^전라북도|^전북/, 37], [/^전라남도|^전남(?!광주)/, 38], [/^제주/, 39]];

function areaOf(f) {
  const c = String(f.lDongRegnCd || '');
  if (c === '12') return GJ.includes((f.addr1 || '').split(' ')[1] || '') ? 5 : 38;
  if (c.startsWith('36')) return 8;
  return CODE[c] || 0;
}
function areaOfAddr(a) {
  const p = String(a || '').trim().split(/\s+/);
  if (/^전남광주/.test(p[0] || '')) return GJ.includes(p[1] || '') ? 5 : 38;
  for (const [re, ar] of SIDO) if (re.test(p[0] || '')) return ar;
  return 0;
}
const fmt = d => (d = String(d || ''), d.length === 8 ? d.slice(0, 4) + '.' + d.slice(4, 6) + '.' + d.slice(6, 8) : d);
const dash = d => String(d || '').trim().replace(/-/g, '.').slice(0, 10);   // 2026-11-06 → 2026.11.06
const norm = s => String(s || '').replace(/\d+/g, '').replace(/[^가-힣a-zA-Z]/g, '').toLowerCase();
const unent = s => String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = s => { let h = 5381; for (const c of String(s)) h = ((h * 33) ^ c.codePointAt(0)) >>> 0; return h.toString(36); };

function kstToday() {
  const t = new Date(Date.now() + 9 * 3600e3);
  return t.toISOString().slice(0, 10).replace(/-/g, '');
}

// GET/POST (리다이렉트 3회까지, 쿠키 jar 선택)
function req(url, opt = {}, hop = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = Object.assign({ 'Accept': opt.accept || '*/*' }, opt.headers || {});
    if (opt.jar && opt.jar.length) headers.Cookie = opt.jar.join('; ');
    if (opt.body) { headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'; headers['Content-Length'] = Buffer.byteLength(opt.body); }
    const ro = { method: opt.body ? 'POST' : 'GET', headers, timeout: 60000 };
    if (opt.ca) ro.ca = opt.ca;
    const r = (u.protocol === 'http:' ? http : https).request(u, ro, res => {
      if (opt.jar) for (const c of res.headers['set-cookie'] || []) opt.jar.push(c.split(';')[0]);
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hop < 3) {
        res.resume(); return resolve(req(new URL(res.headers.location, u).href, Object.assign({}, opt, { body: null }), hop + 1));
      }
      const ch = []; res.on('data', c => ch.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') }));
    });
    r.on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
    if (opt.body) r.write(opt.body);
    r.end();
  });
}
async function ok(url, opt) {
  const r = await req(url, opt);
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  return r.body;
}

async function fetchAll(today) {
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const q = new URLSearchParams({ serviceKey: KEY, MobileOS: 'ETC', MobileApp: 'yogurt', _type: 'json',
      arrange: 'A', numOfRows: String(ROWS), pageNo: String(page), eventStartDate: today });
    const body = await ok(BASE + '?' + q, { accept: 'application/json' });
    let d;
    try { d = JSON.parse(body); } catch (e) { throw new Error('JSON 아님: ' + body.slice(0, 80).replace(/\s+/g, ' ')); }
    const h = d.response && d.response.header;
    if (!h || h.resultCode !== '0000') throw new Error('resultCode ' + (h && h.resultCode) + ' ' + (h && h.resultMsg));
    const b = d.response.body, it = b.items && b.items.item;
    const arr = !it ? [] : Array.isArray(it) ? it : [it];
    rows.push(...arr);
    if (page * ROWS >= Number(b.totalCount || 0) || !arr.length) return { rows, total: Number(b.totalCount || 0) };
  }
  throw new Error('페이지 과다');
}

// 서버가 중간 인증서를 빠뜨린 사이트용: AIA(CA Issuers) 주소의 중간 인증서(DER)를 받아 신뢰 루트에 더함.
// 검증은 그대로 — 루트까지 체인이 이어지는지 Node가 확인한다.
function aiaCa(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 30000 }, res => {
      const ch = []; res.on('data', c => ch.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('AIA HTTP ' + res.statusCode));
        const b64 = Buffer.concat(ch).toString('base64').match(/.{1,64}/g).join('\n');
        resolve([...tls.rootCertificates, '-----BEGIN CERTIFICATE-----\n' + b64 + '\n-----END CERTIFICATE-----\n']);
      });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}
// 부산 기간 자유 텍스트 → [시작, 끝] ('2026. 5. 15. ~ 5. 24.', '2025년 11월 29일 ~ 2026년 1월 18일', '2026.04.17.~04.19.' 등)
// 시작은 연도 필수, 끝은 연도 생략 시 시작 연도(끝이 앞서면 다음 해). 해석 불가면 null.
function busanPeriod(t) {
  const txt = String(t || '').split('\n')[0];
  const [a, b] = txt.split('~');
  const full = /(\d{4})\s*[.년]\s*(\d{1,2})\s*[.월]\s*(\d{1,2})/;
  const m = (a || '').match(full);
  if (!m) return null;
  const p2 = n => String(n).padStart(2, '0');
  const s = m[1] + '.' + p2(m[2]) + '.' + p2(m[3]);
  let e = s;
  if (b) {
    const f = b.match(full), md = b.match(/(\d{1,2})\s*[.월]\s*(\d{1,2})/);
    if (f) e = f[1] + '.' + p2(f[2]) + '.' + p2(f[3]);
    else if (md) { e = m[1] + '.' + p2(md[1]) + '.' + p2(md[2]); if (e < s) e = (Number(m[1]) + 1) + e.slice(4); }
  }
  return [s, e];
}
const GW_AIA ='http://crt.sectigo.com/SectigoPublicServerAuthenticationCADVR36.crt';

// ── 보충 소스 ──────────────────────────────────────────────
const SOURCES = [
  { key: 'gb', fetch: async () => {   // 경북: 목록 JSON 한 번에 전체
    const d = JSON.parse(await ok('https://tour.gb.go.kr/travel/selectListAdd.do', { accept: 'application/json',
      body: 'start=0&end=2000&cd_catetop=03&cd_catemid=02&title=&search=&cd_area=&favority_month=' }));
    if (String(d.rcode) !== '1' || !Array.isArray(d.data)) throw new Error('rcode ' + d.rcode);
    return d.data.map(x => ({ n: unent(x.title), a: unent(x.addr_inf), ar: 35, s: dash(x.dt_start), e: dash(x.dt_end),
      i: x.file_physical ? 'https://tour.gb.go.kr/file/thumbnail2.do?file_physical=' + encodeURIComponent(x.file_physical) : '',
      t: unent(x.contact_no), x: TL.num(x.longtitude), y: TL.num(x.latitude), h: 'https://tour.gb.go.kr/travel/festivalView.do?idx=' + x.idx }));
  } },
  { key: 'dj', fetch: async () => {   // 대전: 페이지에 calEvents JSON 내장 (wr_9/wr_10 = 실제 기간, end는 달력용 +1일)
    const html = await ok('https://daejeontour.co.kr/festival_djt');
    const m = html.match(/calEvents\s*=\s*(\[[\s\S]*?\]);/);
    if (!m) throw new Error('calEvents 없음');
    return JSON.parse(m[1]).filter(x => (x.type || x.wr_3) === '축제').map(x => ({ n: unent(x.title || x.subject),
      a: '대전광역시 ' + unent(x.wr_8), ar: 3, s: dash(x.wr_9 || x.start), e: dash(x.wr_10 || x.end), i: x.thumb || '',
      t: unent(x.wr_2), h: x.href || '' }));
  } },
  { key: 'gw', fetch: async (today) => {   // 강원: 목록 HTML(GET ?pageIndex=, POST는 403), 등록 최신순 → 한 페이지가 전부 종료면 중단
    const out = [];
    let ca = null;
    for (let p = 1; p <= 12; p++) {
      const o = () => ({ ca });
      let html;
      try { html = await ok('https://www.gangwon.to/gwtour/now/festival?pageIndex=' + p, o()); }
      catch (e) {
        if (ca || !/certificate/.test(e.message)) throw e;
        ca = await aiaCa(GW_AIA); html = await ok('https://www.gangwon.to/gwtour/now/festival?pageIndex=' + p, o());
      }
      const blocks = html.split(/onclick="goPage\(\d+\); return false;">/).slice(1);
      if (!blocks.length) break;
      let live = 0;
      for (const b of blocks) {
        const n = unent((b.match(/<strong>([\s\S]*?)<\/strong>/) || [])[1]);
        const t = unent((b.match(/<time[^>]*>([\s\S]*?)<\/time>/) || [])[1]).split('~').map(s => dash(s));
        const a = unent((b.match(/<em>장소<\/em>([\s\S]*?)<\/span>/) || [])[1]);
        const im = (b.match(/<img src="([^"]+)"/) || [])[1] || '';
        if (!n || !t[0]) continue;
        const e = t[1] || t[0];
        if (e.replace(/\./g, '') >= today) live++;
        out.push({ n, a, ar: 32, s: t[0], e, i: im ? new URL(im, 'https://www.gangwon.to').href : '' });
      }
      if (!live && p >= 3) break;
      await sleep(400);
    }
    return out;
  } },
  { key: 'jb', fetch: async (today) => {   // 전북: 목록 HTML 40건/페이지, 세션 쿠키 필요, 기간 '2026.11.07~11.08'(끝 연도 생략)
    const jar = [], base = 'https://tour.jb.go.kr/travel/info/list.do?category_top_id=c&menuCd=DOM_000000110001000000&contentsSid=22';
    const out = [];
    for (let p = 1; p <= 6; p++) {
      const html = await ok(base + '&pageindex=' + p, { jar });
      const blocks = html.split('class="photoWrap"').slice(1);
      let live = 0;
      for (const b of blocks) {
        const n = unent((b.match(/<strong>([\s\S]*?)<\/strong>/) || [])[1]);
        const per = (b.match(/기간:\s*([0-9.]+)\s*~\s*([0-9.]*)/) || []);
        const city = unent((b.match(/list_best_badge">\s*<span>([^<]*)</) || [])[1]);
        const im = (b.match(/<img src="([^"]+)"/) || [])[1] || '';
        const lk = (b.match(/href="(\/travel\/info\/view\.do[^"]+)"/) || [])[1] || '';
        if (!n || !per[1]) continue;
        const s = per[1].slice(0, 10);
        let e = per[2] || s;
        if (/^\d{2}\.\d{2}$/.test(e)) {   // 끝 연도 생략 → 시작 연도, 시작보다 앞이면 다음 해
          e = s.slice(0, 4) + '.' + e;
          if (e < s) e = (Number(s.slice(0, 4)) + 1) + e.slice(4);
        }
        if (e.replace(/\./g, '') >= today) live++;
        out.push({ n, a: '전북특별자치도' + (city ? ' ' + city : ''), ar: 37, s, e, i: im ? new URL(im, 'https://tour.jb.go.kr').href : '',
          h: lk ? new URL(lk.replace(/&amp;/g, '&'), 'https://tour.jb.go.kr').href : '' });
      }
      if (blocks.length < 40 || (!live && p >= 2)) break;
      await sleep(400);
    }
    return out;
  } },
  { key: 'se', fetch: async (today) => {   // 서울: 열린데이터 문화행사(culturalEventInfo) 중 분류 '축제-*'. 최근 등록순 → 앞 페이지만
    const SK = process.env.SEOUL_KEY;
    if (!SK) throw new Error('SEOUL_KEY 미설정');
    const out = [];
    for (let p = 0; p < 6; p++) {
      const d = JSON.parse(await ok(`http://openapi.seoul.go.kr:8088/${encodeURIComponent(SK)}/json/culturalEventInfo/${p * 1000 + 1}/${p * 1000 + 1000}/`, { accept: 'application/json' }));
      const c = d.culturalEventInfo;
      if (!c || !Array.isArray(c.row)) throw new Error((d.RESULT && d.RESULT.CODE) || '응답 형식');
      let live = 0;
      for (const x of c.row) {
        if (!/^축제/.test(x.CODENAME || '')) continue;
        const s = dash(x.STRTDATE), e = dash(x.END_DATE);
        if (e.replace(/\./g, '') >= today) live++;
        out.push({ n: unent(x.TITLE), a: ('서울특별시 ' + unent(x.GUNAME) + ' ' + unent(x.PLACE)).trim(), ar: 1, s, e,
          i: String(x.MAIN_IMG || '').replace(/^http:\/\//, 'https://'), x: TL.num(x.LOT), y: TL.num(x.LAT), t: unent(x.INQUIRY),
          h: TL.https2(x.HMPG_ADDR || x.ORG_LINK), d: [x.USE_FEE && '요금: ' + unent(x.USE_FEE), x.PRO_TIME && '시간: ' + unent(x.PRO_TIME), unent(x.PROGRAM)].filter(Boolean).join('\n') });
      }
      if (c.row.length < 1000 || (!live && p >= 2)) break;
      await sleep(300);
    }
    return out;
  } },
  { key: 'bs', fetch: async () => {   // 부산: data.go.kr 부산축제정보(대표 축제 40여 개). 기간이 자유 텍스트라 해석
    const q = new URLSearchParams({ serviceKey: KEY, pageNo: '1', numOfRows: '300', resultType: 'json' });
    const d = JSON.parse(await ok('https://apis.data.go.kr/6260000/FestivalService/getFestivalKr?' + q, { accept: 'application/json' }));
    const g = d.getFestivalKr;
    if (!g || !g.header || g.header.code !== '00') throw new Error('code ' + (g && g.header && g.header.code));
    return (g.item || []).map(x => {
      const per = busanPeriod(x.USAGE_DAY_WEEK_AND_TIME);
      return per && { n: unent(String(x.MAIN_TITLE || '').replace(/\s*\([^)]*(한|영)[^)]*\)\s*(\/\/.*)?$/, '')),
        a: ('부산광역시 ' + unent(x.GUGUN_NM) + ' ' + unent(x.MAIN_PLACE || x.ADDR1)).trim(), ar: 6, s: per[0], e: per[1],
        i: String(x.MAIN_IMG_THUMB || x.MAIN_IMG_NORMAL || ''), t: unent(x.CNTCT_TEL), x: TL.num(x.LNG), y: TL.num(x.LAT),
        h: TL.https2(x.HOMEPAGE_URL), d: [unent(x.TITLE), unent(x.SUBTITLE)].filter(Boolean).join(' — ') };
    }).filter(Boolean);
  } },
  { key: 'vj', fetch: async () => {   // 제주: 로컬 수집 시드
    const d = JSON.parse(fs.readFileSync(JEJU, 'utf8'));
    return (d.data || []).map(x => Object.assign({}, x, { ar: 39 }));
  } },
  { key: 'std', fetch: async () => {   // 전국문화축제표준데이터(시군구 직접 등록, 이미지 없음)
    const rows = [];
    for (let p = 1; p <= 10; p++) {
      const q = new URLSearchParams({ serviceKey: KEY, pageNo: String(p), numOfRows: '1000', type: 'json' });
      const d = JSON.parse(await ok(STD + '?' + q, { accept: 'application/json' }));
      const r = d.response || d;
      if (!r.header || r.header.resultCode !== '00') throw new Error('resultCode ' + (r.header && r.header.resultCode));
      const it = r.body.items && r.body.items.item, arr = !it ? [] : Array.isArray(it) ? it : [it];
      rows.push(...arr);
      if (p * 1000 >= Number(r.body.totalCount || 0) || !arr.length) break;
    }
    return rows.map(x => { const a = unent(x.rdnmadr || x.lnmadr); return { n: unent(x.fstvlNm), a, ar: areaOfAddr(a),
      s: dash(x.fstvlStartDate), e: dash(x.fstvlEndDate), i: '', t: unent(x.phoneNumber), x: TL.num(x.longitude), y: TL.num(x.latitude),
      h: x.homepageUrl ? (/^https?:/.test(x.homepageUrl) ? '' : 'http://') + String(x.homepageUrl).trim() : '',
      d: [x.opar && '장소: ' + unent(x.opar).replace(/\+/g, ', '), x.fstvlCo && unent(x.fstvlCo).replace(/\+/g, ', ')].filter(Boolean).join('\n') }; })
      // '1월 1일~12월 31일' 연중 표기는 실제 일정이 아닌 자리값인 경우가 많아 제외
      .filter(x => !(/\.01\.01$/.test(x.s) && /\.12\.31$/.test(x.e)));
  } },
];

(async () => {
  const today = kstToday();
  const todayDot = fmt(today);
  const { rows, total } = await fetchAll(today);
  const kto = [];
  for (const f of rows) {
    const ar = areaOf(f);
    if (!ar) continue;
    if (String(f.eventenddate || '') < today) continue;
    kto.push({ n: String(f.title || '').trim(), a: String(f.addr1 || '').trim(), ar,
      s: fmt(f.eventstartdate), e: fmt(f.eventenddate),
      i: String(f.firstimage || f.firstimage2 || '').trim().replace(/^http:\/\//, 'https://'),
      id: String(f.contentid || ''), src: 'kto', t: String(f.tel || '').trim(), x: TL.num(f.mapx), y: TL.num(f.mapy), m: String(f.modifiedtime || '') });
  }

  let prevDoc = null;
  try { prevDoc = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { /* 최초 */ }
  const prev = prevDoc && prevDoc.data ? prevDoc.data.length : 0;

  // 관광공사 상세(소개·홈페이지·장소·시간·요금): 새 축제이거나 수정시각(m)이 바뀐 것만 다시 받음(실행당 최대 300건)
  const prevById = {};
  (prevDoc && prevDoc.data || []).forEach(x => { if (x.src === 'kto' && x.id) prevById[x.id] = x; });
  const keep = (it, pv) => { if (pv) { if (pv.d) it.d = pv.d; if (pv.h) it.h = pv.h; } };
  let dNew = 0, dFail = 0;
  const KOR = 'https://apis.data.go.kr/B551011/KorService2/';
  const clean = v => unent(String(v || '').replace(/<br\s*\/?>/gi, ' / ')).trim();
  for (const it of kto) {
    const pv = prevById[it.id];
    if (pv && pv.m === it.m && pv.dd) { keep(it, pv); it.dd = 1; continue; }
    if (dNew >= 300) { keep(it, pv); continue; }
    dNew++;
    try {
      const c = (await TL.tourApi(KOR, 'detailCommon2', { contentId: it.id }, KEY)).items[0] || {};
      const n = (await TL.tourApi(KOR, 'detailIntro2', { contentId: it.id, contentTypeId: '15' }, KEY)).items[0] || {};
      const ov = clean(c.overview);
      it.d = [n.eventplace && '장소: ' + clean(n.eventplace), n.playtime && '시간: ' + clean(n.playtime),
        n.usetimefestival && '요금: ' + clean(n.usetimefestival), ov.length > 700 ? ov.slice(0, 700) + '…' : ov].filter(Boolean).join('\n');
      const hp = String(c.homepage || n.eventhomepage || '');
      it.h = (hp.match(/href=["']([^"']+)/) || [])[1] || (hp.match(/https?:\/\/[^\s<"]+/) || [])[0] || '';
      if (!it.t && c.tel) it.t = String(c.tel).trim();
      it.dd = 1;   // 상세 수집 완료 표시
    } catch (e) { dFail++; keep(it, pv); }
    await sleep(120);
  }
  console.log(`관광공사 상세: 새로 ${dNew}건${dFail ? ', 실패 ' + dFail : ''}`);

  const out = kto.slice();
  const keys = {};   // ar → [정규화 이름]
  const addKey = x => { (keys[x.ar] = keys[x.ar] || []).push(norm(x.n)); };
  const isDup = x => {
    const k = norm(x.n); if (!k) return true;
    return (keys[x.ar] || []).some(o => o === k || (Math.min(o.length, k.length) >= 4 && (o.includes(k) || k.includes(o))));
  };
  out.forEach(addKey);
  const stat = {};
  for (const src of SOURCES) {
    let items, mode = 'ok';
    try { items = await src.fetch(today); if (!items.length) throw new Error('0건'); }
    catch (e) {
      mode = '실패(' + e.message + ') → 이전값';
      items = (prevDoc && prevDoc.data || []).filter(x => x.src === src.key);
    }
    let added = 0;
    for (const x of items) {
      if (!x.ar || !x.n || !/^\d{4}\.\d{2}\.\d{2}$/.test(x.e || '') || x.e < todayDot) continue;
      const y = { n: x.n, a: x.a || '', ar: x.ar, s: /^\d{4}\.\d{2}\.\d{2}$/.test(x.s || '') ? x.s : x.e, e: x.e, i: x.i || '', src: src.key };
      for (const f of ['t', 'd', 'h', 'x', 'y']) if (x[f]) y[f] = x[f];
      if (isDup(y)) continue;
      addKey(y); out.push(y); added++;
    }
    stat[src.key] = added;
    console.log(`보충 ${src.key}: ${mode}, 후보 ${items.length} → 추가 ${added}`);
  }

  // 사진 없는 보충 축제(주로 표준데이터): 관광공사에서 같은 이름·같은 지역의 축제(지난 회차 포함)를 찾아 대표 사진을 씀.
  // 이름은 연도·회차를 떼고 비교. 이전 실행에서 찾은 사진(또는 못 찾음 표시 ni)은 이어 써서 매일 다시 찾지 않음(주 1회 재시도).
  const prevImg = {};
  (prevDoc && prevDoc.data || []).forEach(x => { if (x.src !== 'kto') prevImg[x.src + '|' + x.n] = x; });
  const core = n => String(n).replace(/^\s*(\d{4}\s*(년)?|제\s*\d+\s*회)\s*/g, '').replace(/\s*\(.*?\)\s*/g, ' ').trim();
  const weekly = new Date(Date.now() + 9 * 3600e3).getUTCDay() === 1;
  let imgFound = 0, imgTried = 0;
  for (const x of out) {
    if (x.src === 'kto' || x.i) continue;
    const pv = prevImg[x.src + '|' + x.n];
    if (pv && pv.i) { x.i = pv.i; continue; }
    if (pv && pv.ni && !weekly) { x.ni = 1; continue; }
    if (imgTried >= 80) continue;
    imgTried++;
    try {
      const kw = core(x.n);
      const r = await TL.tourApi('https://apis.data.go.kr/B551011/KorService2/', 'searchKeyword2',
        { keyword: kw, contentTypeId: '15', numOfRows: '20', pageNo: '1', arrange: 'O' }, KEY);
      const k0 = norm(kw);
      const hit = r.items.filter(f => f.firstimage && areaOf(f) === x.ar).find(f => {
        const k1 = norm(core(f.title));
        return k1 && k0 && (k1 === k0 || (Math.min(k0.length, k1.length) >= 4 && (k1.includes(k0) || k0.includes(k1))));
      });
      if (hit) { x.i = TL.https2(hit.firstimage); imgFound++; } else x.ni = 1;
    } catch (e) { /* 다음 실행에 재시도 */ }
    await sleep(120);
  }
  console.log(`사진 보충: 새로 검색 ${imgTried}건 → 찾음 ${imgFound}건, 사진 없음 ${out.filter(x => !x.i).length}건`);
  // 그래도 없으면 위키백과 → 네이버 이미지 검색(키 있을 때). 찾은 사진(ix)은 다음 실행에 이어 씀
  {
    const pk = {};
    (prevDoc && prevDoc.data || []).forEach(x => { pk[x.src + '|' + x.n] = x; });
    out.forEach(x => { if (x.ni && !x.i) delete x.ni; });   // 위 관광공사 검색의 ni는 여기 판단과 별개
    const st = await TL.fillImages(out.filter(x => x.src !== 'kto'), pk, x => x.src + '|' + x.n,
      { wiki: true, budget: { left: 150 }, naverQuery: x => core(x.n) + ' ' + TL.sigungu(x.a) });
    console.log(`외부 사진: 이어씀 ${st.carried}, 새로 시도 ${st.tried} → 위키 ${st.wiki} · 네이버 ${st.naver}, 사진 없음 ${out.filter(x => !x.i).length}건`);
  }

  out.sort((p, q) => (p.s < q.s ? -1 : p.s > q.s ? 1 : p.n < q.n ? -1 : p.n > q.n ? 1 : 0));

  // 급감 방지: 이전 파일 대비 절반 미만 또는 절대 50건 미만이면 실패
  if (out.length < 50 || (prev && out.length < prev * 0.5)) {
    console.error(`결과 급감(이번 ${out.length}, 이전 ${prev}) — 기존 파일 유지`); process.exit(1);
  }

  for (const x of out) {
    x.w = TL.wxCode(x.a);
    x.k = x.id ? 'k' + x.id : 'h' + hash(x.n + '|' + x.s);   // 찜 키
    for (const f of Object.keys(x)) if (x[f] === '' || x[f] === 0 || x[f] === undefined) delete x[f];
  }
  const per = {};
  out.forEach(x => { per[x.ar] = (per[x.ar] || 0) + 1; });
  const doc = { updated: todayDot, dateKey: today, src: Object.assign({ kto: kto.length }, stat), data: out };
  fs.mkdirSync('tour', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc));
  console.log(`API total ${total} → 관광공사 ${kto.length} + 보충 ${out.length - kto.length} = ${out.length}`, JSON.stringify(per));

  const ji = process.argv.indexOf('--js');
  if (ji > 0 && process.argv[ji + 1]) {
    const body = '// 이달의 축제 (관광공사 TourAPI + 지역 관광사이트·VisitJeju·전국문화축제표준데이터 보충, ' + todayDot + ' 기준)\n'
      + '// 지역(ar)은 areaCode 체계. 앱은 yogurthelp.me/tour/festival.json(매일 수집)을 우선 사용하고 이 파일은 오프라인 폴백.\n'
      + '// 갱신: github.io tools/collect_tour_festival.js --js <이 파일>\n\n'
      + 'var festUpdate = "' + todayDot + '";\nvar festData = [\n'
      + out.map(x => { const o = Object.assign({}, x); delete o.m; delete o.dd; delete o.src; return JSON.stringify(o); }).join(',\n') + '\n];\n';
    fs.writeFileSync(process.argv[ji + 1], body);
    console.log('wrote ' + process.argv[ji + 1]);
  }
})().catch(e => { console.error('실패: ' + e.message); process.exit(1); });
