// 기준금리 시간별 수집 — GitHub Actions 1시간 주기 (0401).
//  · 한국: 한국은행 변경 이력 표 크롤 / 미국: FRED DFEDTARU(연방기금 목표 상단) 변경점.
//  · 값·dateKey가 기존 파일과 동일하면 저장 생략(무변경 커밋 방지) — 금리 변경/날짜 변경 시에만 커밋됨.
//  · 출력: intrate/base.json {dateKey, kor:[{year,date,int,udico,udnum}...], usa:[...]}
//
// 사용: FRED_KEY=<키> node collect_base_rates.js [출력파일=intrate/base.json]
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2] || 'intrate/base.json';
let FRED_KEY = (process.env.FRED_KEY || '').trim();
if (!FRED_KEY) {
  try { FRED_KEY = fs.readFileSync(path.resolve(__dirname, '../../.secret/fred_api_key.txt'), 'utf8').trim(); } catch (e) {}
}

function get(url) {
  return new Promise((resolve, reject) => {
    const r = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' }, timeout: 45000 }, (res) => {
      const ch = [];
      res.on('data', c => ch.push(c));
      res.on('end', () => resolve(Buffer.concat(ch).toString('utf8')));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
  });
}

function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
const p2 = n => (n < 10 ? '0' : '') + n;
function dateKey() { const d = kstNow(); return '' + d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()); }

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const out = { dateKey: dateKey() };

  { // 한국
    const html = await get('https://www.bok.or.kr/portal/singl/baseRate/list.do?dataSeCd=01&menuNo=200643');
    const tb = html.split('<tbody>')[1].split('</tbody>')[0];
    const rows = [];
    for (const tr of (tb.match(/<tr[\s\S]*?<\/tr>/g) || [])) {
      const tds = (tr.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || []).map(t => t.replace(/<[^>]+>/g, '').trim());
      if (tds.length >= 3 && /^\d{4}$/.test(tds[0])) rows.push({ year: tds[0], date: tds[1], int: parseFloat(tds[2]).toFixed(2) });
    }
    for (let i = 0; i < rows.length; i++) {
      const prev = rows[i + 1];
      const diff = prev ? (parseFloat(rows[i].int) - parseFloat(prev.int)) : 0;
      rows[i].udico = diff > 0 ? '상승' : (diff < 0 ? '하락' : '유지');
      rows[i].udnum = Math.abs(diff).toFixed(2);
    }
    if (rows.length < 20) throw new Error('한국 파싱 부족: ' + rows.length);
    out.kor = rows;
  }

  { // 미국
    if (!FRED_KEY) throw new Error('FRED_KEY 미설정');
    const j = JSON.parse(await get('https://api.stlouisfed.org/fred/series/observations?series_id=DFEDTARU&api_key=' + FRED_KEY + '&file_type=json&observation_start=2008-12-01'));
    const obs = (j.observations || []).filter(o => o.value !== '.');
    const rows = [];
    let last = null;
    for (const o of obs) {
      const v = parseFloat(o.value);
      if (last === null || v !== last) {
        const diff = last === null ? 0 : v - last;
        rows.unshift({
          year: o.date.slice(0, 4), date: o.date.slice(5, 7) + '월 ' + o.date.slice(8, 10) + '일',
          intlow: (v - 0.25).toFixed(2) + '~', int: v.toFixed(2),
          udico: diff > 0 ? '상승' : (diff < 0 ? '하락' : '유지'), udnum: Math.abs(diff).toFixed(2),
        });
        last = v;
      }
    }
    if (rows.length < 20) throw new Error('미국 파싱 부족: ' + rows.length);
    out.usa = rows;

    // FRED 지연 대비: FRED 일별 시계열은 FOMC 결정 당일을 하루쯤 늦게 반영한다.
    // 기존 파일의 최신 변경점이 FRED 최신보다 더 최근이면(=수동 선반영分) 보존해,
    // 다음 실행이 그 항목을 지우지 않도록 한다. FRED가 따라잡으면 자연 수렴.
    const usaKey = r => { const m = (r.date || '').match(/(\d+)월\s*(\d+)일/); return m ? (parseInt(r.year) * 10000 + parseInt(m[1]) * 100 + parseInt(m[2])) : 0; };
    if (fs.existsSync(OUT)) {
      try {
        const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
        if (prev.usa && prev.usa.length && out.usa.length && usaKey(prev.usa[0]) > usaKey(out.usa[0])) {
          console.log('미국: 기존 최신 변경점(' + prev.usa[0].date + ' ' + prev.usa[0].int + '%)이 FRED보다 최신 — 보존');
          out.usa = prev.usa;
        }
      } catch (e) { /* 무시 */ }
    }
  }

  // 무변경이면 저장 생략 (커밋 폭증 방지) — dateKey가 바뀌면 하루 1회는 저장(신선도 유지)
  if (fs.existsSync(OUT)) {
    try {
      const old = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      if (old.dateKey === out.dateKey && JSON.stringify(old.kor) === JSON.stringify(out.kor) && JSON.stringify(old.usa) === JSON.stringify(out.usa)) {
        console.log('변경 없음 — 저장 생략');
        return;
      }
    } catch (e) { /* 파손 시 재저장 */ }
  }

  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('저장: ' + OUT + ' (한국 ' + out.kor.length + '행 최신 ' + out.kor[0].int + '% / 미국 ' + out.usa.length + '행 최신 ' + out.usa[0].int + '%)');
})().catch(e => { console.error('수집 실패: ' + e.message); process.exit(1); });
