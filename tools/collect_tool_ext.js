// 도구 확장 데이터 수집 — 환율(fx.json) / 일출일몰(sun.json) / 대기질(air.json)
// 각 파트는 독립 실행: 하나가 실패해도 나머지는 저장(차단 금지 — car 교훈).
// 키: KOREAEXIM_KEY(환율, 수출입은행 자체 발급), DATAGO_KEY(출몰시각·에어코리아).
// 키 없거나 미승인인 파트는 건너뛰고 기존 파일 유지(빈 파일로 덮지 않음).
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT_DIR = 'tool';
const EXIM_KEY = process.env.KOREAEXIM_KEY;
const DATAGO_KEY = process.env.DATAGO_KEY;

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 45000, headers: { 'Accept': '*/*' } }, (res) => {
      const ch = []; res.on('data', c => ch.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') }));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function kst() { return new Date(Date.now() + 9 * 3600e3); }
const p2 = n => (n < 10 ? '0' : '') + n;
function stamp() { const d = kst(); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} KST`; }
function ymd(d) { return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`; }
function xmlTag(src, tag) { const m = src.match(new RegExp('<' + tag + '>([^<]*)<')); return m ? m[1].trim() : ''; }

// ---------- 환율 (수출입은행 AP01) ----------
async function collectFx() {
  if (!EXIM_KEY) { console.log('fx: KOREAEXIM_KEY 없음 — 건너뜀'); return; }
  // 주말/미고시 대비 최근 7일 역순으로 시도
  for (let i = 0; i < 7; i++) {
    const d = kst(); d.setUTCDate(d.getUTCDate() - i);
    const day = ymd(d);
    let r;
    try { r = await get(`https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON?authkey=${EXIM_KEY}&searchdate=${day}&data=AP01`); }
    catch (e) { console.error('fx: ' + e.message); return; }
    if (r.status !== 200) { console.error('fx: HTTP ' + r.status); return; }
    let arr;
    try { arr = JSON.parse(r.body); } catch (e) { console.error('fx: JSON 파싱 실패'); return; }
    if (!Array.isArray(arr) || !arr.length) { await sleep(300); continue; }   // 미고시일 → 이전 날
    if (arr[0] && arr[0].result && arr[0].result !== 1) { console.error('fx: result=' + arr[0].result + ' (키/한도 확인)'); return; }
    const rates = arr.filter(x => x.result === 1).map(x => {
      const um = String(x.cur_unit || '').match(/^([A-Z]+)\((\d+)\)/);
      return {
        cur: um ? um[1] : x.cur_unit,
        unit: um ? Number(um[2]) : 1,
        name: x.cur_nm || '',
        rate: Number(String(x.deal_bas_r || '').replace(/,/g, '')),
      };
    }).filter(x => x.cur && x.rate > 0);
    if (!rates.length) { await sleep(300); continue; }
    const base = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`;
    fs.writeFileSync(path.join(OUT_DIR, 'fx.json'), JSON.stringify({ generated: stamp(), base, rates }));
    console.log(`fx: ${rates.length}통화 (기준일 ${base})`);
    return;
  }
  console.error('fx: 최근 7일 고시 없음');
}

// ---------- 일출일몰 (천문연 RiseSetInfoService, 지역명) ----------
const SUN_CITIES = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '수원', '춘천', '강릉', '청주', '전주', '목포', '여수', '포항', '창원', '제주'];
async function collectSun() {
  if (!DATAGO_KEY) { console.log('sun: DATAGO_KEY 없음 — 건너뜀'); return; }
  const days = {};
  let anyOk = false, authFail = false;
  for (let i = 0; i < 8 && !authFail; i++) {
    const d = kst(); d.setUTCDate(d.getUTCDate() + i);
    const day = ymd(d);
    days[day] = {};
    for (const city of SUN_CITIES) {
      const url = `https://apis.data.go.kr/B090041/openapi/service/RiseSetInfoService/getAreaRiseSetInfo?serviceKey=${encodeURIComponent(DATAGO_KEY)}&locdate=${day}&location=${encodeURIComponent(city)}`;
      let r;
      try { r = await get(url); } catch (e) { console.error(`sun ${city} ${day}: ${e.message}`); continue; }
      const code = xmlTag(r.body, 'resultCode');
      if (code && code !== '00') {
        console.error(`sun: resultCode ${code} ${xmlTag(r.body, 'resultMsg')}`);
        if (/(SERVICE|KEY|REGISTERED)/i.test(r.body) || code === '30' || code === '20') { authFail = true; break; }
        continue;
      }
      const rise = (xmlTag(r.body, 'sunrise') || '').replace(/\s/g, '').slice(0, 4);
      const set = (xmlTag(r.body, 'sunset') || '').replace(/\s/g, '').slice(0, 4);
      if (/^\d{4}$/.test(rise) && /^\d{4}$/.test(set)) { days[day][city] = { rise, set }; anyOk = true; }
      await sleep(80);
    }
  }
  if (!anyOk) { console.error('sun: 수집 실패(활용신청/승인 확인 필요) — 기존 파일 유지'); return; }
  fs.writeFileSync(path.join(OUT_DIR, 'sun.json'), JSON.stringify({ generated: stamp(), cities: SUN_CITIES, days }));
  console.log(`sun: ${Object.keys(days).length}일 × ${SUN_CITIES.length}지역`);
}

// ---------- 대기질 (에어코리아 측정소별 실시간 = 시도 → 동/구 단위) ----------
// getCtprvnRltmMesureDnsty(sidoName)로 시도별 전 측정소를 받아 stations에 담고,
// 유효 측정소 평균으로 sido 요약을 만든다. (측정소목록 API는 키 미등록이라 addr
// 기반 시군구 그룹은 불가 — 측정소명 자체가 구/동 단위라 그대로 노출.)
const AIR_SIDO = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주', '세종'];
function airNum(v) { const n = Number(v); return (v == null || v === '' || v === '-' || isNaN(n)) ? null : n; }
async function collectAir() {
  if (!DATAGO_KEY) { console.log('air: DATAGO_KEY 없음 — 건너뜀'); return; }
  const stations = {};
  const sido = {};
  let basisOut = '';
  let anyOk = false;
  for (const s of AIR_SIDO) {
    const url = `https://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getCtprvnRltmMesureDnsty`
      + `?serviceKey=${encodeURIComponent(DATAGO_KEY)}&returnType=json&numOfRows=700&pageNo=1`
      + `&sidoName=${encodeURIComponent(s)}&ver=1.3`;
    let items = null;
    for (let a = 1; a <= 3 && !items; a++) {         // 에어코리아 백엔드 간헐 504 → 재시도
      let r;
      try { r = await get(url); } catch (e) { console.error(`air ${s} t${a}: ${e.message}`); await sleep(4000); continue; }
      try {
        const cand = JSON.parse(r.body);
        if (cand.response && cand.response.header && cand.response.header.resultCode === '00') { items = cand.response.body.items || []; break; }
        console.error(`air ${s} t${a}: ${cand.response ? cand.response.header.resultCode : (cand.OpenAPI_ServiceResponse ? cand.OpenAPI_ServiceResponse.cmmMsgHeader.errMsg : r.status)}`);
      } catch (e) { console.error(`air ${s} t${a}: JSON 아님 (${r.body.slice(0, 60)})`); }
      await sleep(4000);
    }
    if (!items) continue;
    const list = [];
    let sum10 = 0, cnt10 = 0, sum25 = 0, cnt25 = 0;
    for (const it of items) {
      const nm = (it.stationName || '').trim();
      if (!nm) continue;
      const pm10 = airNum(it.pm10Value);
      const pm25 = airNum(it.pm25Value);
      list.push({ n: nm, pm10, pm25 });
      if (pm10 != null) { sum10 += pm10; cnt10++; }
      if (pm25 != null) { sum25 += pm25; cnt25++; }
      if (it.dataTime && !basisOut) basisOut = it.dataTime;
    }
    if (!list.length) continue;
    list.sort((a, b) => a.n.localeCompare(b.n, 'ko'));
    stations[s] = list;
    sido[s] = { pm10: cnt10 ? Math.round(sum10 / cnt10) : null, pm25: cnt25 ? Math.round(sum25 / cnt25) : null };
    anyOk = true;
    await sleep(300);
  }
  if (!anyOk) { console.error('air: 수집 실패(활용신청/승인·504 확인) — 기존 파일 유지'); return; }
  fs.writeFileSync(path.join(OUT_DIR, 'air.json'), JSON.stringify({ generated: stamp(), basis: basisOut, sido, stations }));
  const total = Object.values(stations).reduce((a, l) => a + l.length, 0);
  console.log(`air: ${Object.keys(stations).length}개 시도 · ${total}개 측정소 (기준 ${basisOut})`);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // PART=air 로 실행하면 대기질만 수집(잦은 크론용). 미지정 시 전체.
  const part = (process.env.PART || '').toLowerCase();
  if (part === 'air') {
    await collectAir().catch(e => console.error('air 예외: ' + e.message));
    return;
  }
  await collectFx().catch(e => console.error('fx 예외: ' + e.message));
  await collectSun().catch(e => console.error('sun 예외: ' + e.message));
  await collectAir().catch(e => console.error('air 예외: ' + e.message));
})();
