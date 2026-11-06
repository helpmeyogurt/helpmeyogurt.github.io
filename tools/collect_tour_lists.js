// 여행끝판왕 목록 페이지 수집 → tour/lists.json(메타) + tour/l_<key>_<k>.json(탭별 목록)
//  parks 국립·도립·군립공원(1004) / forest 자연휴양림·수목원(1005) / theme 테마파크·워터파크·동물원(1006)
//  mountain 산·강·계곡·해수욕장(1007) / lake 호수·섬·폭포·동굴(1008)   — TourAPI KorService2 신 분류체계(lclsSystm)
//  camp   캠핑장(1010)            — 고캠핑 GoCamping (업종별 탭, 겹치면 여러 탭에)
//  pet    반려동물 동반여행(1011) — KorPetTourService2 + 상세(동반 조건) 증분 수집
//  with   무장애 여행(1012)       — KorWithService2 + 상세(편의시설) 증분 수집
// 항목: {id,n(이름),a(주소),t(전화),i(썸네일),I(큰 사진),x,y(경위도),g(지역그룹 0수도권~5제주),w(날씨 지역코드),
//        d(상세 문장, 선택),h(홈페이지, 선택),nat(국립=1, 공원만)}
// 상세(pet/with)는 하루 호출량 한도(API별 1,000) 때문에 실행마다 리스트별 DETAIL_CAP건씩만 새로 받고, 받은 건 이전 파일에서 이어 씀.
// 안전장치: 목록이 이전 대비 절반 미만이면 그 탭은 이전 파일 유지. 리스트별 실패는 격리(이전 파일 유지).
// 사용: node tools/collect_tour_lists.js [--only key,key] [--bundle <앱 assets/html/tour/ldata 경로>]  (번들 = 오프라인 폴백, data/가 아니라 ldata/)
'use strict';
const fs = require('fs');
const L = require('./tour_lib');

const KEY = process.env.DATAGO_KEY;
if (!KEY) { console.error('DATAGO_KEY 미설정'); process.exit(1); }
const KOR = 'https://apis.data.go.kr/B551011/KorService2/';
const CAMP = 'https://apis.data.go.kr/B551011/GoCamping/';
const PET = 'https://apis.data.go.kr/B551011/KorPetTourService2/';
const WITH = 'https://apis.data.go.kr/B551011/KorWithService2/';
const DIR = 'tour';
const DETAIL_CAP = Number(process.env.DETAIL_CAP || 450);

function kstDot() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '.'); }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }

// TourAPI 표준 목록 항목 → 공통 항목
function korItem(x) {
  const a = (String(x.addr1 || '') + ' ' + String(x.addr2 || '')).replace(/\s+/g, ' ').trim();
  return { id: String(x.contentid || ''), n: String(x.title || '').trim(), a, t: String(x.tel || '').replace(/<[^>]*>/g, ' ').trim(),
    i: L.https2(x.firstimage2 || x.firstimage), I: L.https2(x.firstimage), x: L.num(x.mapx), y: L.num(x.mapy) };
}
async function pages(base, op, params, rows = 1000) {
  const out = [];
  for (let p = 1; p <= 30; p++) {
    const r = await L.tourApi(base, op, Object.assign({ numOfRows: String(rows), pageNo: String(p) }, params), KEY);
    out.push(...r.items);
    if (p * rows >= r.total || !r.items.length) break;
    await L.sleep(300);
  }
  return out;
}
const kor = (op, params) => pages(KOR, op, Object.assign({ arrange: 'A' }, params)).then(a => a.map(korItem));
// 관광공사 신 분류체계(lclsSystm) — 옛 cat 코드는 2026 하반기부터 항목이 빠르게 줄어듦(휴양림 116→25)
const cls = c => kor('areaBasedList2', { lclsSystm1: c.slice(0, 2), lclsSystm2: c.slice(0, 4), lclsSystm3: c });

// 상세 증분: prev(id→d)에서 이어 쓰고, 없는 것만 cap까지 새로 받음
async function withDetails(items, prevMap, fetchOne, budget) {
  for (const it of items) {
    if (prevMap[it.id] !== undefined) { it.d = prevMap[it.id]; continue; }
    if (budget.left <= 0) continue;
    budget.left--;
    try { const d = await fetchOne(it.id); it.d = d; } catch (e) { budget.fail = (budget.fail || 0) + 1; }
    await L.sleep(120);
  }
}
const PET_F = [['acmpyTypeCd', '동반 구분'], ['acmpyPsblCpam', '동반 가능 동물'], ['acmpyNeedMtr', '동반 시 필요사항'],
  ['relaPosesFclty', '관련 시설'], ['relaAcdntRiskMtr', '사고 대비'], ['etcAcmpyInfo', '기타']];
const WITH_F = [['parking', '주차'], ['publictransport', '대중교통'], ['route', '접근로'], ['exit', '출입통로'], ['wheelchair', '휠체어'],
  ['elevator', '엘리베이터'], ['restroom', '화장실'], ['room', '객실'], ['auditorium', '관람석'], ['ticketoffice', '매표소'],
  ['stroller', '유아차'], ['lactationroom', '수유실'], ['babysparechair', '유아용 의자'], ['braileblock', '점자블록'],
  ['helpdog', '보조견'], ['guidehuman', '안내요원'], ['audioguide', '음성안내'], ['signguide', '수어안내'], ['videoguide', '자막·영상'],
  ['handicapetc', '기타(지체)'], ['blindhandicapetc', '기타(시각)'], ['hearinghandicapetc', '기타(청각)'], ['infantsfamilyetc', '기타(영유아)']];
const lines = (o, F) => F.map(([k, lab]) => { const v = String(o[k] || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); return v ? lab + ': ' + v : ''; }).filter(Boolean).join('\n');
const petDetail = async id => { const r = await L.tourApi(PET, 'detailPetTour2', { contentId: id }, KEY); return r.items[0] ? lines(r.items[0], PET_F) : ''; };
const withDetail = async id => { const r = await L.tourApi(WITH, 'detailWithTour2', { contentId: id }, KEY); return r.items[0] ? lines(r.items[0], WITH_F) : ''; };

// ── 리스트 정의: types = 탭 이름, fetch → 탭별 항목 배열 ──────────────
const LISTS = {
  parks: { types: ['국립공원·도립공원'], fetch: async () => {
    const nat = (await cls('NA040100')).map(x => Object.assign(x, { nat: 1 }));
    return [[...nat, ...await cls('NA040200'), ...await cls('NA040300')]];
  } },
  forest: { types: ['자연휴양림', '수목원·정원'], fetch: async () => [await cls('NA040600'), await cls('NA040700')] },
  theme: { types: ['테마파크', '워터파크', '동물원·수족관'], fetch: async () => [await cls('VE020100'), await cls('VE020200'), [...await cls('VE020300'), ...await cls('VE020400')]] },
  mountain: { types: ['산', '강', '계곡', '해수욕장'], fetch: async () => [await cls('NA010100'), await cls('NA020100'), await cls('NA010400'), await cls('NA020900')] },
  lake: { types: ['호수·저수지', '섬', '폭포', '동굴'], fetch: async () => [[...await cls('NA020200'), ...await cls('NA020300')], await cls('NA020500'), await cls('NA010300'), await cls('NA030100')] },
  camp: { types: ['일반야영장', '자동차야영장', '글램핑', '카라반'], fetch: async () => {
    const raw = await pages(CAMP, 'basedList', {});
    const tabs = [[], [], [], []];
    for (const x of raw) {
      const a = (String(x.addr1 || '') + ' ' + String(x.addr2 || '')).replace(/\s+/g, ' ').trim();
      const d = [x.lineIntro && String(x.lineIntro).trim(), x.induty && '업종: ' + x.induty, x.sbrsCl && '부대시설: ' + x.sbrsCl,
        x.animalCmgCl && '반려동물: ' + x.animalCmgCl, x.operPdCl && '운영기간: ' + x.operPdCl, x.operDeCl && '운영일: ' + x.operDeCl,
        x.resveCl && '예약: ' + x.resveCl].filter(Boolean).join('\n');
      const it = { id: String(x.contentId || ''), n: String(x.facltNm || '').trim(), a, t: String(x.tel || '').trim(),
        i: L.https2(x.firstImageUrl), I: L.https2(x.firstImageUrl), x: L.num(x.mapX), y: L.num(x.mapY), d,
        h: L.https2(x.homepage || x.resveUrl) };
      const ind = String(x.induty || '');
      let put = false;
      LISTS.camp.types.forEach((ty, k) => { if (ind.includes(ty)) { tabs[k].push(it); put = true; } });
      if (!put) tabs[0].push(it);
    }
    return tabs;
  } },
  pet: { types: ['관광지', '숙박', '음식점', '문화·레포츠'], detail: petDetail, fetch: async () => {
    const t = async ct => (await pages(PET, 'areaBasedList2', { contentTypeId: String(ct), arrange: 'A' })).map(korItem);
    return [await t(12), await t(32), await t(39), [...await t(14), ...await t(28)]];
  } },
  with: { types: ['관광지', '문화시설', '숙박', '음식점'], detail: withDetail, fetch: async () => {
    const t = async ct => (await pages(WITH, 'areaBasedList2', { contentTypeId: String(ct), arrange: 'A' })).map(korItem);
    return [await t(12), await t(14), await t(32), await t(39)];
  } },
};

function finish(items) {
  const seen = new Set(), out = [];
  for (const it of items) {
    if (!it.n) continue;
    const k = it.id || it.n + '|' + it.a;
    if (seen.has(k)) continue;
    seen.add(k);
    it.g = L.groupOf(it.a);
    it.w = L.wxCode(it.a);
    for (const f of Object.keys(it)) if (f !== 'g' && (it[f] === '' || it[f] === 0 || it[f] === undefined)) delete it[f];
    out.push(it);
  }
  // 정렬은 '(주)·주식회사·농업회사법인' 같은 법인 표기를 빼고 이름순
  const sk = n => String(n).replace(/^(?:\s*(?:\((?:주|유|재|사|합)\)|㈜|주식회사|농업회사법인|영농조합법인|사단법인|재단법인))+\s*/, '');
  out.sort((p, q) => { const a = sk(p.n), b = sk(q.n); return a < b ? -1 : a > b ? 1 : 0; });
  return out;
}

(async () => {
  const oi = process.argv.indexOf('--only');
  const only = oi > 0 ? process.argv[oi + 1].split(',') : null;
  const bi = process.argv.indexOf('--bundle');
  const bundle = bi > 0 ? process.argv[bi + 1] : null;
  const updated = kstDot();
  const meta = readJson(DIR + '/lists.json') || { lists: {} };
  let failed = 0, changed = false;
  const imgBudget = { left: Number(process.env.IMG_CAP || 600) };   // 실행당 외부 사진 검색 수
  for (const [key, def] of Object.entries(LISTS)) {
    if (only && !only.includes(key)) continue;
    let tabs;
    try { tabs = await def.fetch.call(def); }
    catch (e) { console.error(`${key}: 실패(${e.message}) — 이전 파일 유지`); failed++; continue; }
    const counts = [];
    const budget = { left: DETAIL_CAP };   // 상세 API별 하루 한도 → 리스트마다 따로
    for (let k = 0; k < def.types.length; k++) {
      const path = `${DIR}/l_${key}_${k}.json`;
      const prev = readJson(path);
      let items = finish(tabs[k] || []);
      if (prev && prev.items && items.length < prev.items.length * 0.5) {
        console.error(`${key}[${k}] 급감(${items.length} < 이전 ${prev.items.length}) — 이전 파일 유지`);
        counts.push(prev.items.length); continue;
      }
      // 사진 없는 곳: 이전에 찾은 외부 사진 이어 쓰기 → 위키백과 → 카카오 이미지(키 있을 때)
      {
        const pk = {};
        (prev && prev.items || []).forEach(p => { pk[p.id || p.n + '|' + p.a] = p; });
        const st = await L.fillImages(items, pk, x => x.id || x.n + '|' + x.a, { wiki: true, budget: imgBudget, naverQuery: x => x.n.replace(/s*(.*?)s*/g, ' ').trim() + ' ' + (key === 'camp' && !/캠핑|캠프|야영|글램핑|카라반/.test(x.n) ? '캠핑장 ' : '') + L.sigungu(x.a) });
        if (st.tried || st.carried) console.log(`  ${key}[${k}] 사진 보충: 이어씀 ${st.carried}, 새로 시도 ${st.tried} → 위키 ${st.wiki} · 카카오 ${st.naver}${st.err ? ` · 오류 ${st.err}(${st.lastErr})` : ""}`);
      }
      if (def.detail) {
        const pm = {};
        (prev && prev.items || []).forEach(p => { if (p.id && p.d !== undefined) pm[p.id] = p.d; });
        await withDetails(items, pm, def.detail, budget);
        items.forEach(it => { if (it.d === '') delete it.d; });
      }
      const doc = { updated, key, type: def.types[k], items };
      const prevBody = prev ? JSON.stringify(Object.assign({}, prev, { updated })) : '';
      const body = JSON.stringify(doc);
      if (body !== prevBody) { fs.writeFileSync(path, body); changed = true; }
      counts.push(items.length);
      const withD = def.detail ? `, 상세 ${items.filter(i => i.d !== undefined).length}/${items.length}` : '';
      console.log(`${key}[${k}] ${def.types[k]}: ${items.length}${withD}${body === prevBody ? ' (변경 없음)' : ''}`);
      if (bundle) fs.writeFileSync(`${bundle}/tour_l_${key}_${k}.js`, `TourData(${JSON.stringify(key)},${k},${body});\n`);
    }
    const m = { types: def.types, counts };
    if (JSON.stringify(meta.lists[key]) !== JSON.stringify(m)) changed = true;
    meta.lists[key] = m;
    if (def.detail) console.log(`${key} 상세: 새로 ${DETAIL_CAP - budget.left}건${budget.fail ? ', 실패 ' + budget.fail + '건(다음 실행에 재시도)' : ''}`);
  }
  fs.mkdirSync(DIR, { recursive: true });
  if (changed || !meta.updated) { meta.updated = updated; fs.writeFileSync(DIR + '/lists.json', JSON.stringify(meta)); }
  if (failed === Object.keys(LISTS).length) process.exit(1);
})().catch(e => { console.error('실패: ' + e.message); process.exit(1); });
