// 평문 데이터 파일 → 앱 콘텐츠 키로 암호화한 원격 데이터(data_pub/…/*.enc) 갱신. 날짜 스탬프 빼고 내용이 같으면 그대로 둠.
// 사용: node tools/enc_publish.js <평문 파일> <data_pub/…/파일.js.enc>   (env CONTENT_KEY = base64 16바이트)
// 형식은 앱과 동일: AES-128-GCM, nonce 12 | 암호문 | tag 16. 평문 파일은 커밋하지 말 것(러너 임시 경로 사용).
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const KEY = Buffer.from(String(process.env.CONTENT_KEY || '').trim(), 'base64');
if (KEY.length !== 16) { console.error('CONTENT_KEY 없음/길이 오류'); process.exit(1); }
const [src, dst] = process.argv.slice(2);
if (!src || !dst) { console.error('사용: node tools/enc_publish.js <평문> <암호문>'); process.exit(1); }
const dec = b => { const d = crypto.createDecipheriv('aes-128-gcm', KEY, b.subarray(0, 12)); d.setAuthTag(b.subarray(b.length - 16)); return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]); };
const norm = s => s.replace(/\r\n/g, '\n').replace(/"generated"\s*:\s*"[^"]*"/g, '').replace(/(generated|update|festUpdate)\s*[:=]\s*"[\d.\-: ]*"/gi, '').replace(/,\s*\d{4}\.\d{2}\.\d{2} 기준\)/g, ')');
const pt = fs.readFileSync(src);
let old = '';
try { old = dec(fs.readFileSync(dst)).toString('utf8'); } catch (e) { /* 최초/복호화 실패 → 새로 씀 */ }
if (old && norm(old) === norm(pt.toString('utf8'))) { console.log('변경 없음:', dst); process.exit(0); }
const n = crypto.randomBytes(12);
const c = crypto.createCipheriv('aes-128-gcm', KEY, n);
const out = Buffer.concat([n, c.update(pt), c.final(), c.getAuthTag()]);
fs.writeFileSync(dst, out);
if (!dec(fs.readFileSync(dst)).equals(pt)) { console.error('검증 실패'); process.exit(1); }
console.log('갱신:', dst, Math.round(pt.length / 1024) + 'KB');
