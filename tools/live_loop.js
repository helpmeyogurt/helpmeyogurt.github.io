// 상주 수집 루프 (collect-live.yml) — GitHub 예약 실행(schedule)이 하루 대부분 누락돼서 만든 것.
//  · 10분 틱(:05,:15,…,:55 UTC)마다 고빈도 수집기를 직접 돌리고 결과를 커밋 1개로 묶어 푸시.
//    직전 커밋도 live 커밋이면 amend → 히스토리 증가 최소, Pages 빌드 ≤ 시간당 6회(한도 10).
//  · 일 단위 수집기는 각 워크플로 파일의 cron을 읽어 제시각에 workflow_dispatch로 깨움.
//  · 약 5시간 20분 돌고 종료. 첫 틱 성공 후 후속 실행을 큐에 올려 두므로(concurrency 대기) 교대 공백 1~2분.
//  · 실패한 수집기는 파일을 원복(이전 데이터 유지)하고, 주기의 1.5배가 지나면 다음 틱에 다시 시도.
//  · live/status.json = 수집기별 마지막 성공/실패 시각(하트비트 겸 진단). 에러 메시지는 키 노출 위험으로 기록 안 함.
//  · 각 수집기 워크플로의 schedule은 폴백으로 남아 있고, live-gate.yml이 이 루프가 건강하면 건너뛰게 함.
//
//   node tools/live_loop.js            # Actions 상주 실행
//   node tools/live_loop.js --selftest # cron/슬롯 로직 자체 점검(네트워크·git 미사용)
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RUN_MINUTES = 320;          // 이 시간이 지나면 다음 틱 후 종료(job timeout 355분 — 최악 틱 길이 여유)
const TICK_EVERY = 10, TICK_AT = 5;
const STATUS_FILE = 'live/status.json';
const SUBJ = 'live: 실시간 스냅샷';
const REPO = process.env.GH_REPO || '';
const SELF_RUN = String(process.env.GITHUB_RUN_ID || '');
const START = Date.now();

// at = 매시 몇 분 틱에 돌지(UTC, TICK_AT 기준 10분 격자). period = 정상 주기(분) — 1.5배 넘게 성공이 없으면 다음 틱에 재시도.
const INLINE = [
  { key: 'news-hot', wf: 'collect-news-hot.yml', at: [5, 15, 25, 35, 45, 55], period: 10, script: 'tools/collect_news_hot.js', args: ['news/hot.json'], files: ['news/hot.json'], tries: 2, timeout: 120 },
  { key: 'weather', wf: 'collect-weather.yml', at: [5, 25, 45], period: 20, script: 'tools/collect_weather.js', args: [], files: ['weather/now.json', 'weather/regions.json'], tries: 2, timeout: 300 },
  { key: 'news-rank', wf: 'collect-news-rank.yml', at: [15, 35, 55], period: 20, script: 'tools/collect_news_rank.js', args: ['news/rank.json'], files: ['news/rank.json'], tries: 2, timeout: 150 },
  { key: 'movie-realtime', wf: 'collect-movie-realtime.yml', at: [5, 25, 45], period: 20, script: 'tools/collect_movie_realtime.js', args: ['movie/realtime_snapshot.json'], files: ['movie/realtime_snapshot.json'], tries: 2, timeout: 150 },
  { key: 'music-now', wf: 'collect-music-now.yml', at: [15, 45], period: 30, script: 'tools/collect_music_now.js', args: ['music/now.json'], files: ['music/now.json'], tries: 2, timeout: 150 },
  { key: 'aladin-now', wf: 'collect-aladin-now.yml', at: [15, 45], period: 30, script: 'tools/collect_aladin_now.js', args: ['book/aladin_now.json'], files: ['book/aladin_now.json'], tries: 2, timeout: 150 },
  { key: 'air', wf: 'collect-air.yml', at: [25, 55], period: 30, script: 'tools/collect_tool_ext.js', args: [], env: { PART: 'air' }, files: ['tool/air.json'], tries: 2, timeout: 180 },
  { key: 'base', wf: 'collect-base.yml', at: [35], period: 60, script: 'tools/collect_base_rates.js', args: ['intrate/base.json'], files: ['intrate/base.json'], tries: 2, timeout: 120 },
  { key: 'play-versions', wf: 'collect-play-versions.yml', at: [5], period: 60, script: 'tools/collect_play_versions.js', args: [], files: ['versions.json'], tries: 2, timeout: 180 },
];
const INLINE_WF = new Set(INLINE.map(c => c.wf).concat(['collect-live.yml']));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
function kst(d = new Date(), fmt = 'full') {
  const k = new Date(d.getTime() + 9 * 3600e3).toISOString();
  return fmt === 'short' ? k.slice(5, 10) + ' ' + k.slice(11, 16) : k.replace('T', ' ').slice(0, 16) + ' KST';
}

function sh(cmd, args, opt = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: (opt.timeout || 120) * 1000, killSignal: 'SIGKILL', env: { ...process.env, ...(opt.env || {}) } });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status, timedOut: r.error && r.error.code === 'ETIMEDOUT' };
}
const git = (...a) => sh('git', a);

// ── cron (분 시 일 월 요일, UTC) ─────────────────────────────────────
function cronField(f, lo, hi) {
  const set = new Set();
  for (const part of f.split(',')) {
    let [range, step] = part.split('/');
    step = step ? +step : 1;
    let a = lo, b = hi;
    if (range !== '*') { const [x, y] = range.split('-'); a = +x; b = y !== undefined ? +y : (step > 1 ? hi : +x); }
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return set;
}
function cronMatch(expr, d) {
  const [mi, ho, dom, mon, dow] = expr.trim().split(/\s+/);
  const dows = cronField(dow, 0, 7); if (dows.has(7)) dows.add(0);
  const domStar = dom === '*', dowStar = dow === '*';
  const dayOk = (domStar || dowStar)
    ? cronField(dom, 1, 31).has(d.getUTCDate()) && dows.has(d.getUTCDay())
    : cronField(dom, 1, 31).has(d.getUTCDate()) || dows.has(d.getUTCDay());
  return cronField(mi, 0, 59).has(d.getUTCMinutes()) && cronField(ho, 0, 23).has(d.getUTCHours())
    && cronField(mon, 1, 12).has(d.getUTCMonth() + 1) && dayOk;
}
function readCrons() {
  const dir = '.github/workflows', out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/^collect-.*\.yml$/.test(f) || INLINE_WF.has(f)) continue;
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of txt.matchAll(/^\s*-\s*cron:\s*'([^']+)'/gm)) out.push({ wf: f, cron: m[1] });
  }
  return out;
}

// ── 상태 파일 ─────────────────────────────────────────────────────
function readStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch { return { collectors: {} }; }
}
function isDue(c, d, st) {
  if (c.at.includes(d.getUTCMinutes())) return true;
  const ok = st.collectors[c.key] && st.collectors[c.key].ok;
  return !ok || (d - new Date(ok)) > c.period * 1.5 * 60e3;   // 실패·교대 공백 보충
}

// ── git ──────────────────────────────────────────────────────────
function sync() {
  const f = git('fetch', '--depth=5', 'origin', 'main');
  if (!f.ok) log('fetch 실패', f.err.slice(0, 200));
  git('reset', '--hard', 'origin/main');
}
function restore(files) {
  for (const f of files) {
    if (git('ls-files', '--error-unmatch', f).ok) git('checkout', 'HEAD', '--', f);
    else if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}
function validJson(files) {
  for (const f of files) {
    if (!f.endsWith('.json') || !fs.existsSync(f)) continue;
    try { JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return false; }
  }
  return true;
}

// 수집 결과(파일 내용)를 들고 최신 origin/main 위에 커밋. 직전이 live 커밋이면 amend(+lease) → 히스토리 1개 유지.
function commitAndPush(saved) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (attempt > 1) {
      sync();
      for (const [f, buf] of saved) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); }
    }
    git('add', '--', ...saved.keys());
    if (git('diff', '--cached', '--quiet').ok) { log('변경 없음'); return true; }
    const base = git('rev-parse', 'HEAD').out;
    const last = git('log', '-1', '--pretty=%s').out;
    const msg = `${SUBJ} ${kst(new Date(), 'short')}`;
    const env = { GIT_AUTHOR_NAME: 'yogurt', GIT_AUTHOR_EMAIL: '60679462+helpmeyogurt@users.noreply.github.com', GIT_COMMITTER_NAME: 'yogurt', GIT_COMMITTER_EMAIL: '60679462+helpmeyogurt@users.noreply.github.com' };
    let push;
    if (last.startsWith(SUBJ)) {
      if (!sh('git', ['commit', '--amend', '--reset-author', '-q', '-m', msg], { env }).ok) continue;
      push = git('push', `--force-with-lease=main:${base}`, 'origin', 'HEAD:main');
    } else {
      if (!sh('git', ['commit', '-q', '-m', msg], { env }).ok) continue;
      push = git('push', 'origin', 'HEAD:main');
    }
    if (push.ok) { log('푸시 완료', msg); return true; }
    log(`푸시 거절(시도 ${attempt})`, push.err.split('\n').slice(-2).join(' ').slice(0, 200));
  }
  return false;
}

// ── 틱 ───────────────────────────────────────────────────────────
function tick(d) {
  sync();
  const st = readStatus();
  st.collectors = st.collectors || {};
  const due = INLINE.filter(c => isDue(c, d, st));
  const touched = new Set([STATUS_FILE]);
  for (const c of due) {
    const args = [c.script, ...c.args];
    const regions = c.key === 'weather' && d.getUTCDay() === 1 && d.getUTCHours() === 3 && d.getUTCMinutes() === 5;
    if (regions) args.push('--regions');
    let ok = false;
    const t0 = Date.now();
    for (let i = 1; i <= c.tries && !ok; i++) {
      const r = sh('node', args, { timeout: regions ? 600 : c.timeout, env: c.env });
      ok = r.ok && validJson(c.files);
      if (!ok) {
        log(`${c.key} 실패(${i}/${c.tries})${r.timedOut ? ' timeout' : r.ok ? ' JSON 오류' : ''}`, (r.err || r.out).split('\n').slice(-2).join(' / ').slice(0, 200));
        restore(c.files);
        if (i < c.tries) spawnSync('sleep', ['15']);
      }
    }
    const s = st.collectors[c.key] || {};
    if (ok) { s.ok = new Date().toISOString(); s.fails = 0; c.files.forEach(f => touched.add(f)); }
    else { s.fail = new Date().toISOString(); s.fails = (s.fails || 0) + 1; }
    s.secs = Math.round((Date.now() - t0) / 1000);
    st.collectors[c.key] = s;
    log(`${c.key} ${ok ? 'ok' : 'FAIL'} ${s.secs}s`);
  }
  st.updated = kst();
  st.run = SELF_RUN;
  fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
  fs.writeFileSync(STATUS_FILE, JSON.stringify(st, null, 1) + '\n');
  const saved = new Map();
  for (const f of touched) if (fs.existsSync(f)) saved.set(f, fs.readFileSync(f));
  return commitAndPush(saved);
}

// ── 일 단위 수집기 깨우기 + 후속 실행 ─────────────────────────────
// dispatch로 생긴 실행만 셈 — 정시에 온 schedule 실행은 live-gate가 건너뛰므로 중복으로 치면 수집이 빠짐
function recentRun(wf, minutes) {
  const r = sh('gh', ['run', 'list', '-R', REPO, '-w', wf, '-e', 'workflow_dispatch', '-L', '1', '--json', 'createdAt', '--jq', '.[0].createdAt // ""']);
  return r.ok && r.out && (Date.now() - new Date(r.out)) < minutes * 60e3;
}
function dispatch(wf) {
  if (recentRun(wf, 10)) { log(`dispatch 생략(10분 내 실행 있음) ${wf}`); return; }
  const r = sh('gh', ['workflow', 'run', wf, '-R', REPO, '--ref', 'main']);
  log(`dispatch ${wf} ${r.ok ? 'ok' : 'FAIL ' + r.err.slice(0, 150)}`);
}
function ensureSuccessor() {
  const r = sh('gh', ['run', 'list', '-R', REPO, '-w', 'collect-live.yml', '-L', '10', '--json', 'databaseId,status',
    '--jq', `[.[]|select(.status!="completed" and (.databaseId|tostring)!="${SELF_RUN}")]|length`]);
  if (r.ok && +r.out > 0) return;
  const d = sh('gh', ['workflow', 'run', 'collect-live.yml', '-R', REPO, '--ref', 'main']);
  log(`후속 실행 등록 ${d.ok ? 'ok' : 'FAIL ' + d.err.slice(0, 150)}`);
}

async function main() {
  log(`live loop start run=${SELF_RUN}`);
  const floorMin = t => Math.floor(t / 60e3) * 60e3;
  let lastChecked = floorMin(Date.now()) - 6 * 60e3;   // 교대 공백 동안 놓친 dispatch 보충(중복은 recentRun이 거름)
  let nextTick = Date.now();                            // 시작하자마자 1회(밀린 수집기만 isDue로 돎)
  let successorAt = 0, ticks = 0;
  for (;;) {
    const now = Date.now();
    const crons = readCrons();
    for (let t = lastChecked + 60e3; t <= floorMin(now); t += 60e3) {
      const d = new Date(t);
      for (const c of crons) if (cronMatch(c.cron, d)) dispatch(c.wf);
    }
    lastChecked = floorMin(now);

    if (now >= nextTick) {
      const d = new Date(floorMin(now));
      try { tick(d); ticks++; } catch (e) { log('tick 예외', String(e).slice(0, 200)); }
      const m = new Date(), k = (TICK_EVERY + TICK_AT - (m.getUTCMinutes() % TICK_EVERY)) % TICK_EVERY || TICK_EVERY;
      nextTick = floorMin(m.getTime()) + k * 60e3;
      if ((Date.now() - START) / 60e3 >= RUN_MINUTES) break;
    }
    if (ticks > 0 && Date.now() >= successorAt) { ensureSuccessor(); successorAt = Date.now() + 30 * 60e3; }
    await sleep(Math.max(1000, Math.min(nextTick, floorMin(Date.now()) + 60e3) - Date.now() + 2000));
  }
  ensureSuccessor();
  log(`live loop end ticks=${ticks}`);
}

function selftest() {
  const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
  const D = s => new Date(s + 'Z');
  assert(cronMatch('2-59/5 * * * *', D('2026-11-06T10:07:00')), 'range/step 7');
  assert(!cronMatch('2-59/5 * * * *', D('2026-11-06T10:05:00')), 'range/step 5 미일치');
  assert(cronMatch('17 3 * * 1', D('2026-11-02T03:17:00')), '월요일 03:17');
  assert(!cronMatch('17 3 * * 1', D('2026-11-03T03:17:00')), '화요일 미일치');
  assert(cronMatch('35 20 * * 0,3', D('2026-11-08T20:35:00')), '일요일 목록');
  assert(cronMatch('25,55 * * * *', D('2026-11-06T00:55:00')), '목록 55');
  assert(cronMatch('5 4 * * *', D('2026-11-06T04:05:00')) && !cronMatch('5 4 * * *', D('2026-11-06T05:05:00')), '시 고정');
  const st = { collectors: { 'music-now': { ok: '2026-11-06T10:00:00Z' } } };
  const music = INLINE.find(c => c.key === 'music-now');
  assert(!isDue(music, D('2026-11-06T10:25:00'), st), 'music 25분 슬롯 아님·최근 성공');
  assert(isDue(music, D('2026-11-06T10:45:00'), st), 'music 45분 슬롯');
  assert(isDue(music, D('2026-11-06T10:55:00'), st), 'music 55분 = 성공 후 55분 경과 → 보충');
  assert(isDue(INLINE.find(c => c.key === 'base'), D('2026-11-06T10:15:00'), st), '상태 없음 → 즉시');
  for (const c of INLINE) assert(c.at.every(m => m % TICK_EVERY === TICK_AT), `${c.key} 슬롯이 틱 격자 위`);
  const crons = readCrons();
  assert(crons.length > 20 && !crons.some(c => INLINE_WF.has(c.wf)), `일 단위 cron ${crons.length}개, 인라인 제외`);
  for (const c of INLINE) assert(fs.existsSync(c.script) && fs.existsSync('.github/workflows/' + c.wf), `${c.key} 스크립트·워크플로 존재`);
}

if (require.main !== module) module.exports = { INLINE, tick, sync, commitAndPush, readStatus };
else if (process.argv.includes('--selftest')) selftest();
else main().catch(e => { console.error(e); process.exit(1); });
