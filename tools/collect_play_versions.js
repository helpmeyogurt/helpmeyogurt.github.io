// 구글플레이 라이브 버전 수집 → versions.json (yogurthelp.me/versions.json).
//  · 27개 앱을 스토어 페이지에서 크롤, AF_initDataCallback 블롭의 [[["x.y.z"]]] 패턴으로 버전 추출.
//  · target = 우리 빌드 목표 버전(build.gradle.kts flavorVersions). ⚠ gradle bump 시 아래 APPS의
//    target도 같이 갱신할 것(수동 — 이 저장소는 flutter repo를 못 읽음). 없으면 비교만 부정확, 크롤은 정상.
//  · GitHub Actions collect-play-versions.yml 이 매시 실행. HTML(version.html)이 fetch해서 표로 렌더.
'use strict';
const https = require('https');
const fs = require('fs');

// 앱 목록(pkg·한글명) + target(우리 버전). flutter repo build.gradle.kts에서 추출(2026-09-14).
const APPS = [
  { key: 'weather', name: '날씨끝판왕', pkg: 'me.yogurthelp.weather', target: '5.1.0' },
  { key: 'news', name: '뉴스끝판왕', pkg: 'me.yogurthelp.news', target: '5.0.7' },
  { key: 'tel', name: '전화번호끝판왕', pkg: 'me.yogurthelp.tel', target: '3.7.0' },
  { key: 'intrate', name: '금리끝판왕', pkg: 'me.yogurthelp.intrate', target: '5.0.0' },
  { key: 'dep', name: '예금금리끝판왕', pkg: 'me.yogurthelp.dep', target: '5.0.0' },
  { key: 'loan', name: '대출금리끝판왕', pkg: 'me.yogurthelp.loan', target: '5.0.0' },
  { key: 'finance', name: '금융끝판왕', pkg: 'me.yogurthelp.finance', target: '5.0.5' },
  { key: 'stock', name: '주가지수끝판왕', pkg: 'me.yogurthelp.stock', target: '5.0.5' },
  { key: 'exchange', name: '환율끝판왕', pkg: 'me.yogurthelp.exchange', target: '5.0.5' },
  { key: 'realtytrade', name: '실거래가끝판왕', pkg: 'me.yogurthelp.realtytrade', target: '5.0.5' },
  { key: 'realtyprice', name: '공시가격끝판왕', pkg: 'me.yogurthelp.realtyprice', target: '5.0.5' },
  { key: 'realtycal', name: '부동산계산기끝판왕', pkg: 'me.yogurthelp.realtycal', target: '5.0.5' },
  { key: 'realtydata', name: '부동산정보끝판왕', pkg: 'me.yogurthelp.realtydata', target: '5.0.6' },
  { key: 'law', name: '법률정보끝판왕', pkg: 'me.yogurthelp.law', target: '5.0.1' },
  { key: 'salary', name: '월급계산기끝판왕', pkg: 'me.yogurthelp.salary', target: '5.0.5' },
  { key: 'tax', name: '세금정보끝판왕', pkg: 'me.yogurthelp.tax', target: '5.0.2' },
  { key: 'phone', name: '휴대폰끝판왕', pkg: 'me.yogurthelp.phone', target: '5.0.0' },
  { key: 'phonemem', name: '휴대폰멤버십끝판왕', pkg: 'me.yogurthelp.phonemem', target: '3.7.1' },
  { key: 'car', name: '자동차순위끝판왕', pkg: 'me.yogurthelp.car', target: '5.0.5' },
  { key: 'movie', name: '박스오피스끝판왕', pkg: 'me.yogurthelp.movie', target: '5.0.6' },
  { key: 'tv', name: '시청률끝판왕', pkg: 'me.yogurthelp.tv', target: '5.0.5' },
  { key: 'music', name: '음원차트끝판왕', pkg: 'me.yogurthelp.music', target: '5.0.5' },
  { key: 'book', name: '베스트셀러끝판왕', pkg: 'me.yogurthelp.book', target: '5.0.5' },
  { key: 'perform', name: '공연순위끝판왕', pkg: 'me.yogurthelp.perform', target: '5.0.5' },
  { key: 'tool', name: '도구모음끝판왕', pkg: 'me.yogurthelp.tool', target: '5.0.0' },
  { key: 'election', name: '선거끝판왕', pkg: 'me.yogurthelp.election', target: '3.8.3' },
  { key: 'tour', name: '여행끝판왕', pkg: 'me.yogurthelp.tour', target: '5.0.6' },
];

function get(url) {
  return new Promise((resolve) => {
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36' },
      timeout: 20000,
    }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', () => resolve({ status: 'ERR', body: '' }))
      .on('timeout', function () { this.destroy(); resolve({ status: 'TO', body: '' }); });
  });
}
function extractVersion(html) { const m = html.match(/\[\[\["(\d+(?:\.\d+)+)"\]\]/); return m ? m[1] : null; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function kstStamp() { return new Date(Date.now() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16) + ' KST'; }
function cmp(a, b) {
  if (!a || !b) return 0;
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
}

(async () => {
  const out = [];
  for (const a of APPS) {
    let play = null, note = '';
    for (let attempt = 0; attempt < 3 && !play; attempt++) {
      if (attempt) await sleep(2500);
      const r = await get(`https://play.google.com/store/apps/details?id=${a.pkg}&hl=ko&gl=kr`);
      if (r.status === 200) { play = extractVersion(r.body); if (!play) note = '버전 패턴 미검출'; }
      else if (r.status === 404) { note = '스토어에 없음(404)'; break; }
      else note = 'HTTP ' + r.status;
    }
    let status = 'unknown';
    if (play) status = (play === a.target) ? 'same' : (cmp(a.target, play) > 0 ? 'local_ahead' : 'market_ahead');
    out.push({ key: a.key, name: a.name, pkg: a.pkg, target: a.target, play, note, status });
    console.log(`  ${a.key.padEnd(12)} target ${String(a.target).padEnd(7)} play ${String(play || '—').padEnd(7)} ${status}`);
    await sleep(400);
  }
  const okCount = out.filter(o => o.play).length;
  fs.writeFileSync('versions.json', JSON.stringify({ generated: kstStamp(), okCount, total: out.length, apps: out }, null, 1));
  console.log(`\nversions.json: ${okCount}/${out.length}개 조회 (생성 ${kstStamp()})`);
})();
