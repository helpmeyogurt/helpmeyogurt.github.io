// KOBIS 일간 박스오피스 + 연간 박스오피스 수집기 — GitHub Actions에서 매일 실행.
//  · 일간(최신): 메인 위젯 searchMainDailyBoxOffice.do (포스터 thumbUrl 포함, 전날 확정분)
//      → movie/daily_boxoffice.json {date, generated, items:[KOBIS 원본 객체]}
//      앱(ygt_culture_movie.js 일간 탭)이 date==어제일 때 1순위로 사용.
//  · 일간(누적): movie/daily_history.json {YYYYMMDD: {source, items, generated}} — 기존 날짜 보존.
//  · 누락 백필: 크론 스킵으로 빠진 날짜(최근 14일)를 KOBIS 공식 오픈API
//      searchDailyBoxOfficeList.json 으로 채움 (포스터 없음, source:"openapi").
//  · 연간: findYearlyBoxOfficeList.do HTML을 렌더러와 동일 규칙으로 파싱(TOP 20)
//      → movie/yearly_boxoffice.json (연간 탭의 KOBIS 장애 폴백용).
//  · --if-missing: 어제분(main)이 히스토리에 이미 있으면 최신 수집 스킵(백필/연간은 수행)
//      — 여러 크론이 겹칠 때 불필요한 재수집·커밋 방지.
//  · 종료코드: 변경이 있거나 정상 스킵이면 0. 네트워크 실패로 아무것도 못 했으면 1(잡 재시도 유도).
//    전날 집계 미발행(showDt가 어제가 아님)은 0으로 종료 — 다음 크론(10:15/11:20/15:15)이 재시도.
//
// 사용: node collect_movie_daily.js [출력경로=movie/daily_boxoffice.json] [--if-missing]
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const _args = process.argv.slice(2);
const OUT = _args.filter(a => !a.startsWith('--'))[0] || 'movie/daily_boxoffice.json';
const IF_MISSING = _args.includes('--if-missing');
const DIR = path.dirname(OUT);
const HIST = path.join(DIR, 'daily_history.json');
const YEARLY = path.join(DIR, 'yearly_boxoffice.json');
const ALLTIME = path.join(DIR, 'alltime_boxoffice.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MOVIE_KEY = '5fd330746779bae7ba756ec8fc1acad7'; // KOBIS 오픈API 키 (앱 소스에 이미 공개된 값)
const BACKFILL_DAYS = 14;

function get(url, redirects) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Referer': 'https://' + u.hostname + '/' },
      timeout: 25000,
    }, (res) => {
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location && (redirects || 0) < 3) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).href, (redirects || 0) + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', reject)
      .on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
function ymd(d) { const p = n => (n < 10 ? '0' : '') + n; return '' + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()); }
function daysAgo(n) { const d = kstNow(); d.setUTCDate(d.getUTCDate() - n); return d; }
function genStamp() {
  const d = kstNow(); const p = n => (n < 10 ? '0' : '') + n;
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' KST';
}
function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return dflt; } }

// 연간 TOP 20 — 렌더러(ygt_culture_movie.js dataParserYear)와 동일한 분해 규칙
function parseYearly(html) {
  const out = [];
  const parts = html.split('<tr id="');
  for (let i = 1; i < parts.length && out.length < 20; i++) {
    const r = parts[i];
    try {
      out.push({
        rank: r.split('id="td_rank"')[1].split('>')[1].split('<')[0].trim(),
        code: r.split('id="td_movie"')[1].split("mstView('movie','")[1].split("'")[0].trim(),
        title: r.split('id="td_movie"')[1].split('title="')[1].split('"')[0].trim(),
        date: r.split('id="td_openDt"')[1].split('>')[1].split('<')[0].trim(),
        money: r.split('id="td_salesAcc"')[1].split('>')[1].split('<')[0].trim(),
        person: r.split('id="td_audiAcc"')[1].split('>')[1].split('<')[0].trim(),
        scrn: r.split('id="td_scrnCnt"')[1].replace('<img src="/kobis/web/comm/images/common/ico_seoul.gif" alt="S">', '').split('>')[1].split('<')[0].trim(),
      });
    } catch (e) { /* 행 구조가 다르면 스킵 */ }
  }
  return out;
}

// 역대 TOP 20 — findFormerBoxOfficeList.do는 <tr class=".." id="tr_tot0"> 형태라
// 연간의 split('<tr id="') 규칙이 안 맞음 → td_rank 기준 분해. 셀 id도 연간과 다름
// (td_totSalesAcc / td_totAudiAcc / td_totScrnCnt).
function parseAlltime(html) {
  const out = [];
  const parts = html.split('id="td_rank"');
  for (let i = 1; i < parts.length && out.length < 20; i++) {
    const r = parts[i];
    try {
      out.push({
        rank: r.split('>')[1].split('<')[0].trim(),
        code: r.split("mstView('movie','")[1].split("'")[0].trim(),
        title: r.split('title="')[1].split('"')[0].trim(),
        date: r.split('id="td_openDt"')[1].split('>')[1].split('<')[0].trim(),
        money: r.split('id="td_totSalesAcc"')[1].split('>')[1].split('<')[0].trim(),
        person: r.split('id="td_totAudiAcc"')[1].split('>')[1].split('<')[0].trim(),
        scrn: r.split('id="td_totScrnCnt"')[1].split('>')[1].split('<')[0].trim(),
      });
    } catch (e) { /* 행 구조가 다르면 스킵 */ }
  }
  return out;
}

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const hist = readJson(HIST, {});
  const yKey = ymd(daysAgo(1));
  let changed = false, netFail = false;

  // ① 최신 일간 (메인 위젯 — 포스터 포함)
  const haveFresh = hist[yKey] && hist[yKey].source === 'main';
  if (IF_MISSING && haveFresh) {
    console.log('일간: 어제(' + yKey + ')분 이미 수집됨 — 스킵(--if-missing)');
  } else {
    try {
      const arr = JSON.parse(await get('https://www.kobis.or.kr/kobis/business/main/searchMainDailyBoxOffice.do'));
      if (!Array.isArray(arr) || !arr.length) throw new Error('일간 응답 형식 이상');
      const showDt = arr[0].showDt;
      if (showDt === yKey) {
        fs.writeFileSync(OUT, JSON.stringify({ date: showDt, generated: genStamp(), items: arr }));
        hist[showDt] = { source: 'main', generated: genStamp(), items: arr };
        changed = true;
        console.log('일간 저장: ' + OUT + ' (기준일=' + showDt + ', ' + arr.length + '건, 1위 ' + arr[0].movieNm + ')');
      } else {
        // 새벽엔 전날 집계가 아직 없을 수 있음 (KOBIS 발표는 보통 오전) → 다음 크론이 재시도.
        // 대신 받은 날짜(그저께 등)는 히스토리에 main본으로 보강해 둔다.
        console.log('일간: 전날(' + yKey + ') 집계 미발행, 응답 기준일=' + showDt + ' — 다음 예약에서 재시도');
        if (showDt && (!hist[showDt] || hist[showDt].source !== 'main')) {
          hist[showDt] = { source: 'main', generated: genStamp(), items: arr };
          changed = true;
        }
      }
    } catch (e) { netFail = true; console.error('일간 수집 실패: ' + e.message); }
  }

  // ② 누락 백필 — 크론 스킵으로 빠진 최근 14일을 오픈API로 채움 (포스터 없음)
  for (let n = 1; n <= BACKFILL_DAYS; n++) {
    const k = ymd(daysAgo(n));
    if (hist[k]) continue;
    try {
      const j = JSON.parse(await get('https://www.kobis.or.kr/kobisopenapi/webservice/rest/boxoffice/searchDailyBoxOfficeList.json?key=' + MOVIE_KEY + '&targetDt=' + k));
      const list = j && j.boxOfficeResult && j.boxOfficeResult.dailyBoxOfficeList;
      if (Array.isArray(list) && list.length) {
        hist[k] = { source: 'openapi', generated: genStamp(), items: list };
        changed = true;
        console.log('백필: ' + k + ' (' + list.length + '건, 오픈API)');
      } else {
        console.log('백필: ' + k + ' 데이터 없음 — 스킵');
      }
      await new Promise(r => setTimeout(r, 300));
    } catch (e) { console.log('백필 ' + k + ' 실패: ' + e.message); }
  }

  // ③ 연간 TOP 20 (연간 탭의 KOBIS 장애 폴백)
  try {
    const html = await get('https://www.kobis.or.kr/kobis/business/stat/boxs/findYearlyBoxOfficeList.do?loadEnd=0&searchType=search&sMultiMovieYn=&sRepNationCd=');
    const items = parseYearly(html);
    if (items.length >= 10) {
      const prev = readJson(YEARLY, null);
      const next = { year: '' + kstNow().getUTCFullYear(), generated: genStamp(), items };
      if (!prev || JSON.stringify(prev.items) !== JSON.stringify(items)) {
        fs.writeFileSync(YEARLY, JSON.stringify(next));
        changed = true;
        console.log('연간 저장: ' + YEARLY + ' (' + items.length + '건, 1위 ' + items[0].title + ')');
      } else {
        console.log('연간: 변경 없음');
      }
    } else {
      console.warn('연간: 파싱 결과 부족(' + items.length + '건) — 사이트 개편 가능성, 기존 파일 유지');
    }
  } catch (e) { console.warn('연간 수집 실패(경고만): ' + e.message); }

  // ③-2 역대 TOP 20 ×3 (종합/한국/외국) — 1101 '역대' 탭용.
  //     기존엔 번들 정적 data_culture_movie.js(all_tot/all_kor/all_for)뿐이라
  //     수동 갱신 시점(2026.06)에 멈춰 있던 것 → Actions 수집으로 전환.
  try {
    const kinds = [['tot', ''], ['kor', 'K'], ['foreign', 'F']];
    const all = {};
    for (const [key, nation] of kinds) {
      const html = await get('https://www.kobis.or.kr/kobis/business/stat/offc/findFormerBoxOfficeList.do?loadEnd=0&searchType=search&sMultiMovieYn=&sRepNationCd=' + nation);
      const items = parseAlltime(html);
      if (items.length >= 10) { all[key] = items; }
      await new Promise(r => setTimeout(r, 400));
    }
    if (all.tot && all.kor && all.foreign) {
      const prev = readJson(ALLTIME, null);
      const next = { generated: genStamp(), tot: all.tot, kor: all.kor, foreign: all.foreign };
      if (!prev || JSON.stringify([prev.tot, prev.kor, prev.foreign]) !== JSON.stringify([all.tot, all.kor, all.foreign])) {
        fs.writeFileSync(ALLTIME, JSON.stringify(next));
        changed = true;
        console.log('역대 저장: ' + ALLTIME + ' (종합 1위 ' + all.tot[0].title + ' / 한국 ' + all.kor[0].title + ' / 외국 ' + all.foreign[0].title + ')');
      } else {
        console.log('역대: 변경 없음');
      }
    } else {
      console.warn('역대: 일부 파싱 실패(' + Object.keys(all).join(',') + ') — 사이트 개편 가능성, 기존 파일 유지');
    }
  } catch (e) { console.warn('역대 수집 실패(경고만): ' + e.message); }

  // ④ Box Office Mojo 세계/미국 (연간 현재연도 + 역대 TOP) — 세계(1103)/미국(1102) 탭용.
  //    Mojo는 한국에서 3~4초 걸려 앱이 수집분을 1순위로 씀. 앱 파서를 그대로 재사용하도록
  //    파싱하지 않고 <div id="table" ~ </main> HTML 조각을 저장 (파서 이중화 방지).
  const year = '' + kstNow().getUTCFullYear();
  const MOJO = [
    { out: 'mojo_world.json', label: '세계', yearUrl: 'https://www.boxofficemojo.com/year/world/' + year + '/', allUrl: 'https://www.boxofficemojo.com/chart/ww_top_lifetime_gross/?area=XWW' },
    { out: 'mojo_usa.json', label: '미국', yearUrl: 'https://www.boxofficemojo.com/year/' + year + '/', allUrl: 'https://www.boxofficemojo.com/chart/top_lifetime_gross/?ref_=bo_cso_ac' },
  ];
  const mojoFragment = (html) => {
    const i = html.indexOf('<div id="table"');
    if (i < 0) return null;
    const j = html.indexOf('</main>', i);
    if (j < 0) return null;
    const frag = html.slice(i, j) + '</main>';
    return (frag.split('<tr>').length >= 15) ? frag : null; // 표 행 개수 검증(개편 감지)
  };
  for (const m of MOJO) {
    try {
      const yearHtml = mojoFragment(await get(m.yearUrl));
      const allHtml = mojoFragment(await get(m.allUrl));
      if (!yearHtml || !allHtml) { console.warn('Mojo ' + m.label + ': 표 조각 추출 실패(개편 가능성) — 기존 파일 유지'); continue; }
      const file = path.join(DIR, m.out);
      const prev = readJson(file, null);
      if (prev && prev.year === year && prev.yearHtml === yearHtml && prev.allHtml === allHtml) {
        console.log('Mojo ' + m.label + ': 변경 없음');
      } else {
        fs.writeFileSync(file, JSON.stringify({ year, generated: genStamp(), yearHtml, allHtml }));
        changed = true;
        console.log('Mojo ' + m.label + ' 저장: ' + file + ' (연간 ' + Math.round(yearHtml.length / 1024) + 'KB + 역대 ' + Math.round(allHtml.length / 1024) + 'KB)');
      }
      await new Promise(r => setTimeout(r, 500));
    } catch (e) { console.warn('Mojo ' + m.label + ' 수집 실패(경고만): ' + e.message); }
  }

  if (changed) {
    fs.writeFileSync(HIST, JSON.stringify(hist));
    console.log('히스토리: ' + HIST + ' (' + Object.keys(hist).length + '일치)');
  }

  // 네트워크로 최신 일간을 못 받았고 이번 실행에서 아무 변경도 없으면 실패 처리(잡 재시도)
  if (netFail && !changed) process.exit(1);
})();
