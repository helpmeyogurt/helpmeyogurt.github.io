// 여행끝판왕 구버전 앱 원격 업데이트 묶음 생성 — 앱 업데이트 없이 새 화면을 쓰게 함
//  구버전 앱이 원격으로 새로 받는 건 data/*.js(암호화 data_pub)뿐이고, 그 파일은 페이지에서 '실행되는 스크립트'다.
//  → 데이터 파일 뒤에 새 화면 코드(tools/tour_ota/ = 앱 ygt/·css/ 사본)를 붙여, 페이지 로드 직후 기존 함수를 교체한다.
//  (웹뷰 안의 JS라 구글 플레이 정책상 허용. 새 버전 앱은 같은 코드를 번들에 갖고 있어 TourKit가 이미 있으면 건너뜀)
// 출력(평문, 커밋 금지 → enc_publish로 암호화해 data_pub/tour/data/에):
//  data_tour_festival.js  = festData(collect_tour_festival.js --js 결과) + 축제 화면
//  data_tour_list1.js     = 국립·도립공원(1004 첫 탭)
//  data_tour_list2~5.js   = 휴양림(1005)·테마파크(1006)·산계곡(1007)·호수섬(1008)
//                           호수섬 페이지는 ?k=camp|pet|with 로 열면 캠핑장·반려동물·무장애로 바뀜(구버전엔 그 페이지 파일이 없음)
// 사용: node tools/build_tour_ota.js <festData js 파일> <출력 폴더>
'use strict';
const fs = require('fs');
const path = require('path');
const [festFile, outDir] = process.argv.slice(2);
if (!festFile || !outDir) { console.error('사용: node tools/build_tour_ota.js <festData js> <출력 폴더>'); process.exit(1); }
const SRC = path.join(__dirname, 'tour_ota');
const rd = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const CSS = rd('ygt_tour_ext.css');
const FAV = rd('ygt_fav_alerts.js').replace(/^'use strict';\s*$/m, '');
const COMMON = rd('ygt_tour_common.js').replace(/^'use strict';\s*$/m, '');
const FEST = rd('ygt_tour_festival.js');
const LIST = rd('ygt_tour_listview.js');

// 사이드 메뉴 '여행 정보 더보기' (구버전 ygt.js에는 없음) — 캠핑장·반려동물·무장애는 호수섬 페이지를 빌려 씀
const MORE = [['ygt1004_Tour_National.html', '국립공원 도립공원', 0, '🏞️'], ['ygt1005_Tour_Forest.html', '자연휴양림 수목원', 0, '🌲'],
  ['ygt1006_Tour_ThemePark.html', '테마파크 워터파크', 0, '🎢'], ['ygt1007_Tour_Mountain.html', '산·강 계곡·바다', 0, '⛰️'],
  ['ygt1008_Tour_Lake.html', '호수·섬 폭포·동굴', 0, '🏝️'], ['ygt1008_Tour_Lake.html?k=camp', '전국 캠핑장', 1, '⛺'],
  ['ygt1008_Tour_Lake.html?k=pet', '반려동물 동반여행', 1, '🐾'], ['ygt1008_Tour_Lake.html?k=with', '무장애 여행', 1, '♿']];
const MENU_JS = `
function tkOtaMenu() {
  var box = document.querySelector('#sideMenu .sideBtnBox');
  if (!box || document.querySelector('#sideMenu .tk-more')) return;
  var items = ${JSON.stringify(MORE)};
  var h = '<div class="title">여행 정보 더보기</div><div class="tk-more">';
  for (var i = 0; i < items.length; i++) h += '<a href="' + items[i][0] + '" target="_self"' + (items[i][2] ? ' class="new"' : '') + '><span class="ic">' + items[i][3] + '</span><span class="tx">' + items[i][1] + '</span></a>';
  box.insertAdjacentHTML('afterend', h + '</div>');
  // 구버전 1004~1008 페이지는 없는 아이콘(img/tab/1004~1009.png)을 가리켜 깨진 그림이 보임 → 숨김
  var bad = box.querySelectorAll('img[src*="img/tab/100"]');
  for (var j = 0; j < bad.length; j++) { if (/100[4-9].png/.test(bad[j].getAttribute('src'))) { var a = bad[j].closest('a'); if (a) a.style.display = 'none'; } }
}
window.addEventListener('load', function () { setTimeout(tkOtaMenu, 300); setTimeout(tkOtaMenu, 1500); });
`;

// 페이지 로드(모든 기존 스크립트 실행 완료) 시점에 새 코드를 전역으로 실행 → 기존 함수 교체
function block(pageCode, pre) {
  const code = [FAV, 'window.YgtFav = YgtFav;', COMMON, 'window.TourKit = TourKit;', pre || '', pageCode, MENU_JS].join('\n');
  return `
// ── 여행끝판왕 원격 화면 업데이트(구버전 앱용, github.io tools/build_tour_ota.js 생성) ──
;(function () {
  function run() {
    if (window.TourKit) return;   // 새 버전 앱: 번들에 이미 있음
    window.TOUR_OTA = true;
    var st = document.createElement('style'); st.textContent = ${JSON.stringify(CSS)}; document.head.appendChild(st);
    (0, eval)(${JSON.stringify(code)});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
`;
}

fs.mkdirSync(outDir, { recursive: true });

// 1) 축제
fs.writeFileSync(path.join(outDir, 'data_tour_festival.js'), fs.readFileSync(festFile, 'utf8') + block(FEST));

// 2) 목록 페이지: 구버전 렌더러가 최상위에서 arrA~ 를 지역 분류하므로 빈 배열을 정의해 둠(실제 목록은 원격 JSON)
const LISTS = [
  ['data_tour_list1.js', 'parks', ['', '국립공원'], ''],
  ['data_tour_list2.js', 'forest', ['', '자연휴양림', '수목원·정원'], ''],
  ['data_tour_list3.js', 'theme', ['', '테마파크', '워터파크', '동물원·수족관'], ''],
  ['data_tour_list4.js', 'mountain', ['', '산', '강', '계곡', '해수욕장'], ''],
  ['data_tour_list5.js', 'lake', ['', '호수·저수지', '섬', '폭포', '동굴'], 'swap'],
];
// 호수섬 페이지를 캠핑장·반려동물·무장애로 바꾸는 설정(?k=)
const SWAP = { camp: ['전국 캠핑장', ['일반', '오토캠핑', '글램핑', '카라반']], pet: ['반려동물 동반여행', ['관광지', '숙박', '음식점', '문화·레포츠']],
  with: ['무장애 여행', ['관광지', '문화시설', '숙박', '음식점']] };
for (const [file, key, types, mode] of LISTS) {
  let head = `var update = "";\nvar arrType = ${JSON.stringify(types)};\nvar arrA = [], arrB = [], arrC = [], arrD = [];\n`;
  // 탭 이름을 새 분류에 맞춤(예: 테마파크 3번째 탭 '유원지' → '동물원·수족관'). 공원(1004)은 2번째 탭이 100경이라 제외
  const relabel = key === 'parks' ? '' :
    `(function () { var T = ${JSON.stringify(types.slice(1))}; for (var i = 0; i < T.length; i++) { var l = document.querySelector('label[for=tab' + (i + 1) + ']'); if (l) l.textContent = T[i]; } })();\n`;
  let pre = `var LIST_KEY = ${JSON.stringify(key)};\n` + relabel;
  if (mode === 'swap') {
    pre = `var LIST_KEY = ${JSON.stringify(key)};
${relabel}(function () {
  var m = /[?&]k=(camp|pet|with)\\b/.exec(location.search), S = ${JSON.stringify(SWAP)};
  if (!m) return;
  LIST_KEY = m[1];
  var t = S[LIST_KEY];
  document.title = t[0];
  for (var i = 0; i < 4; i++) { var l = document.querySelector('label[for=tab' + (i + 1) + ']'); if (l) l.textContent = t[1][i]; }
  var fix = function () { var h = document.querySelectorAll('.Ygnb_service .mainTxt'); if (h.length) { h[0].textContent = t[0]; for (var j = 1; j < h.length; j++) h[j].style.display = 'none'; } };
  fix(); setTimeout(fix, 300); setTimeout(fix, 1200);
})();
`;
  }
  fs.writeFileSync(path.join(outDir, file), head + block(LIST, pre));
}
console.log('OTA 생성:', fs.readdirSync(outDir).filter(f => /^data_tour_/.test(f)).map(f => f + ' ' + Math.round(fs.statSync(path.join(outDir, f)).size / 1024) + 'KB').join(', '));
