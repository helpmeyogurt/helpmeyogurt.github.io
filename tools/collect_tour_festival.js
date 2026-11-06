// 여행끝판왕 '이달의 축제' 수집 — 한국관광공사 TourAPI(KorService2/searchFestival2) 전국 진행중+다가오는 축제
// + 제주는 VisitJeju 보충분(tour/jeju_vj.json, 로컬 브라우저 수집 후 업로드) 병합 → tour/festival.json
// GitHub Actions에서 실행(env DATAGO_KEY = data.go.kr 일반 인증키 decoding). 키는 출력에 절대 쓰지 않음.
// 지역(ar)은 앱 탭의 areaCode 체계. lDongRegnCd(법정동 시도코드) → areaCode 매핑, 전남광주통합(12)은 자치구로 광주/전남 분리.
// 안전장치: API 오류·결과 급감(이전 대비 50% 미만 또는 50건 미만)이면 실패 종료 → 기존 파일 유지.
// 사용: node tools/collect_tour_festival.js [--js <data_tour_festival.js 경로>]   (--js: 앱 번들용 var festData 파일도 생성)
'use strict';
const fs = require('fs');
const https = require('https');

const KEY = process.env.DATAGO_KEY;
const OUT = 'tour/festival.json';
const JEJU = 'tour/jeju_vj.json';
const BASE = 'https://apis.data.go.kr/B551011/KorService2/searchFestival2';
const ROWS = 500;

if (!KEY) { console.error('DATAGO_KEY 미설정'); process.exit(1); }

const GJ = ['동구', '서구', '남구', '북구', '광산구'];
const CODE = { '11': 1, '28': 2, '30': 3, '27': 4, '29': 5, '26': 6, '31': 7,
  '41': 31, '42': 32, '51': 32, '43': 33, '44': 34, '47': 35,
  '48': 36, '45': 37, '52': 37, '46': 38, '50': 39 };

function areaOf(f) {
  const c = String(f.lDongRegnCd || '');
  if (c === '12') return GJ.includes((f.addr1 || '').split(' ')[1] || '') ? 5 : 38;
  if (c.startsWith('36')) return 8;
  return CODE[c] || 0;
}
const fmt = d => (d = String(d || ''), d.length === 8 ? d.slice(0, 4) + '.' + d.slice(4, 6) + '.' + d.slice(6, 8) : d);
const norm = s => String(s || '').replace(/\d+/g, '').replace(/[^가-힣a-zA-Z]/g, '').toLowerCase();

function kstToday() {
  const t = new Date(Date.now() + 9 * 3600e3);
  return t.toISOString().slice(0, 10).replace(/-/g, '');
}

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 60000, headers: { 'Accept': 'application/json' } }, res => {
      const ch = []; res.on('data', c => ch.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') }));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

async function fetchAll(today) {
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const q = new URLSearchParams({ serviceKey: KEY, MobileOS: 'ETC', MobileApp: 'yogurt', _type: 'json',
      arrange: 'A', numOfRows: String(ROWS), pageNo: String(page), eventStartDate: today });
    const r = await get(BASE + '?' + q);
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    let d;
    try { d = JSON.parse(r.body); } catch (e) { throw new Error('JSON 아님: ' + r.body.slice(0, 80).replace(/\s+/g, ' ')); }
    const h = d.response && d.response.header;
    if (!h || h.resultCode !== '0000') throw new Error('resultCode ' + (h && h.resultCode) + ' ' + (h && h.resultMsg));
    const b = d.response.body, it = b.items && b.items.item;
    const arr = !it ? [] : Array.isArray(it) ? it : [it];
    rows.push(...arr);
    if (page * ROWS >= Number(b.totalCount || 0) || !arr.length) return { rows, total: Number(b.totalCount || 0) };
  }
  throw new Error('페이지 과다');
}

(async () => {
  const today = kstToday();
  const { rows, total } = await fetchAll(today);
  const kto = [];
  for (const f of rows) {
    const ar = areaOf(f);
    if (!ar) continue;
    if (String(f.eventenddate || '') < today) continue;
    kto.push({ n: String(f.title || '').trim(), a: String(f.addr1 || '').trim(), ar,
      s: fmt(f.eventstartdate), e: fmt(f.eventenddate),
      i: String(f.firstimage || f.firstimage2 || '').trim().replace(/^http:\/\//, 'https://'),
      id: String(f.contentid || '') });
  }

  // 제주 VisitJeju 보충(관광공사에 없는 이름만, 종료분 제외)
  let vj = [], vjAdded = 0;
  try { vj = JSON.parse(fs.readFileSync(JEJU, 'utf8')).data || []; } catch (e) { console.error('jeju_vj.json 없음/깨짐 — 제주 보충 생략'); }
  const seen = new Set(kto.filter(x => x.ar === 39).map(x => norm(x.n)));
  const out = kto.slice();
  for (const x of vj) {
    const k = norm(x.n);
    if (!k || seen.has(k) || String(x.e || '').replace(/\./g, '') < today) continue;
    seen.add(k); out.push({ n: x.n, a: x.a || '', ar: 39, s: x.s, e: x.e, i: x.i || '' }); vjAdded++;
  }
  out.sort((p, q) => (p.s < q.s ? -1 : p.s > q.s ? 1 : p.n < q.n ? -1 : p.n > q.n ? 1 : 0));

  // 급감 방지: 이전 파일 대비 절반 미만 또는 절대 50건 미만이면 실패
  let prev = 0;
  try { prev = (JSON.parse(fs.readFileSync(OUT, 'utf8')).data || []).length; } catch (e) { /* 최초 */ }
  if (out.length < 50 || (prev && out.length < prev * 0.5)) {
    console.error(`결과 급감(이번 ${out.length}, 이전 ${prev}) — 기존 파일 유지`); process.exit(1);
  }

  const per = {};
  out.forEach(x => { per[x.ar] = (per[x.ar] || 0) + 1; });
  const updated = fmt(today);
  const doc = { updated, dateKey: today, src: { kto: kto.length, jejuVisitJeju: vjAdded }, data: out };
  fs.mkdirSync('tour', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc));
  console.log(`API total ${total} → 진행중+예정 ${kto.length} + 제주보충 ${vjAdded} = ${out.length}`, JSON.stringify(per));

  const ji = process.argv.indexOf('--js');
  if (ji > 0 && process.argv[ji + 1]) {
    const body = '// 이달의 축제 (KTO TourAPI searchFestival2 + 제주는 VisitJeju 조합, ' + updated + ' 기준)\n'
      + '// 지역(ar)은 areaCode 체계. 앱은 yogurthelp.me/tour/festival.json(매일 수집)을 우선 사용하고 이 파일은 오프라인 폴백.\n'
      + '// 갱신: github.io tools/collect_tour_festival.js --js <이 파일>\n\n'
      + 'var festUpdate = "' + updated + '";\nvar festData = [\n'
      + out.map(x => JSON.stringify({ n: x.n, a: x.a, ar: x.ar, s: x.s, e: x.e, i: x.i })).join(',\n') + '\n];\n';
    fs.writeFileSync(process.argv[ji + 1], body);
    console.log('wrote ' + process.argv[ji + 1]);
  }
})().catch(e => { console.error('실패: ' + e.message); process.exit(1); });
