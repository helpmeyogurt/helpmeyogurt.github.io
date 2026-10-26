// music(음원차트끝판왕) 차트 수집기 — GitHub Actions 매일 실행. 키 불필요.
//  · 소스가 무겁고 페이지당 수백 KB 크롤이라 앱에서 느림 → 미리 파싱해 작은 JSON 제공, 앱은 1fetch.
//  · 파싱 규칙은 앱 렌더러(ygt_culture_music.js)와 동일 split — 사이트 개편 시 여기만 수정.
//  · 수집 대상 (실시간 차트는 별도 collect_music_now.js — 30분 크론):
//    - 멜론: HOT100/일간/주간/월간 (+좋아요 수 API)
//    - 지니: 일간/주간/월간 (1~100위 = 2페이지)
//    - 벅스: 일간/주간
//    - 써클: 스트리밍/다운로드/앨범 × 주간/월간 (기간 옵션 목록 + 최신 기간 차트)
//  · 출력: music/charts.json {dateKey, generated, melon:{hot|day|week|month:{date,items}},
//    genie:{day|week|month}, bugs:{day|week}, circle:{stream|down|album:{week|month:{label,options,items}}}}
//  · 부분 실패 = 해당 소스만 기존 값 유지. --if-missing: 오늘 수집분 있으면 스킵.
//
// 사용: node collect_music_charts.js [출력파일=music/charts.json] [--if-missing]
'use strict';
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const qs = require('querystring');

const _args = process.argv.slice(2);
const OUT = _args.filter(a => !a.startsWith('--'))[0] || 'music/charts.json';
const IF_MISSING = _args.includes('--if-missing');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function req(url, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = opts.form ? qs.stringify(opts.form) : null;
    const r = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: body ? 'POST' : 'GET',
      headers: Object.assign(
        { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'ko' },
        body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {},
        opts.headers || {}),
      timeout: 30000,
    }, (res) => {
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location && !opts._redir) {
        res.resume();
        return resolve(req(new URL(res.headers.location, url).href, Object.assign({}, opts, { _redir: 1 })));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' ' + u.hostname)); }
      const ch = [];
      res.on('data', c => ch.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(ch);
        const enc = res.headers['content-encoding'];
        try {
          if (enc === 'gzip') resolve(zlib.gunzipSync(buf).toString('utf8'));
          else if (enc === 'deflate') resolve(zlib.inflateSync(buf).toString('utf8'));
          else if (enc === 'br') resolve(zlib.brotliDecompressSync(buf).toString('utf8'));
          else resolve(buf.toString('utf8'));
        } catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    r.on('timeout', function () { r.destroy(new Error('timeout ' + u.hostname)); });
    if (body) r.write(body);
    r.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
function dateKey() { const d = kstNow(); const p = n => (n < 10 ? '0' : '') + n; return '' + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()); }
function genStamp() { const d = kstNow(); const p = n => (n < 10 ? '0' : '') + n; return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' KST'; }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }

// ---------------------------------------------------------------- 멜론 (앱 melonParser와 동일 split)
const MELON = {
  hot: { url: 'https://www.melon.com/chart/hot100/index.htm', dateKind: 'hour' },
  day: { url: 'https://www.melon.com/chart/day/index.htm', dateKind: 'year' },
  week: { url: 'https://www.melon.com/chart/week/index.htm', dateKind: 'yyyymmdd' },
  month: { url: 'https://www.melon.com/chart/month/index.htm', dateKind: 'yyyymmdd' },
};
function melonItems(html) {
  const result = html.split('<tr class="');
  const items = [];
  for (let i = 1; i < 101; i++) {
    items.push({
      no: result[i].split('data-song-no="')[1].split('">')[0].trim(),
      like: '0',
      img: result[i].split('"60" src="')[1].split('"')[0],
      rank: result[i].split('<span class="rank ">')[1].split('</span>')[0].trim(),
      updown: result[i].split('bullet_icons rank_')[1].split('">')[0].trim(),
      udnum: result[i].split('bullet_icons rank_')[1].split('">')[3].split('<')[0],
      title: result[i].split('<a href="javascript:melon.play.playSong')[1].split('">')[1].split('<')[0].trim(),
      name: result[i].split('<a href="/artist/detail.htm?artistId=')[1].split('">')[1].split('<')[0].trim(),
    });
  }
  return items;
}
function melonDate(html, kind) {
  if (kind === 'hour') return html.split('<span class="year">')[1].split('</span>')[0] + '&nbsp;&nbsp;&nbsp;' + html.split('<span class="hour">')[1].split('</span>')[0];
  if (kind === 'year') return html.split('<span class="year">')[1].split('</span>')[0];
  return html.split('<span class="yyyymmdd">')[1].split('</span>')[0];
}
async function melonLikes(items) {
  const noSum = items.map(it => it.no).join('%2C');
  try {
    const j = JSON.parse(await req('https://www.melon.com/commonlike/getSongLike.json?contsIds=' + noSum));
    for (let i = 0; i < items.length; i++) items[i].like = String((j.contsLike[i] || {}).SUMMCNT || 0);
  } catch (e) { console.error('  멜론 좋아요 실패(0 유지): ' + e.message); }
  return items;
}
async function collectMelon() {
  const out = {};
  for (const kind of Object.keys(MELON)) {
    const html = await req(MELON[kind].url);
    const items = await melonLikes(melonItems(html));
    if (items.length < 50) throw new Error('melon ' + kind + ': 목록 부족');
    out[kind] = { date: melonDate(html, MELON[kind].dateKind), items };
    await sleep(500);
  }
  return out;
}

// ---------------------------------------------------------------- 지니 (앱 genieParser/genieParser2와 동일 split)
const GENIE = { day: 'D&rtm=N', week: 'W&rtm=N', month: 'M&rtm=N' };
function genieItems(html, marker, endMarker) {
  let result = html.split(marker)[1];
  if (endMarker) result = result.split(endMarker)[0];
  result = result.split('<tr class="list"');
  const items = [];
  for (let i = 1; i < 51; i++) {
    items.push({
      img: 'http:' + result[i].split('src="')[1].split('"')[0],
      rank: result[i].split('<td class="number">')[1].split('<span class="rank">')[0].trim(),
      updown: result[i].split('class="rank-')[1].split('">')[0].trim(),
      udnum: result[i].split('class="rank-')[1].split('">')[1].split('<')[0],
      title: result[i].split('class="title')[1].split('">')[1].split('<')[0].trim(),
      name: result[i].split('class="artist')[1].split('">')[1].split('<')[0].trim(),
    });
  }
  return items;
}
async function collectGenieKind(ditc) {
  const p1 = await req('https://www.genie.co.kr/chart/top200?ditc=' + ditc + '&pg=1');
  const items = genieItems(p1, '<caption>곡 리스트</caption>', '<!--// LIST -->');
  await sleep(400);
  const p2 = await req('https://www.genie.co.kr/chart/top200?ditc=' + ditc + '&pg=2');
  const items2 = genieItems(p2, '<div class="music-list-wrap">', '<hr class="hide" />');
  const date = p2.split('id="curDateComma" value="')[1].split('"')[0];
  const all = items.concat(items2);
  if (all.length < 60) throw new Error('genie: 목록 부족');
  return { date, items: all };
}
async function collectGenie() {
  const out = {};
  for (const kind of Object.keys(GENIE)) {
    out[kind] = await collectGenieKind(GENIE[kind]);
    await sleep(500);
  }
  return out;
}

// ---------------------------------------------------------------- 벅스 (앱 bugsParser와 동일 split)
const BUGS = { day: 'https://music.bugs.co.kr/chart/track/day/total', week: 'https://music.bugs.co.kr/chart/track/week/total' };
function bugsItems(html) {
  const result = html.split('<tr albumId=');
  const items = [];
  for (let i = 1; i < 101; i++) {
    items.push({
      img: result[i].split('<img src="')[1].split('"')[0],
      rank: result[i].split('<strong>')[1].split('</strong>')[0].trim(),
      updown: result[i].split('class="change ')[1].split('"')[0],
      udnum: result[i].split('class="change ')[1].split('<em>')[1].split('</em>')[0],
      title: result[i].split('track_title="')[1].split('"')[0].trim(),
      name: result[i].split('artist_disp_nm="')[1].split('"')[0].trim(),
    });
  }
  return items;
}
async function collectBugs() {
  const out = {};
  for (const kind of Object.keys(BUGS)) {
    const html = await req(BUGS[kind]);
    const items = bugsItems(html);
    if (items.length < 50) throw new Error('bugs ' + kind + ': 목록 부족');
    out[kind] = { date: html.split('<time datetime="')[1].split('>')[1].split('<')[0].trim(), items };
    await sleep(500);
  }
  return out;
}

// ---------------------------------------------------------------- 써클 (앱 selectParser/circleParser와 동일)
const CIRCLE = {
  stream: { page: 'https://circlechart.kr/page_chart/onoff.circle?serviceGbn=S1040&termGbn=', api: 'https://circlechart.kr/data/api/chart/onoff', service: 'S1040', curl: 'circlechart.kr%2Fpage_chart%2Fonoff.circle' },
  down: { page: 'https://circlechart.kr/page_chart/onoff.circle?serviceGbn=S1020&termGbn=', api: 'https://circlechart.kr/data/api/chart/onoff', service: 'S1020', curl: 'circlechart.kr%2Fpage_chart%2Fonoff.circle' },
  album: { page: 'https://circlechart.kr/page_chart/album.circle?serviceGbn=&termGbn=', api: 'https://circlechart.kr/data/api/chart/album', service: '', curl: 'circlechart.kr%2Fpage_chart%2Falbum.circle' },
};
function circleOptions(html, term) {
  const end = term === 'week' ? '<option value="201016"' : '<option value="201003"';
  return html.split('Date Select</option>')[1].split(end)[0];
}
async function collectCircleKind(cfg, key, term) {
  const html = await req(cfg.page + term);
  const options = circleOptions(html, term);
  const first = /<option value="(\d+)"/.exec(options);
  if (!first) throw new Error('circle ' + key + ' ' + term + ': 기간 옵션 없음');
  const curVal = first[1];
  const year = curVal.substring(0, 4), time = curVal.substring(4);
  const j = JSON.parse(await req(cfg.api, { form: { nationGbn: 'T', serviceGbn: cfg.service, termGbn: term, hitYear: year, targetTime: time, yearTime: '3', curUrl: cfg.curl } }));
  const items = [];
  for (let i = 0; i < j.FormToMap.PageSize; i++) {
    const L = j.List[i];
    const o = { name: L.ARTIST_NAME, album: L.ALBUM_NAME, rank: L.SERVICE_RANKING, updown: L.RankStatus, udnum: L.RankChange };
    if (key === 'album') { o.title = L.ALBUM_NAME; o.img = L.FILE_NAME; if (L.Album_CNT !== '') o.count = L.Album_CNT; }
    else { o.title = L.SONG_NAME; o.img = L.ALBUMIMG; if (L.ROW_CNT !== '') o.count = L.ROW_CNT; }
    items.push(o);
  }
  if (items.length < 30) throw new Error('circle ' + key + ' ' + term + ': 목록 부족(' + items.length + ')');
  const label = term === 'week' ? year + '년 ' + time + '주' : year + '년 ' + time + '월';
  return { curVal, label, options, items };
}
async function collectCircle() {
  const out = {};
  for (const key of Object.keys(CIRCLE)) {
    out[key] = {};
    for (const term of ['week', 'month']) {
      out[key][term] = await collectCircleKind(CIRCLE[key], key, term);
      await sleep(500);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 신곡 (멜론 신곡 + 지니 최신곡 — 아티스트 찜 알림·신곡 탭용)
async function collectNewest() {
  const out = {};
  // 멜론 신곡 (마크업이 차트와 다름 — goSongDetail 기준 분할, rank02에서 아티스트)
  {
    const html = await req('https://www.melon.com/new/index.htm');
    const rows = html.split('<a href="javascript:melon.link.goSongDetail(');
    const items = [];
    for (let i = 1; i < rows.length; i++) {
      try {
        const no = rows[i].split("'")[1];
        const title = rows[i].split('<a href="javascript:melon.play.playSong')[1].split('">')[1].split('<')[0].trim();
        const name = /rank02">[\s\S]*?>([^<]+)<\/a>/.exec(rows[i])[1].trim();
        const img = rows[i - 1].split('"60" src="').pop().split('"')[0];
        if (title && name) items.push({ no, title, name, img });
      } catch (e) { /* 스킵 */ }
    }
    if (items.length < 20) throw new Error('melon 신곡: 목록 부족(' + items.length + ')');
    out.melon = { items };
  }
  await sleep(500);
  // 지니 최신곡 (title/artist가 attr·텍스트 혼합 — 첫 > 이후 텍스트)
  {
    const html = await req('https://www.genie.co.kr/newest/song');
    const rows = html.split('<tr class="list"');
    const items = [];
    for (let i = 1; i < rows.length; i++) {
      try {
        const title = rows[i].split('class="title')[1].split('>')[1].split('<')[0].trim();
        const name = rows[i].split('class="artist')[1].split('>')[1].split('<')[0].trim();
        let img = rows[i].split('src="')[1].split('"')[0];
        if (img.indexOf('//') === 0) img = 'https:' + img;
        if (title && name) items.push({ title, name, img });
      } catch (e) { /* 스킵 */ }
    }
    if (items.length < 15) throw new Error('genie 신곡: 목록 부족(' + items.length + ')');
    out.genie = { items };
  }
  return out;
}

// ---------------------------------------------------------------- 빌보드 직접 수집 (HOT100/BB200)
// 원본 미러(KoreanThinker/billboard-json)는 2026-08-19 GitHub 차단으로 소멸 —
// 우리 파일이 2026-08-18 스냅샷에 멈춰 있었음(상위권 이미지 공백도 그 스냅샷의 결함).
// → billboard.com 차트 페이지(서버렌더)를 직접 파싱, 기존과 같은 JSON 형식으로 저장(앱 무변경).
//   일부 지역/봇판정 시 행 없는 셸 HTML이 올 수 있음 → 행수 미달이면 기존 파일 유지,
//   HOT100은 mhollingshead/billboard-hot-100 JSON 폴백(이미지는 기존 파일에서 승계).
const BB_CHARTS = [
  { slug: 'hot-100', file: 'billboard/hot100.json', min: 90 },
  { slug: 'billboard-200', file: 'billboard/bb200.json', min: 150 },
];
function bbDecode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}
function bbParseChart(html) {
  // 발표일: "Week of October 25, 2026"
  let date = '';
  const dm = html.match(/Week of\s+([A-Za-z]+\.?\s+\d{1,2},\s+\d{4})/);
  if (dm) {
    const d = new Date(dm[1].replace('.', ''));
    if (!isNaN(d)) { const p = n => (n < 10 ? '0' : '') + n; date = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  }
  const rows = html.split('o-chart-results-list-row-container');
  const data = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    try {
      const t = r.split('id="title-of-a-story"')[1];
      const name = bbDecode(t.slice(t.indexOf('>') + 1).split('<')[0]);
      if (!name) continue;
      const after = t.slice(t.indexOf('</h3>'));
      const am = after.match(/<span class="c-label[^"]*"[^>]*>([^<]+)</);
      const artist = bbDecode(am ? am[1] : '');
      // 앨범아트: 행 내 첫 이미지 (lazy-src 우선 — 상위권 즉시로딩은 src에 직접)
      let image = '';
      const im = r.match(/data-lazy-src="(https:[^"]+)"/) || r.match(/<img[^>]+src="(https:\/\/charts-static\.billboard\.com[^"]+)"/);
      if (im) image = im[1];
      // 숫자 토큰 등장 순서 = [순위, LW, Peak, Weeks, (상세패널 반복...)] — 앞 4개만
      const nums = [];
      const re = /<span class="c-label[^"]*"[^>]*>\s*([0-9]{1,3}|-)\s*</g;
      let m2; while ((m2 = re.exec(r)) && nums.length < 4) nums.push(m2[1]);
      const n = v => (v === '-' || v == null) ? 0 : +v;
      data.push({
        name, artist, image,
        rank: data.length + 1,
        last_week_rank: n(nums[1]), peak_rank: n(nums[2]), weeks_on_chart: n(nums[3]),
      });
    } catch (e) { /* 행 구조가 다르면 스킵 */ }
  }
  return { date, data };
}
async function mirrorBillboard(baseDir) {
  for (const c of BB_CHARTS) {
    const dest = path.join(baseDir, c.file);
    const prev = readJson(dest);
    try {
      const html = await req('https://www.billboard.com/charts/' + c.slug + '/');
      const chart = bbParseChart(html);
      if (chart.data.length < c.min) throw new Error('행 ' + chart.data.length + '건(<' + c.min + ') — 셸 응답/개편 가능성');
      if (!chart.date) chart.date = (prev && prev.date) || '';
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, JSON.stringify(chart));
      const noImg = chart.data.filter(d => !d.image).length;
      console.log('빌보드 ' + c.slug + ': ' + chart.data.length + '건 (' + chart.date + (noImg ? ', 이미지 공백 ' + noImg + '건' : '') + ')');
    } catch (e) {
      console.error('빌보드 ' + c.slug + ' 수집 실패: ' + e.message);
      if (c.slug === 'hot-100') {
        // 폴백: mhollingshead JSON(이미지 없음) — 이미지는 기존 파일에서 곡+가수 키로 승계
        try {
          const j = JSON.parse(await req('https://raw.githubusercontent.com/mhollingshead/billboard-hot-100/main/recent.json'));
          if (!j || !j.data || j.data.length < 90) throw new Error('폴백 데이터 부족');
          const imgByKey = {};
          if (prev && prev.data) for (const d of prev.data) imgByKey[d.name + '|' + d.artist] = d.image || '';
          const chart = {
            date: j.date,
            data: j.data.map(s => ({
              name: s.song, artist: s.artist, image: imgByKey[s.song + '|' + s.artist] || '',
              rank: s.this_week, last_week_rank: s.last_week || 0, peak_rank: s.peak_position || 0, weeks_on_chart: s.weeks_on_chart || 0,
            })),
          };
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, JSON.stringify(chart));
          console.log('빌보드 hot-100: mhollingshead 폴백 ' + chart.data.length + '건 (' + chart.date + ')');
        } catch (e2) { console.error('빌보드 hot-100 폴백도 실패(기존 유지): ' + e2.message); }
      } else {
        console.error('빌보드 ' + c.slug + ': 기존 파일 유지');
      }
    }
    await sleep(300);
  }
}

// ---------------------------------------------------------------- 공유 (collect_music_now.js가 require)
module.exports = { req, sleep, kstNow, dateKey, genStamp, melonItems, melonDate, melonLikes, genieItems, bugsItems, bbParseChart, mirrorBillboard };

// ----------------------------------------------------------------
if (require.main === module) (async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const prev = readJson(OUT);
  const today = dateKey();
  if (IF_MISSING && prev && prev.dateKey === today) { console.log('오늘 이미 수집됨 — 스킵(--if-missing)'); return; }

  const out = { dateKey: today, generated: genStamp() };
  const jobs = [['melon', collectMelon], ['genie', collectGenie], ['bugs', collectBugs], ['circle', collectCircle], ['newest', collectNewest]];
  let okCount = 0;
  for (const [name, fn] of jobs) {
    try {
      out[name] = await fn();
      const n = Object.keys(out[name]).map(k => k + (out[name][k].items ? '=' + out[name][k].items.length : '')).join(', ');
      console.log(name + ': ' + n);
      okCount++;
    } catch (e) {
      console.error(name + ' 실패(기존 값 유지): ' + e.message);
      if (prev && prev[name]) out[name] = prev[name];
    }
    await sleep(500);
  }
  if (!okCount) { console.error('전 소스 실패 — 기존 파일 유지'); process.exit(1); }
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('저장: ' + OUT + ' (' + Math.round(fs.statSync(OUT).size / 1024) + 'KB)');
  await mirrorBillboard(path.dirname(OUT));
})().catch(e => { console.error('수집 실패: ' + e.message); process.exit(1); });
