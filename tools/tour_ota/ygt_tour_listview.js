// 여행 목록 페이지 공용 뷰 — 공원(1004 첫 탭)·휴양림·테마파크·산계곡·호수섬·캠핑장·반려동물·무장애
//  · 페이지가 LIST_KEY(예: 'forest')를 정의. 메인 탭 n → yogurthelp.me/tour/l_<LIST_KEY>_<n-1>.json (실패 시 번들 ldata/tour_l_*.js)
//  · 서브 탭 = 지역 그룹(수도권·강원·충청·경상·전라·제주). 지역은 수집 단계의 g 값(주소 시도 전체 이름까지 인식)
//    — 예전 렌더러는 주소 앞 두 글자로만 나눠 '충청북도·경상남도…' 주소 항목이 어느 탭에도 안 나왔음
//  · 카드: 사진·이름·주소·전화·거리 / 탭 → 상세 시트(사진·주소·전화·홈페이지·상세·날씨·미세먼지·지도·길찾기·전화)
//  · 가까운 순: 내 위치(권한 허용 시)로 정렬 — 지역 탭 무시하고 전국 기준 가까운 곳 300개
// 의존: ygt/ygt_tour_common.js(TourKit), 페이지의 initTab/initTouch(탭 전환 시 uiSetting(tab, subtab) 호출)

var arrTxt = ["서울·경기·인천", "강원", "충북·대전·세종·충남", "대구·경북·부산·울산·경남", "전북·광주·전남", "제주"];
var chkSubTab1 = 0, chkSubTab2 = 0, chkSubTab3 = 0, chkSubTab4 = 0, chkSubTab5 = 0;
var LV = { near: false, shown: [], seq: 0 };

function uiSetting(tab, subtab) {
	var seq = ++LV.seq;
	loadStart("loading" + tab, "content" + tab);
	TourKit.loadList(LIST_KEY, tab - 1).then(function (doc) {
		if (seq !== LV.seq) return;
		lvRender(tab, subtab, doc);
	});
}

function lvRender(tab, subtab, doc) {
	var el = document.getElementById("content" + tab);
	if (!doc || !doc.items) {
		el.innerHTML = '<div class="tk-empty">목록을 불러오지 못했습니다.<br>네트워크 연결을 확인한 뒤 다시 시도해 주세요.</div>';
		loadEnd("loading" + tab, "content" + tab);
		return;
	}
	var arr;
	if (LV.near && TourKit.pos) {
		arr = TourKit.nearSort(doc.items.filter(function (it) { return it.x && it.y; })).slice(0, 300);
	} else {
		arr = doc.items.filter(function (it) { return TourKit.group(it) === subtab; });
	}
	LV.shown = arr;

	var h = '<span class="notice_tel"><span style="font-size:14px; color:#3069cf">' + (LV.near && TourKit.pos ? '내 주변' : arrTxt[subtab]) + '</span><span class="bar">|</span>' + TourKit.esc(doc.type || '') + '</span>';
	h += '<div class="tk-bar"><span class="tk-count" style="padding:0">' + (LV.near && TourKit.pos ? '가까운 순 ' : '') + '<b>' + arr.length + '</b>곳</span>'
		+ (window.TOUR_OTA ? '' : '<span class="tk-chip near' + (LV.near ? ' on' : '') + '">📍 가까운순</span>') + '</div>';   // 구버전 앱은 위치 권한 없음
	if (!arr.length) {
		h += '<div class="tk-empty">이 지역에는 등록된 곳이 없습니다.</div>';
	} else {
		h += '<ul class="tk-list">';
		for (var i = 0; i < arr.length; i++) {
			var it = arr[i], tags = [];
			if (it.nat) tags.push(['nat', '국립']);
			if (LIST_KEY === 'pet' && it.d) { var m = it.d.match(/^동반 구분: (.+)$/m); if (m) tags.push(['', m[1].slice(0, 18)]); }
			h += TourKit.card(it, { idx: i, sub: it.a, sub2: it.t || '', tags: tags });
		}
		h += '</ul>';
	}
	h += '<div class="tk-update">' + TourKit.esc(doc.updated || '') + ' 업데이트 · 한국관광공사' + (LIST_KEY === 'camp' ? ' 고캠핑' : '') + '</div>';
	el.innerHTML = h;
	loadEnd("loading" + tab, "content" + tab);
	TourKit.lazy(el);

	$(el).find('.tk-chip.near').on('click', function () {
		if (LV.near) { LV.near = false; lvRender(tab, subtab, doc); return; }
		var $b = $(this).text('📍 위치 확인 중…');
		TourKit.geo().then(function (p) {
			if (!p) { $b.text('📍 가까운순'); lvMsg('위치를 확인할 수 없습니다. 앱의 위치 권한을 허용해 주세요.'); return; }
			LV.near = true; lvRender(tab, subtab, doc);
		});
	});
	TourKit.bind(el, function (i) { lvOpen(LV.shown[i], doc); });
}

function lvMsg(m) { if (typeof toastr !== 'undefined') toastr.info(m); else alert(m); }

function lvOpen(it, doc) {
	if (!it) return;
	var tel = TourKit.telOf(it.t);
	var rows = [['분류', TourKit.esc((it.nat ? '국립 · ' : '') + (doc.type || ''))], ['주소', TourKit.esc(it.a)]];
	if (it.t) rows.push(['전화', tel ? TourKit.aTag('tel:' + tel, it.t) : TourKit.esc(it.t)]);
	if (it.h) rows.push(['홈페이지', TourKit.aTag(it.h, it.h.replace(/^https?:\/\//, '').slice(0, 40))]);
	var dist = TourKit.dist(it);
	if (isFinite(dist)) rows.push(['거리', '내 위치에서 약 ' + TourKit.distTxt(dist)]);
	var links = [{ label: '지도', href: TourKit.mapUrl(it), pri: true }, { label: '길찾기', href: TourKit.routeUrl(it) }];
	if (tel) links.push({ label: '전화', href: 'tel:' + tel });
	links.push({ label: '검색', href: TourKit.searchUrl(it.n) });
	var desc = it.d || '';
	if (!desc && (LIST_KEY === 'pet' || LIST_KEY === 'with')) desc = '상세 정보를 준비 중입니다. 방문 전 전화로 확인해 주세요.';
	TourKit.sheet({ it: it, rows: rows, desc: desc, links: links });
}
