// 공시지원금 수집 → phone/support.json (0803 공시지원금 페이지가 gh 우선으로 읽음)
//  스마트초이스 dantongList.do POST(기기별 1회) → 3사 비교표 서버렌더 파싱.
//  출력 = 앱 배선 포맷 그대로: { update, dateKey, devices(supDevices), data(supData) }
//  검증 실패(기기/레코드 수 미달) 시 파일을 쓰지 않고 exit 1 — 기존 데이터 유지.
// usage: node tools/collect_phone_subsidy.js phone/support.json
const { chromium } = require('playwright');
const fs = require('fs');

const SRC = 'https://www.smartchoice.or.kr/smc/mobile/dantongList.do';
const MAKERS = { 삼성전자: 'SAMSUNG', 애플: 'APPLE', 기타: 'ETC' };
const MAKER_KR = { SAMSUNG: '삼성전자', APPLE: '애플', ETC: '기타' };
const CARRIERS = ['SKT', 'KT', 'LGU_PLUS'];
const MIN_DEVICES = 80, MIN_ROWS = 800;

const comma = (n) => (n == null ? '' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
const tierNum = (t) => { const m = (t || '').match(/([0-9.]+)\s*만/); return m ? parseFloat(m[1]) : 999; };

(async () => {
  const out = process.argv[2] || 'phone/support.json';
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const p = (n) => (n < 10 ? '0' : '') + n;
  const today = kst.getUTCFullYear() + '.' + p(kst.getUTCMonth() + 1) + '.' + p(kst.getUTCDate());
  const dateKey = today.replace(/\./g, '');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: 'ko-KR' });
  await page.goto(SRC, { waitUntil: 'networkidle', timeout: 70000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const post = (url, data) => page.evaluate(async ({ url, data }) => {
    const body = Object.entries(data).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
    return (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }, body })).text();
  }, { url, data });

  // 1) 판매 단말 카탈로그
  const devices = [];
  for (const [mauKr, mauEn] of Object.entries(MAKERS)) {
    let arr = []; try { arr = JSON.parse(await post('/smc/mobile/getProductList.do', { dan_Mau: mauKr, p_Group: 'PHONE', dan_Service: '' })); } catch (e) {
      try { arr = eval('(' + await post('/smc/mobile/getProductList.do', { dan_Mau: mauKr, p_Group: 'PHONE', dan_Service: '' }) + ')'); } catch (e2) {}
    }
    for (const d of (arr || [])) {
      const car = d.skt_Pn ? { c: 'SKT', pfx: 'SK', pn: d.skt_Pn } : d.kt_Pn ? { c: 'KT', pfx: 'KT', pn: d.kt_Pn } : d.lg_Pn ? { c: 'LGU', pfx: 'LG', pn: d.lg_Pn } : null;
      if (car) devices.push({ mauKr, mauEn, name: d.dan_Pc_Name, service: d.dan_Service || '5G', car });
    }
  }
  console.log('기기:', devices.length, '대');

  // 2) 기기별 3사 비교표 파싱
  const rows = [];
  let done = 0;
  for (const dev of devices) {
    const productName = dev.car.pfx + String(dev.car.pn).replace(/^-+/, '');
    const svc = dev.service === 'LTE' ? { planLteChoice: 'all', plan5GChoice: '', plan3GChoice: '' } : dev.service === '3G' ? { plan3GChoice: 'all', plan5GChoice: '', planLteChoice: '' } : { plan5GChoice: 'all', planLteChoice: '', plan3GChoice: '' };
    const t = await post('/smc/mobile/dantongList.do', { datType: '', p_Group: 'PHONE', dan_Service: dev.service, dan_Company: dev.car.c, dan_Mau: dev.mauKr, productName, dan_Pc_Name: '', ...svc });
    const parsed = await page.evaluate((t) => {
      const d = document.createElement('div'); d.innerHTML = t;
      const gi = (v) => { if (v == null) return null; const s = String(v).replace(/[^0-9]/g, ''); return s ? parseInt(s, 10) : null; };
      const carrierOf = (nm) => /베스트|라이트|컴팩트|슬림|T플랜|0플랜|T\b/i.test(nm) ? 'SKT' : /요고|초이스|베이직|심플|데이터ON/i.test(nm) ? 'KT' : /데이터플랜|플러스플랜|너겟|유쓰|U\+/i.test(nm) ? 'LGU_PLUS' : null;
      let factory = null;
      const ft = [...d.querySelectorAll('table')].find((x) => /출고가 및 이동통신사별|출고가와 지원금/.test(x.innerText));
      if (ft) { const fc = [...ft.querySelectorAll('td')].map((x) => x.innerText.trim()).find((c) => /[0-9],[0-9]{3}/.test(c)); factory = gi(fc); }
      const recs = [];
      const tbl = [...d.querySelectorAll('table')].find((x) => /선택약정|공통 지원금/.test(x.innerText) && /요금제 및 월정액/.test(x.innerText));
      if (tbl) {
        const trs = [...tbl.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('th,td')].map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
        let tier = null, plans = [], sel = [], subCh = [], subPn = [], dates = [];
        const flush = () => {
          plans.forEach((pl, i) => {
            const car = carrierOf(pl);
            const pm = pl.match(/^(.*?)\s*월\s*([0-9,]+)\s*원/);
            recs.push({ fee_tier: tier, carrier: car, plan_name: pm ? pm[1].trim() : pl, plan_fee: pm ? gi(pm[2]) : null, selective_2y: gi(sel[i]), subsidy_device_change: gi(subCh[i]), notice_date: (dates[i] || '').match(/\d{4}-\d{2}-\d{2}/) ? dates[i] : null });
          });
        };
        for (const c of trs) {
          const h = c[0] || '';
          if (/요금제 및 월정액/.test(c[1] || '')) { if (tier) flush(); tier = h; plans = c.slice(2).filter((x) => x && !/해당사항 없음/.test(x)); sel = []; subCh = []; subPn = []; dates = []; }
          else if (/선택약정/.test(h)) sel = c.slice(1);
          else if (/공통 지원금/.test(h)) subCh = c.slice(2);
          else if (/공시일/.test(h)) dates = c.slice(1);
        }
        if (tier) flush();
      }
      return { factory, recs };
    }, t).catch(() => ({ factory: null, recs: [] }));

    for (const r of parsed.recs) {
      if (r.subsidy_device_change == null && r.selective_2y == null) continue;
      rows.push({ device: dev.name, maker: dev.mauEn, service: dev.service, factory: parsed.factory, ...r });
    }
    if (++done % 20 === 0) console.log('  진행', done, '/', devices.length, '| rows', rows.length);
    await page.waitForTimeout(150);
  }
  await browser.close();

  // 3) 앱 배선 포맷(supDevices/supData)으로 변환
  const byDevice = {};
  for (const r of rows) (byDevice[r.device] = byDevice[r.device] || []).push(r);

  const supDevices = {};
  const supData = {};
  for (const [dev, recs] of Object.entries(byDevice)) {
    const key = (recs[0].service || '5G') + '|' + (MAKER_KR[recs[0].maker] || '기타');
    (supDevices[key] = supDevices[key] || []).push({ v: dev, t: dev });
    const tiers = [...new Set(recs.map((r) => r.fee_tier))].sort((a, b) => tierNum(a) - tierNum(b));
    const arrSup = [];
    for (const tier of tiers) {
      for (const car of CARRIERS) {
        const rec = recs.find((r) => r.fee_tier === tier && r.carrier === car);
        if (rec && (rec.subsidy_device_change != null || rec.selective_2y != null)) {
          arrSup.push({ release: 1, planName: rec.plan_name || '', planPrice: comma(rec.plan_fee), phonePri: comma(rec.factory) + '원', phoneSup: comma(rec.subsidy_device_change), priceDC: comma(rec.selective_2y), priceDate: rec.notice_date || '' });
        } else {
          arrSup.push({ release: 0 });
        }
      }
    }
    supData[dev] = arrSup;
  }
  for (const k of Object.keys(supDevices)) supDevices[k].sort((a, b) => a.t.localeCompare(b.t, 'ko'));

  // 4) 검증 — 미달이면 쓰지 않음(기존 유지)
  const devCount = Object.keys(supData).length;
  console.log('지원금 레코드:', rows.length, '| 기기수:', devCount);
  if (devCount < MIN_DEVICES || rows.length < MIN_ROWS) {
    console.error(`검증 실패: devices=${devCount}(<${MIN_DEVICES}) 또는 rows=${rows.length}(<${MIN_ROWS}) — 기존 데이터 유지`);
    process.exit(1);
  }

  fs.writeFileSync(out, JSON.stringify({ update: today, dateKey, devices: supDevices, data: supData }));
  console.log('저장 ->', out);
})();
