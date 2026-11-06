// 이달의 축제 — github.io 매일 수집분(yogurthelp.me/tour/festival.json) 우선, 실패 시 번들(data/data_tour_festival.js).
//
// 수집: github.io collect-tour 워크플로(tools/collect_tour_festival.js) — 관광공사 TourAPI 전국 + 지역 관광사이트·
// 서울 문화행사·부산 축제정보·제주 VisitJeju·전국문화축제표준데이터 보충. 지역(ar=areaCode)·날씨코드(w)는 수집 단계에서 매핑.
// 화면: 지역 탭 + 필터 칩(전체·진행중·이번 주말·이번 달·찜) + 가까운 순, 카드 탭 → 상세 시트(소개·장소·시간·요금·날씨·미세먼지·
// 지도·길찾기·전화·홈페이지·찜). 종료 축제는 제외. 세종(8)은 탭이 없어 대전(3) 탭에 함께 표시.
// 공용: ygt/ygt_tour_common.js(TourKit), ../common/js/ygt_fav_alerts.js(YgtFav)

var GH_TOUR_FEST = "https://yogurthelp.me/tour/festival.json";
var festSrc;        // undefined=미조회, {data, updated}
var festReqSeq = 0;
var festFilter = 'all', festNear = false, festShown = [];

window.onload = function () { tabSelect(); };

// 원격 수집분 1회 로드(4초 타임아웃) → 번들보다 같거나 최신이면 사용
function festLoad() {
	return new Promise(function (resolve) {
		if (festSrc !== undefined) { resolve(festSrc); return; }
		var local = { data: (typeof festData !== 'undefined' ? festData : []), updated: (typeof festUpdate !== 'undefined' ? festUpdate : '') };
		$.ajax({
			type: "GET", url: GH_TOUR_FEST + "?t=" + Math.floor(Date.now() / 600000), dataType: "json", timeout: 4000,
			success: function (d) {
				var ok = d && Array.isArray(d.data) && d.data.length && String(d.updated || '') >= String(local.updated || '');
				festSrc = ok ? { data: d.data, updated: d.updated } : local; resolve(festSrc);
			},
			error: function () { festSrc = local; resolve(festSrc); }
		});
	});
}

// 탭(지역) 선택 시
function tabSelect() {
	var area = $(':input:radio[name=submenu]:checked').val();
	var seq = ++festReqSeq;
	loadStart('loading1', 'container1');
	festLoad().then(function (src) { if (seq === festReqSeq) render(area, src); });
}

function festKey(f) { return f.k || ('h' + String(f.n) + '|' + String(f.s)); }

// 이번 주말(토·일; 오늘이 일요일이면 오늘만) / 이번 달 범위
function rangeOf(kind) {
	var t = new Date(); t.setHours(0, 0, 0, 0);
	if (kind === 'weekend') {
		var dow = t.getDay();
		var sat = new Date(t.getTime() + ((6 - dow + 7) % 7) * 86400000);
		var sun = new Date(sat.getTime() + 86400000);
		if (dow === 0) { sat = t; sun = t; }
		return [TourKit.dot(sat), TourKit.dot(sun)];
	}
	if (kind === 'month') {
		var last = new Date(t.getFullYear(), t.getMonth() + 1, 0);
		return [TourKit.dot(t), TourKit.dot(last)];
	}
	return null;
}

function render(area, src) {
	var today = TourKit.dot(new Date());
	var favs = TourKit.fav ? TourKit.fav.favGet() : {};
	var all = (src && src.data || []).filter(function (f) { return String(f.e || '') >= today; });   // 종료 축제 제외
	var arr;
	if (festFilter === 'fav') {
		arr = all.filter(function (f) { return favs[festKey(f)]; });   // 찜은 전 지역
	} else {
		arr = all.filter(function (f) {
			var ar = String(f.ar) === '8' ? '3' : String(f.ar);
			return ar === String(area);
		});
		if (festFilter === 'ing') arr = arr.filter(function (f) { return f.s <= today; });
		var rg = rangeOf(festFilter);
		if (rg) arr = arr.filter(function (f) { return f.s <= rg[1] && f.e >= rg[0]; });
	}
	if (festNear && TourKit.pos) arr = TourKit.nearSort(arr);
	festShown = arr;

	var chips = [['all', '전체'], ['ing', '진행중'], ['weekend', '이번 주말'], ['month', '이번 달'], ['fav', '♥ 찜']];
	var h = '<span class="notice_music"><span style="font-size:14px; color:#3069cf">' + strToday() + '</span><span class="bar">|</span>' + (festNear && TourKit.pos ? '가까운 순' : '축제일순') + '<span class="bar">|</span>한국관광공사 외</span>';
	h += '<div class="tk-bar">' + chips.map(function (c) { return '<span class="tk-chip' + (festFilter === c[0] ? ' on' : '') + '" data-f="' + c[0] + '">' + c[1] + '</span>'; }).join('')
		+ (window.TOUR_OTA ? '' : '<span class="tk-chip near' + (festNear ? ' on' : '') + '">📍 가까운순</span>') + '</div>';   // 구버전 앱(원격 코드 실행)은 위치 권한이 없어 숨김
	if (!arr.length) {
		h += '<div class="tk-empty">' + (festFilter === 'fav' ? '찜한 축제가 없습니다.<br>축제를 눌러 ♡ 찜을 해두면 시작 전날과 당일에 알려드려요.' : '조건에 맞는 축제가 없습니다.') + '</div>';
	} else {
		h += '<div class="tk-count">' + (festFilter === 'fav' ? '찜한 축제 ' : '') + '<b>' + arr.length + '</b>개</div><ul class="tk-list">';
		for (var i = 0; i < arr.length; i++) {
			var f = arr[i];
			var ing = f.s <= today;
			h += TourKit.card(f, { idx: i, sub: f.a, sub2: f.s + ' ~ ' + f.e, tags: [[ing ? 'ing' : 'soon', ing ? '진행중' : dday(f.s)]], heart: !!favs[festKey(f)] });
		}
		h += '</ul>';
	}
	h += '<div class="tk-update">' + (src && src.updated ? src.updated + ' 업데이트' : '') + '</div>';
	var c = document.getElementById('container1');
	c.innerHTML = h;
	loadEnd('loading1', 'container1');
	TourKit.lazy(c);

	$(c).find('.tk-chip[data-f]').on('click', function () { festFilter = $(this).attr('data-f'); render(area, src); });
	$(c).find('.tk-chip.near').on('click', function () {
		if (festNear) { festNear = false; render(area, src); return; }
		var $b = $(this).text('📍 위치 확인 중…');
		TourKit.geo().then(function (p) {
			if (!p) { $b.text('📍 가까운순'); alertMsg('위치를 확인할 수 없습니다. 앱의 위치 권한을 허용해 주세요.'); return; }
			festNear = true; render(area, src);
		});
	});
	TourKit.bind(c, function (i) { openFest(festShown[i]); }, function (i, el) {
		var f = festShown[i];
		var on = toggleFav(f);
		el.toggleClass('on', on);
		if (!on && festFilter === 'fav') render(area, src);
	});
}

function dday(s) {
	var t = new Date(); t.setHours(0, 0, 0, 0);
	var d = new Date(String(s).replace(/\./g, '/'));
	var n = Math.round((d - t) / 86400000);
	return n <= 0 ? '진행중' : n === 1 ? '내일 시작' : 'D-' + n;
}

function toggleFav(f) {
	if (!TourKit.fav) return false;
	return TourKit.fav.favToggle(festKey(f), { title: f.n, img: f.i || '', s: f.s, e: f.e, a: f.a });
}

function alertMsg(m) { if (typeof toastr !== 'undefined') toastr.info(m); else alert(m); }

function openFest(f) {
	if (!f) return;
	var tel = TourKit.telOf(f.t);
	var rows = [['기간', TourKit.esc(f.s + ' ~ ' + f.e)], ['주소', TourKit.esc(f.a)]];
	if (f.t) rows.push(['문의', tel ? TourKit.aTag('tel:' + tel, f.t) : TourKit.esc(f.t)]);
	if (f.h) rows.push(['홈페이지', TourKit.aTag(f.h, f.h.replace(/^https?:\/\//, '').slice(0, 40))]);
	var links = [{ label: '지도', href: TourKit.mapUrl(f), pri: true }, { label: '길찾기', href: TourKit.routeUrl(f) }];
	if (tel) links.push({ label: '전화', href: 'tel:' + tel });
	links.push({ label: '검색', href: TourKit.searchUrl(f.n) });
	TourKit.sheet({
		it: f, rows: rows, desc: f.d || '', wxDate: f.s,
		links: links,
		fav: TourKit.fav ? { on: TourKit.fav.isFav(festKey(f)), toggle: function () {
			var on = toggleFav(f);
			$('#container1 .tk-heart[data-h="' + festShown.indexOf(f) + '"]').toggleClass('on', on);
			return on;
		} } : null
	});
}

function uiSettingNull() {}
