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

const https2 = s => String(s || '').trim().replace(/^http:\/\//, 'https://');
const num = v => { const n = Number(v); return isFinite(n) && n ? Math.round(n * 1e5) / 1e5 : 0; };

module.exports = { get, sleep, tourApi, sidoOf, groupOf, wxCode, https2, num };
