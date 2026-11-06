// 자동차 수동 데이터(미국 월간·미국 시장 총량·국내 등록·신규등록) 자동화 보조 — collect-car-data 워크플로에서 사용
//  unpack : carbuild/state.enc(암호화 tar.gz) → carbuild/tool/raw/car/ (생성 스크립트의 과거 데이터·월별 캐시)
//  pack   : carbuild/tool/raw/car/의 상태 파일 → state.enc (내용이 바뀐 경우만)
//  publish: carbuild/assets/html/car/data/*.js → data_pub/car/data/*.js.enc (날짜 스탬프 빼고 내용이 바뀐 경우만)
// 암호화 = 앱 콘텐츠와 동일(AES-128-GCM, nonce 12 | 암호문 | tag 16), 키 = env CONTENT_KEY(base64).
// 공개 저장소라 평문 데이터·원본은 절대 커밋하지 않음(carbuild/assets, carbuild/tool/raw, carbuild/.secret는 .gitignore).
'use strict';
const fs = require('fs');
const path = require('path').posix;   // tar에 넘기는 경로를 '/'로 통일(윈도우 로컬 검증 겸용)
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const KEY = Buffer.from(String(process.env.CONTENT_KEY || '').trim(), 'base64');
if (KEY.length !== 16) { console.error('CONTENT_KEY 없음/길이 오류'); process.exit(1); }

const ROOT = 'carbuild';
const RAW = path.join(ROOT, 'tool', 'raw', 'car');
const STATE = path.join(ROOT, 'state.enc');
const OUT = path.join(ROOT, 'assets', 'html', 'car', 'data');
const PUB = path.join('data_pub', 'car', 'data');
// 상태로 보존할 것: 미국 2023년 이전 기록(usa_old.json), 신규등록 월별 API 캐시(datago/*.json)
const STATE_FILES = ['usa_old.json', 'datago'];
const DATA_FILES = ['data_car_usa_month.js', 'data_car_usa_total.js', 'data_car_kor_reg.js', 'data_car_kor_newreg.js'];

function enc(buf) {
  const n = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-128-gcm', KEY, n);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([n, ct, c.getAuthTag()]);
}
function dec(buf) {
  const d = crypto.createDecipheriv('aes-128-gcm', KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]);
}
// 비교용: 생성일·갱신일 스탬프 제거(매 실행 바뀌어 불필요한 커밋을 만들지 않게)
const norm = s => s.replace(/"generated"\s*:\s*"[^"]*"/g, '').replace(/(generated|update)\s*[:=]\s*"[\d.\-: ]*"/gi, '');

const cmd = process.argv[2];
if (cmd === 'unpack') {
  fs.mkdirSync(RAW, { recursive: true });
  const tgz = path.join(ROOT, 'state.tgz');
  fs.writeFileSync(tgz, dec(fs.readFileSync(STATE)));
  execFileSync('tar', ['-xzf', tgz, '-C', RAW]);
  fs.unlinkSync(tgz);
  console.log('상태 복원:', fs.readdirSync(RAW).join(', '));
} else if (cmd === 'pack') {
  // tar 바이트는 시각이 섞여 매번 달라지므로, 파일 내용 해시로 변경 여부 판단
  const hashOf = () => {
    const h = crypto.createHash('sha256');
    const walk = p => { const st = fs.statSync(p); if (st.isDirectory()) fs.readdirSync(p).sort().forEach(f => walk(path.join(p, f))); else { h.update(path.relative(RAW, p)); h.update(fs.readFileSync(p)); } };
    STATE_FILES.forEach(f => { const p = path.join(RAW, f); if (fs.existsSync(p)) walk(p); });
    return h.digest('hex');
  };
  const now = hashOf();
  const hashFile = path.join(ROOT, 'state.sha256');
  const prev = fs.existsSync(hashFile) ? fs.readFileSync(hashFile, 'utf8').trim() : '';
  if (now === prev) { console.log('상태 변경 없음'); process.exit(0); }
  const tgz = path.join(ROOT, 'state.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', RAW, ...STATE_FILES.filter(f => fs.existsSync(path.join(RAW, f)))]);
  fs.writeFileSync(STATE, enc(fs.readFileSync(tgz)));
  fs.unlinkSync(tgz);
  fs.writeFileSync(hashFile, now + '\n');
  console.log('상태 저장:', Math.round(fs.statSync(STATE).size / 1024) + 'KB');
} else if (cmd === 'publish') {
  let n = 0;
  for (const f of DATA_FILES) {
    const src = path.join(OUT, f);
    if (!fs.existsSync(src)) { console.log('생성 안 됨(이전 데이터 유지):', f); continue; }
    const pt = fs.readFileSync(src);
    const dst = path.join(PUB, f + '.enc');
    let old = '';
    try { old = dec(fs.readFileSync(dst)).toString('utf8'); } catch (e) { /* 최초 또는 복호화 실패 → 새로 씀 */ }
    if (old && norm(old) === norm(pt.toString('utf8'))) { console.log('변경 없음:', f); continue; }
    fs.writeFileSync(dst, enc(pt));
    // 자체 검증: 다시 풀어 원문과 같은지
    if (!dec(fs.readFileSync(dst)).equals(pt)) { console.error('검증 실패:', f); process.exit(1); }
    console.log('갱신:', f, Math.round(pt.length / 1024) + 'KB');
    n++;
  }
  console.log('갱신 파일', n);
} else {
  console.error('사용: node tools/car_auto.js unpack|pack|publish');
  process.exit(1);
}
