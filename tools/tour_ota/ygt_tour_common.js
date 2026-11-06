// 여행끝판왕 공용 — 원격 데이터 로딩, 지역 그룹, 거리(내 위치), 날씨·미세먼지, 찜·알림, 상세 시트, 카드
//  · 데이터: yogurthelp.me/tour/*.json(github.io 매일 수집) 우선 → 실패 시 번들 ldata/tour_l_*.js(TourData 호출) 폴백
//  · 날씨: yogurthelp.me/weather/now.json·weekly.json(날씨끝판왕 수집분), 미세먼지: tool/air.json — 항목의 w(지역코드)로 조회
//  · 위치: navigator.geolocation(앱이 권한 허용 시). 거부/미지원이면 '가까운 순'만 비활성 안내
//  · 찜: 공용 YgtFav(../common/js/ygt_fav_alerts.js) 네임스페이스 'tour' — 축제 시작 전날·당일 로컬 알림
'use strict';

var TourKit = (function () {
	var GH = 'https://yogurthelp.me/';
	var K = {};

	function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
	K.esc = esc;

	function getJson(url, ms) {
		return new Promise(function (resolve, reject) {
			$.ajax({ type: 'GET', url: url, dataType: 'json', timeout: ms || 6000,
				success: function (d) { resolve(d); }, error: function (x, s) { reject(new Error(s || 'error')); } });
		});
	}
	K.getJson = getJson;

	// ── 목록 데이터: 원격 → 번들 스크립트 폴백 ─────────────────────
	var listCache = {}, waiters = {};
	window.TourData = function (key, k, doc) {
		var id = key + '_' + k;
		listCache[id] = doc;
		(waiters[id] || []).forEach(function (f) { f(doc); });
		delete waiters[id];
	};
	function bundled(key, k) {
		var id = key + '_' + k;
		return new Promise(function (resolve) {
			if (listCache[id]) { resolve(listCache[id]); return; }
			(waiters[id] = waiters[id] || []).push(resolve);
			var s = document.createElement('script');
			s.src = 'ldata/tour_l_' + id + '.js';   // 번들 전용 폴더(data/는 앱이 github.io 암호화본을 먼저 찾으므로 피함)
			s.onerror = function () { resolve(null); };
			document.body.appendChild(s);
		});
	}
	K.loadList = function (key, k) {
		var id = key + '_' + k;
		if (listCache[id]) return Promise.resolve(listCache[id]);
		return getJson(GH + 'tour/l_' + id + '.json?t=' + Math.floor(Date.now() / 600000), 6000)
			.then(function (d) { if (!d || !d.items) throw new Error('empty'); listCache[id] = d; return d; })
			.catch(function () { return bundled(key, k); });
	};

	// ── 지역 그룹(0 수도권 1 강원 2 충청 3 경상 4 전라 5 제주) ─────────
	var GRP = [[/^(서울|경기|인천)/, 0], [/^강원/, 1], [/^(대전|세종|충청|충북|충남)/, 2], [/^(대구|부산|울산|경상|경북|경남)/, 3],
		[/^(전북|전라|전남|광주)/, 4], [/^제주/, 5]];
	K.group = function (it) {
		if (typeof it.g === 'number' && it.g >= 0) return it.g;
		var a = String(it.a || it.Address || '');
		for (var i = 0; i < GRP.length; i++) if (GRP[i][0].test(a)) return GRP[i][1];
		return -1;
	};

	// ── 내 위치·거리 ─────────────────────────────────────
	K.pos = null;
	K.geo = function () {
		return new Promise(function (resolve) {
			try {
				var c = JSON.parse(sessionStorage.getItem('tk_pos') || 'null');
				if (c && Date.now() - c.t < 10 * 60000) { K.pos = c; resolve(c); return; }
			} catch (e) { }
			if (!navigator.geolocation) { resolve(null); return; }
			navigator.geolocation.getCurrentPosition(function (p) {
				K.pos = { lat: p.coords.latitude, lng: p.coords.longitude, t: Date.now() };
				try { sessionStorage.setItem('tk_pos', JSON.stringify(K.pos)); } catch (e) { }
				resolve(K.pos);
			}, function () { resolve(null); }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
		});
	};
	K.dist = function (it) {
		if (!K.pos || !it.x || !it.y) return Infinity;
		var R = 6371, toR = Math.PI / 180;
		var dLat = (it.y - K.pos.lat) * toR, dLng = (it.x - K.pos.lng) * toR;
		var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(K.pos.lat * toR) * Math.cos(it.y * toR) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
		return 2 * R * Math.asin(Math.sqrt(a));
	};
	K.distTxt = function (km) { return !isFinite(km) ? '' : km < 1 ? Math.round(km * 1000) + 'm' : km < 100 ? km.toFixed(1) + 'km' : Math.round(km) + 'km'; };
	K.nearSort = function (arr) {
		return arr.slice().sort(function (p, q) { return K.dist(p) - K.dist(q); });
	};

	// ── 날씨·미세먼지 ────────────────────────────────────
	var wxP = null;
	K.wx = function () {
		if (!wxP) {
			var t = '?t=' + Math.floor(Date.now() / 600000);
			wxP = Promise.all([
				getJson(GH + 'weather/now.json' + t, 8000).catch(function () { return null; }),
				getJson(GH + 'weather/weekly.json' + t, 8000).catch(function () { return null; }),
				getJson(GH + 'tool/air.json' + t, 8000).catch(function () { return null; })
			]).then(function (r) { return { now: r[0] && r[0].wx || {}, wk: r[1] && r[1].wk || {}, air: r[2] && r[2].sido || {} }; });
		}
		return wxP;
	};
	var AIR = [['서울', '서울'], ['부산', '부산'], ['대구', '대구'], ['인천', '인천'], ['광주', '광주'], ['대전', '대전'], ['울산', '울산'], ['세종', '세종'],
		['경기', '경기'], ['강원', '강원'], ['충청북도', '충북'], ['충북', '충북'], ['충청남도', '충남'], ['충남', '충남'], ['전북', '전북'], ['전라북도', '전북'],
		['전라남도', '전남'], ['전남', '전남'], ['경상북도', '경북'], ['경북', '경북'], ['경상남도', '경남'], ['경남', '경남'], ['제주', '제주']];
	function airSido(addr) {
		var p = String(addr || '').split(/\s+/);
		if (/^전남광주/.test(p[0] || '')) return /^(동구|서구|남구|북구|광산구)$/.test(p[1] || '') ? '광주' : '전남';
		for (var i = 0; i < AIR.length; i++) if ((p[0] || '').indexOf(AIR[i][0]) === 0) return AIR[i][1];
		return '';
	}
	function grade(v, cut) { if (v == null || v === '' || isNaN(v)) return null; for (var i = 0; i < cut.length; i++) if (v <= cut[i]) return i + 1; return 4; }
	var GTXT = ['', '좋음', '보통', '나쁨', '매우나쁨'];
	// it: {w, a}, date: 'YYYY.MM.DD'(축제 시작일, 선택) → HTML
	K.wxHtml = function (W, it, date) {
		var h = [];
		var now = it.w && W.now[it.w];
		if (now) h.push('<div><span class="t">지금 날씨</span>' + esc(now.sigungu || '') + ' ' + esc(now.wetrTxt || '') + ' ' + esc(now.tmpr) + '° · 강수확률 ' + (now.rainProb != null ? now.rainProb : '-') + '%</div>');
		var sd = airSido(it.a);
		var air = sd && W.air[sd];
		if (air) {
			var g10 = grade(air.pm10, [30, 80, 150]), g25 = grade(air.pm25, [15, 35, 75]);
			var g = Math.max(g10 || 0, g25 || 0);
			if (g) h.push('<div><span class="t">미세먼지</span><b class="g' + g + '">' + GTXT[g] + '</b> <span class="muted">(' + esc(sd) + ' 미세 ' + esc(air.pm10) + ' · 초미세 ' + esc(air.pm25) + '㎍/㎥)</span></div>');
		}
		var wk = it.w && W.wk[it.w];
		if (wk && wk.length) {
			var key = date ? String(date).replace(/\./g, '') : '';
			var today = ymd(new Date());
			if (key && key > today) {
				var f = wk.filter(function (d) { return d.d === key; })[0];
				if (f) h.push('<div><span class="t">' + Number(key.slice(4, 6)) + '/' + Number(key.slice(6)) + '(' + esc(f.w) + ') 예보</span>' + esc(f.aw) + (f.pw && f.pw !== f.aw ? '→' + esc(f.pw) : '') + ' ' + esc(f.tn) + '°/' + esc(f.tx) + '° · 강수 ' + Math.max(f.ar || 0, f.pr || 0) + '%</div>');
				else h.push('<div class="muted">시작일 예보는 10일 이내가 되면 표시됩니다.</div>');
			} else {
				var nx = wk.slice(0, 3).map(function (d) { return esc(d.w) + ' ' + esc(d.aw) + ' ' + esc(d.tn) + '°/' + esc(d.tx) + '°'; });
				if (nx.length) h.push('<div><span class="t">3일 예보</span>' + nx.join(' · ') + '</div>');
			}
		}
		return h.length ? '<div class="tk-wx">' + h.join('') + '</div>' : '';
	};
	function ymd(d) { var p = function (n) { return (n < 10 ? '0' : '') + n; }; return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()); }
	K.ymd = ymd;
	K.dot = function (d) { var s = ymd(d); return s.slice(0, 4) + '.' + s.slice(4, 6) + '.' + s.slice(6); };

	// ── 링크 ─────────────────────────────────────────────
	K.mapUrl = function (it) {
		return it.x && it.y ? 'https://map.kakao.com/link/map/' + encodeURIComponent(it.n) + ',' + it.y + ',' + it.x
			: 'https://map.kakao.com/link/search/' + encodeURIComponent(it.a || it.n);
	};
	K.routeUrl = function (it) { return it.x && it.y ? 'https://map.kakao.com/link/to/' + encodeURIComponent(it.n) + ',' + it.y + ',' + it.x : K.mapUrl(it); };
	K.telOf = function (t) { var m = String(t || '').match(/0\d{1,2}[-\s)]?\d{3,4}[-\s]?\d{4}|1\d{3}-?\d{4}/); return m ? m[0].replace(/[\s)]/g, '-') : ''; };
	K.searchUrl = function (q) { return 'https://m.search.naver.com/search.naver?query=' + encodeURIComponent(q); };

	// ── 찜·알림(축제) ─────────────────────────────────────
	K.fav = (typeof YgtFav !== 'undefined') ? YgtFav.make('tour', { title: '찜한 축제 소식' }) : null;
	// 찜 스냅샷(s,e,n)만으로 시작 전날·당일 알림 — 하루 1회
	K.checkFestAlerts = function () {
		if (!K.fav || K.fav.checkedToday()) return;
		var favs = K.fav.favGet(), notified = K.fav.notifiedGet(), evs = [];
		var today = K.dot(new Date()), tmr = K.dot(new Date(Date.now() + 86400000));
		Object.keys(favs).forEach(function (k) {
			var f = favs[k];
			if (!f || !f.s || f.alertEnabled === false) return;
			if (f.s === tmr && !notified[k + '_d1']) { evs.push({ body: '찜한 ' + f.title + ' — 내일 시작해요 (' + f.s + ' ~ ' + f.e + ')', id: k }); notified[k + '_d1'] = Date.now(); }
			else if (f.s === today && !notified[k + '_d0']) { evs.push({ body: '찜한 ' + f.title + ' — 오늘 시작해요', id: k }); notified[k + '_d0'] = Date.now(); }
		});
		if (evs.length) { K.fav.notifiedSet(notified); K.fav.notify(evs, 1102000); }
	};

	// ── 카드 ─────────────────────────────────────────────
	// it: {n,a,i,...}, o: {idx, tags:[[cls,txt]], sub2, heart:true/false/undefined}
	// 사진 없는 항목용 그림 썸네일: 이름 키워드 → 이모지·색 (회색 'NO IMAGE' 대신)
	var PH = [
		[/불꽃|폭죽/, '🎆', '#2b2d6e'], [/해넘이|해맞이|해돋이|일출|일몰|타종|신년/, '🌅', '#e8743b'],
		[/크리스마스|산타|트리|빛|야경|루미나|겨울빛|빛초롱|등/, '🎄', '#1f6f50'], [/눈|얼음|빙어|스케이트|겨울/, '⛄', '#5b8fc9'],
		[/국화|꽃|벚꽃|장미|튤립|코스모스|유채|단풍|은행/, '🌼', '#d98c2b'],
		[/음악|콘서트|재즈|락|록|뮤직|국악|합창/, '🎵', '#7b4fc4'], [/연극|인형극|공연|무용|예술|미술|아트|영화|비엔날레|북|도서/, '🎭', '#b04a7a'],
		[/걷기|걸음|트레킹|마라톤|러닝|런|자전거|길/, '🚶', '#3c8d5a'], [/바다|해변|해수욕|섬|항|포구|수산|굴|전어|멸치|대게|미역/, '🌊', '#2f7fbf'],
		[/김치|김장|먹거리|푸드|음식|맛|대추|곶감|유자|콩|떡|국수|한우|막걸리|맥주|와인|어리굴젓|다슬기|장터|시장|마켓/, '🍽️', '#c0603a'],
		[/역사|문화재|성|읍성|전통|민속|향교|사찰|달집|대보름/, '🏯', '#8a6a3b'], [/캠핑|야영|글램핑|카라반/, '⛺', '#4f7d3a'],
		[/반려|애견|펫/, '🐾', '#a0663a']];
	var PH_KEY = { camp: ['⛺', '#4f7d3a'], pet: ['🐾', '#a0663a'], with: ['♿', '#3d6fb5'], parks: ['🏞️', '#3c8d5a'], forest: ['🌲', '#2f6b45'],
		theme: ['🎢', '#c0603a'], mountain: ['⛰️', '#5a7a4a'], lake: ['🏝️', '#2f7fbf'] };
	K.phOf = function (it, key) {
		var n = String(it.n || '');
		for (var i = 0; i < PH.length; i++) if (PH[i][0].test(n)) return [PH[i][1], PH[i][2]];
		return PH_KEY[key] || ['🎉', '#3069cf'];
	};
	K.thumb = function (it, key) {
		if (it.i) return '<div class="tk-thumb"><img decoding="async" data-src="' + esc(it.i) + '" src="img/no_image.jpg" onerror="TourKit.imgFail(this)"></div>';
		var p = K.phOf(it, key);
		return '<div class="tk-thumb tk-ph" style="background:' + p[1] + '"><span>' + p[0] + '</span></div>';
	};
	// 사진 주소가 깨졌을 때도 그림 썸네일로
	K.imgFail = function (im) {
		var box = im.parentNode;
		if (!box) return;
		var li = box.closest ? box.closest('.tk-item') : null;
		var n = li ? (li.querySelector('.tk-name') || {}).textContent : '';
		var p = K.phOf({ n: n }, typeof LIST_KEY !== 'undefined' ? LIST_KEY : '');
		box.className = 'tk-thumb tk-ph'; box.style.background = p[1]; box.innerHTML = '<span>' + p[0] + '</span>';
	};

	K.card = function (it, o) {
		var h = '<li class="tk-item" data-i="' + o.idx + '">';
		h += K.thumb(it, o.key || (typeof LIST_KEY !== 'undefined' ? LIST_KEY : ''));
		h += '<div class="tk-body"><div class="tk-name">' + esc(it.n) + '</div>';
		h += '<div class="tk-sub">' + esc(o.sub || it.a || '') + '</div>';
		if (o.sub2) h += '<div class="tk-sub">' + esc(o.sub2) + '</div>';
		var tags = (o.tags || []).slice();
		var dk = K.dist(it);
		if (isFinite(dk)) tags.push(['dist', K.distTxt(dk)]);
		if (tags.length) h += '<div class="tk-tags">' + tags.map(function (t) { return '<span class="tk-tag ' + t[0] + '">' + esc(t[1]) + '</span>'; }).join('') + '</div>';
		h += '</div>';
		if (o.heart !== undefined) h += '<div class="tk-heart' + (o.heart ? ' on' : '') + '" data-h="' + o.idx + '">♥</div>';
		return h + '</li>';
	};
	// 목록 컨테이너에 클릭 위임: onOpen(idx), onHeart(idx, el)
	K.bind = function (root, onOpen, onHeart) {
		$(root).off('click.tk').on('click.tk', '.tk-item', function (e) {
			var hh = $(e.target).closest('.tk-heart');
			if (hh.length && onHeart) { e.stopPropagation(); onHeart(Number(hh.attr('data-h')), hh); return; }
			onOpen(Number($(this).attr('data-i')));
		});
	};

	// 이미지 지연 로딩(스크롤 근처만)
	K.lazy = function (root) {
		var imgs = (root || document).querySelectorAll('img[data-src]');
		var load = function (im) { var s = im.getAttribute('data-src'); if (s) im.src = s; im.removeAttribute('data-src'); };
		if (!('IntersectionObserver' in window)) { for (var i = 0; i < imgs.length; i++) load(imgs[i]); return; }
		var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { load(e.target); io.unobserve(e.target); } }); }, { rootMargin: '300px 0px' });
		for (var j = 0; j < imgs.length; j++) io.observe(imgs[j]);
	};

	// ── 상세 시트 ─────────────────────────────────────────
	// o: {it, title, img, rows:[[k,v(html)]], desc, wxDate, links:[{label,href,pri}], fav:{on, toggle()}}
	K.sheet = function (o) {
		if ($('.tk-wrap').length) $('.tk-wrap').remove();
		var it = o.it || {};
		var h = '<div class="tk-dim"></div><div class="tk-sheet" role="dialog">';
		h += '<div class="tk-sheet-head"><div class="tk-sheet-title">' + esc(o.title || it.n) + '</div><div class="tk-sheet-x">×</div></div>';
		h += '<div class="tk-sheet-body">';
		var img = o.img || it.I || it.i;
		// 큰 사진(I) 실패 시 썸네일(i)로, 그것도 실패하면 숨김 (검색 사진 원본은 외부 사이트라 막힐 수 있음)
		var small = (it.i && it.i !== img) ? it.i : '';
		if (img) h += '<div class="tk-hero"><img src="' + esc(img) + '" data-s="' + esc(small) + '" onerror="var s=this.getAttribute(\'data-s\');if(s){this.removeAttribute(\'data-s\');this.src=s;}else{this.parentNode.style.display=\'none\'}"></div>';
		h += '<div class="tk-wx-slot"></div>';
		var rows = (o.rows || []).filter(function (r) { return r[1]; });
		if (rows.length) h += '<div class="tk-rows">' + rows.map(function (r) { return '<div class="tk-row"><div class="k">' + esc(r[0]) + '</div><div class="v">' + r[1] + '</div></div>'; }).join('') + '</div>';
		if (o.desc) h += '<div class="tk-desc">' + esc(o.desc) + '</div>';
		h += '</div><div class="tk-btns">';
		if (o.fav) h += '<a class="tk-btn fav' + (o.fav.on ? ' on' : '') + '">' + (o.fav.on ? '♥ 찜함' : '♡ 찜') + '</a>';
		(o.links || []).forEach(function (l) { h += '<a class="tk-btn' + (l.pri ? ' pri' : '') + '" href="' + esc(l.href) + '" target="' + (/^tel:/.test(l.href) ? '_self' : '_blank') + '">' + esc(l.label) + '</a>'; });
		h += '</div></div>';
		var $w = $('<div class="tk-wrap"></div>').html(h).appendTo('body');
		setTimeout(function () { $w.find('.tk-dim,.tk-sheet').addClass('show'); }, 10);
		$w.find('.tk-dim,.tk-sheet-x').on('click', function () { if (K._pushed) history.back(); else K.closeSheet(); });
		if (o.fav) $w.find('.tk-btn.fav').on('click', function () {
			var on = o.fav.toggle();
			$(this).toggleClass('on', on).text(on ? '♥ 찜함' : '♡ 찜');
		});
		if (it.w || it.a) K.wx().then(function (W) { $w.find('.tk-wx-slot').html(K.wxHtml(W, it, o.wxDate)); });
		if (history.pushState) { history.pushState({ tk: 1 }, ''); K._pushed = true; }
	};
	K.closeSheet = function () {
		K._pushed = false;
		var $w = $('.tk-wrap');
		if (!$w.length) return;
		$w.find('.tk-dim,.tk-sheet').removeClass('show');
		setTimeout(function () { $w.remove(); }, 220);
	};
	// 안드로이드 뒤로가기 → 시트만 닫기
	window.addEventListener('popstate', function () { if ($('.tk-wrap').length) K.closeSheet(); });

	// 링크 행 HTML
	K.aTag = function (href, txt) { return '<a href="' + esc(href) + '" target="' + (/^tel:/.test(href) ? '_self' : '_blank') + '">' + esc(txt) + '</a>'; };

	return K;
})();

// 모든 여행 페이지 진입 시 축제 찜 알림 검사
$(function () { try { TourKit.checkFestAlerts(); } catch (e) { } });
