// 여행끝판왕 수집기 공용 — HTTP, 주소→지역 그룹/날씨 지역코드 매핑
'use strict';
const fs = require('fs');
const https = require('https');

function get(url, accept) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 60000, headers: { 'Accept': accept || 'application/json' } }, res => {
      const ch = []; res.on('data', c => ch.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') }));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// data.go.kr TourAPI 계열 호출 → items 배열 (resultCode 0000 아니면 throw)
async function tourApi(base, op, params, key) {
  const q = new URLSearchParams(Object.assign({ serviceKey: key, MobileOS: 'ETC', MobileApp: 'yogurt', _type: 'json' }, params));
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await get(base + op + '?' + q);
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      let d;
      try { d = JSON.parse(r.body); } catch (e) { throw new Error('JSON 아님: ' + r.body.slice(0, 80).replace(/\s+/g, ' ')); }
      const h = d.response && d.response.header;
      if (!h || h.resultCode !== '0000') throw new Error('resultCode ' + (h && h.resultCode) + ' ' + (h && h.resultMsg));
      const b = d.response.body, it = b.items && b.items.item;
      return { items: !it ? [] : Array.isArray(it) ? it : [it], total: Number(b.totalCount || 0) };
    } catch (e) { last = e; await sleep(1500); }
  }
  throw last;
}

// ── 주소 → 시도 ─────────────────────────────────────────
const SIDO = [
  [/^서울/, '서울특별시', 0], [/^인천/, '인천광역시', 0], [/^경기/, '경기도', 0],
  [/^강원/, '강원특별자치도', 1],
  [/^대전/, '대전광역시', 2], [/^세종/, '세종특별자치시', 2], [/^충청북도|^충북/, '충청북도', 2], [/^충청남도|^충남/, '충청남도', 2],
  [/^대구/, '대구광역시', 3], [/^부산/, '부산광역시', 3], [/^울산/, '울산광역시', 3], [/^경상북도|^경북/, '경상북도', 3], [/^경상남도|^경남/, '경상남도', 3],
  [/^전북|^전라북도/, '전북특별자치도', 4], [/^광주/, '광주광역시', 4], [/^전남광주/, '전남광주통합특별시', 4], [/^전라남도|^전남/, '전라남도', 4],
  [/^제주/, '제주특별자치도', 5],
];
function sidoOf(addr) {
  const t = String(addr || '').trim().split(/\s+/)[0] || '';
  for (const [re, name, g] of SIDO) if (re.test(t)) return { name, g };
  return null;
}
// 앱 목록 지역 그룹: 0 수도권 1 강원 2 충청 3 경상 4 전라 5 제주 (-1 미상)
function groupOf(addr) { const s = sidoOf(addr); return s ? s.g : -1; }

// ── 주소 → 날씨 지역코드(weather/now.json 키) ─────────────────
// now.json 항목: {sido:'경상남도', sigungu:'통영시', ...}. 광주·전남은 '전남광주통합특별시'로 통합 표기.
let WX = null;
function wxIndex() {
  if (WX) return WX;
  WX = { bySg: {}, bySido: {} };
  try {
    const n = JSON.parse(fs.readFileSync('weather/now.json', 'utf8')).wx || {};
    for (const [code, v] of Object.entries(n)) {
      const sd = String(v.sido || ''), sg = String(v.sigungu || '');
      const k = sd + '|' + sg;
      if (!WX.bySg[k]) WX.bySg[k] = code;
      // '창원시 의창구' → '창원시'로도 찾게
      const first = sg.split(' ')[0];
      if (first && !WX.bySg[sd + '|' + first]) WX.bySg[sd + '|' + first] = code;
      if (!WX.bySido[sd]) WX.bySido[sd] = code;
    }
  } catch (e) { /* 날씨 파일 없으면 코드 생략 */ }
  return WX;
}
const WX_SIDO = { '광주광역시': '전남광주통합특별시', '전라남도': '전남광주통합특별시' };
function wxCode(addr) {
  const ix = wxIndex();
  const p = String(addr || '').trim().split(/\s+/);
  const s = sidoOf(addr);
  if (!s) return '';
  const sd = WX_SIDO[s.name] || s.name;
  const cand = [p[1] && p[2] ? p[1] + ' ' + p[2] : '', p[1] || ''].filter(Boolean);
  for (const c of cand) if (ix.bySg[sd + '|' + c]) return ix.bySg[sd + '|' + c];
  return ix.bySido[sd] || '';
}

// ── 사진 없는 장소/축제 외부 사진 보충 ─────────────────────────
// ① 위키백과(ko) 대표 이미지(자유 라이선스, 키 불필요) — 제목이 이름과 같고, 이름의 괄호 지역(예: 응봉산(울진))이
//    문서 제목 괄호와 다르면 버림. 위치도·지도·'사진 필요' 자리 이미지·SVG 제외.
// ② 카카오 블로그 검색(env KAKAO_KEY 있을 때만) — 제목에 장소명+종류에 맞는 말이 있는 글의 대표 사진만(blogImage).
const UA = 'yogurt-tour-collector/1.0 (https://yogurthelp.me)';
function getH(url, headers) {
  return new Promise(res => {
    https.get(url, { timeout: 20000, headers: Object.assign({ 'User-Agent': UA, Accept: 'application/json' }, headers || {}) }, r => {
      const ch = []; r.on('data', c => ch.push(c)); r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(ch).toString('utf8') }));
    }).on('error', () => res({ status: 0, body: '' })).on('timeout', function () { this.destroy(); });
  });
}
const nrm = s => String(s || '').replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^가-힣a-zA-Z0-9]/g, '').toLowerCase();
const paren = s => ((String(s || '').match(/\(([^)]*)\)/) || [])[1] || '').trim();
const BAD_IMG = /replace_this|location|_loc|locator|map|지도|satellite|daedongyeojido|\.svg|flag|emblem|logo|symbol/i;
async function wikiImage(name) {
  const q = String(name).replace(/\s*\(.*?\)\s*/g, ' ').trim();
  const u = 'https://ko.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrlimit=3&gsrsearch=' + encodeURIComponent(q) +
    '&prop=pageimages&piprop=thumbnail&pithumbsize=500';
  const r = await getH(u);
  let d; try { d = JSON.parse(r.body); } catch (e) { return ''; }
  const pages = Object.values((d.query && d.query.pages) || {}).sort((a, b) => a.index - b.index);
  const pn = paren(name);
  const p = pages.find(pg => {
    if (!pg.thumbnail || nrm(pg.title) !== nrm(q)) return false;
    const pt = paren(pg.title);
    if (pt && (!pn || !(pt.includes(pn) || pn.includes(pt)))) return false;   // 다른 지역의 동명 장소
    return !BAD_IMG.test(decodeURIComponent(pg.thumbnail.source));
  });
  return p ? p.thumbnail.source : '';
}
// 카카오(다음) 이미지 검색 — env KAKAO_KEY(REST API 키) 있을 때만. 썸네일(kakaocdn) 주소 사용.
// (네이버 검색 API는 2026-07-31 신규 신청 종료·NAVER API HUB 유료 전환으로 사용 안 함)
// 카카오 블로그 검색으로 '검증된' 사진 찾기 — 제목에 장소명이 있고, 종류에 맞는 말(pos)이 있고, 엉뚱한 말(neg)이 없을 때만.
// (이미지 검색은 글 제목이 없어 '가현산' → 동네 횟집 간판 같은 오류가 생겼음 → 2026-11-06 블로그 검색으로 교체)
// ctx: { pos: RegExp|null, neg: RegExp|null }
const FOOD_NEG = /맛집|칼국수|식당|백숙|메뉴|국밥|카페|베이커리|빵집|요양|병원|의원|약국|부동산|분양|아파트|매물|오피스텔|횟집|회집|삼겹|고기집|술집|치킨|피자|중국집|짜장|분식|정육|마트|학원|어린이집|교회|성당|노래방|pc방|미용|네일/i;
async function blogImage(name, region, ctx) {
  if (!process.env.KAKAO_KEY) return null;   // null = 키 없음(시도 안 함)
  const core = String(name).replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s*\[.*?\]\s*/g, ' ').trim();
  const k = nrm(core);
  if (k.length < 2) return '';
  const qs = [core, region ? core + ' ' + region : ''].filter(Boolean);
  for (const q of qs) {
    const r = await getH('https://dapi.kakao.com/v2/search/blog?size=15&sort=accuracy&query=' + encodeURIComponent(q),
      { Authorization: 'KakaoAK ' + process.env.KAKAO_KEY });
    if (r.status !== 200) throw new Error('kakao ' + r.status);
    let d; try { d = JSON.parse(r.body); } catch (e) { continue; }
    const hit = (d.documents || []).find(x => {
      if (!x.thumbnail) return false;
      const t = String(x.title || '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ');
      if (!nrm(t).includes(k)) return false;                 // 제목에 장소명
      if (ctx && ctx.neg && ctx.neg.test(t)) return false;   // 엉뚱한 말
      if (ctx && ctx.pos && !ctx.pos.test(t)) return false;  // 종류에 맞는 말
      return true;
    });
    if (hit) return { i: https2(hit.thumbnail), I: '' };
    await sleep(120);
  }
  return '';
}
// items 중 사진 없는 것 채움. prevByKey: 이전 파일 항목(키→항목), keyOf(x).
// 표시: ix='w'(위키)|'b'(블로그 검증), ni=못 찾은 날(YYYYMMDD, 2주 뒤 재시도). 예전 이미지 검색 사진(ix='n')은 검증 안 된 것이라 버리고 다시 찾음.
// opt: { wiki, budget:{left}, region:(x)=>string, ctx:(x)=>{pos,neg} }
async function fillImages(items, prevByKey, keyOf, opt) {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  const stale = d => !d || Number(today) - Number(d) >= 14;
  const st = { carried: 0, wiki: 0, naver: 0, tried: 0 };
  for (const x of items) {
    if (x.ix === 'n') { delete x.i; delete x.I; delete x.ix; }   // 이전 실행이 남긴 검증 안 된 사진
    if (x.i) continue;
    const pv = prevByKey[keyOf(x)];
    if (pv && pv.i && (pv.ix === 'w' || pv.ix === 'b')) { x.i = pv.i; x.ix = pv.ix; st.carried++; continue; }
    const keyNow = !!process.env.KAKAO_KEY;
    const pvTried = pv && pv.ni && pv.niv === 2;   // 새 방식으로 시도했던 기록만 인정
    if (pvTried && !stale(pv.ni) && !(pv.nk && keyNow) && !process.env.IMG_RETRY) { x.ni = pv.ni; x.niv = 2; if (pv.nk) x.nk = 1; continue; }
    if (opt.budget.left <= 0) continue;
    opt.budget.left--; st.tried++;
    try {
      const u = opt.wiki ? await wikiImage(x.n) : '';
      if (u) { x.i = u; x.ix = 'w'; st.wiki++; }
      else {
        const nv = await blogImage(x.n, opt.region ? opt.region(x) : '', opt.ctx ? opt.ctx(x) : null);
        if (nv) { x.i = nv.i; x.ix = 'b'; st.naver++; }
        else { x.ni = today; x.niv = 2; if (nv === null) x.nk = 1; }
      }
    } catch (e) { st.err = (st.err || 0) + 1; st.lastErr = e.message; }
    await sleep(150);
  }
  return st;
}
// 시군구(주소 둘째 토큰)
const sigungu = a => (String(a || '').trim().split(/\s+/)[1] || '');

const https2 = s => String(s || '').trim().replace(/^http:\/\//, 'https://');
const num = v => { const n = Number(v); return isFinite(n) && n ? Math.round(n * 1e5) / 1e5 : 0; };

module.exports = { get, sleep, tourApi, sidoOf, groupOf, wxCode, https2, num, fillImages, wikiImage, blogImage, FOOD_NEG, sigungu };
