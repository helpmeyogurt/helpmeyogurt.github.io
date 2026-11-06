// 공용 찜·로컬알림 모듈 (movie/perform 등) — book의 찜/알림 패턴 일반화.
//  · 순수 로직 + localStorage — DOM 없음(카드 배선은 각 렌더러가), node 단위테스트 가능.
//  · 네임스페이스별 저장: ygt_<ns>_favs / _persons / _notified / _notif_log / _favcheck_day
//  · 알림은 서버푸시 아님 — 앱 실행/페이지 진입 시 계산 → yogurtLocalNotify 브리지(로컬 알림).
//  · 데이터 실패 시 알림 보류는 호출부 책임 (리스트가 비면 rankEvents가 OUT을 내지 않도록 가드 내장).
// 테스트: apps/yogurt_app/tool/book_bestseller/test_fav_alerts.js
'use strict';

var YgtFav = (function () {

	function jget(k, d) { try { return JSON.parse(localStorage.getItem(k) || d); } catch (e) { try { return JSON.parse(d); } catch (e2) { return null; } } }
	function jset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }

	function make(ns, opts) {
		opts = opts || {};
		var K = function (n) { return 'ygt_' + ns + '_' + n; };
		var api = { ns: ns, title: opts.title || '알림' };

		// ---------------------------------------------------------- 찜(항목: 영화/공연)
		api.favGet = function () { return jget(K('favs'), '{}') || {}; };
		api.favSet = function (o) { jset(K('favs'), o); };
		api.isFav = function (id) { return !!api.favGet()[id]; };
		// snap: {title, img, link, extra...} — 목록 이탈 후에도 표시할 스냅샷
		api.favToggle = function (id, snap) {
			var f = api.favGet();
			if (f[id]) { delete f[id]; } else { f[id] = Object.assign({ createdAt: Date.now(), alertEnabled: true }, snap || {}); }
			api.favSet(f);
			return !!api.favGet()[id];
		};

		// ---------------------------------------------------------- 인물 찜(감독 등)
		// seedPending: 찜 직후 첫 데이터에서 기존 작품을 알림 없이 기준점으로 시딩
		api.personGet = function () { return jget(K('persons'), '{}') || {}; };
		api.personSet = function (o) { jset(K('persons'), o); };
		api.personKey = function (name) { return String(name || '').toLowerCase().replace(/\(.*?\)/g, '').split(/[,\/·;&]/)[0].replace(/[^0-9a-z가-힣]+/g, ''); };
		api.isPerson = function (name) { return !!api.personGet()[api.personKey(name)]; };
		api.personToggle = function (name) {
			var pk = api.personKey(name);
			if (!pk) return false;
			var p = api.personGet();
			if (p[pk]) { delete p[pk]; } else { p[pk] = { name: name, createdAt: Date.now(), seedPending: true }; }
			api.personSet(p);
			return !!api.personGet()[pk];
		};
		function personMatch(favName, itemName) {
			var a = api.personKey(favName), b = api.personKey(itemName);
			if (!a || !b) return false;
			return a === b || a.indexOf(b) !== -1 || b.indexOf(a) !== -1;
		}

		// ---------------------------------------------------------- 알림 이력/중복 방지
		api.notifiedGet = function () { return jget(K('notified'), '{}') || {}; };
		api.notifiedSet = function (o) {
			var keys = Object.keys(o);
			if (keys.length > 400) { keys.sort(function (a, b) { return o[a] - o[b]; }).slice(0, keys.length - 400).forEach(function (k) { delete o[k]; }); }
			jset(K('notified'), o);
		};
		api.logGet = function () { return jget(K('notif_log'), '[]') || []; };
		// events: [{body, title, link, id?}]
		api.logAdd = function (events) {
			var log = api.logGet();
			events.forEach(function (ev) { log.unshift({ t: Date.now(), body: ev.body, title: ev.title || '', link: ev.link || '' }); });
			jset(K('notif_log'), log.slice(0, 50));
		};

		// ---------------------------------------------------------- 순위 이벤트 (찜 항목 × 현재 목록)
		// list: [{id, rank, title, link?}] (전체 목록), periodKey: 집계 기준(일자 등),
		// o: {top:10, rise:5, drop:5, outMax: 목록성격상 이탈판정 가능한 최대순위(기본 top)}
		// 반환: [{id, body, title, link, keys[]}] — 항목당 1건(우선순위 TOP > RISE > DROP > OUT)
		api.rankEvents = function (list, periodKey, o) {
			o = o || {};
			var top = o.top || 10, rise = o.rise || 5, drop = o.drop || rise;
			var favs = api.favGet();
			var notified = api.notifiedGet();
			var byId = {};
			(list || []).forEach(function (it) { if (it && it.id !== undefined) byId[it.id] = it; });
			var out = [];
			var changed = false;
			Object.keys(favs).forEach(function (id) {
				var f = favs[id];
				if (f.alertEnabled === false) return;
				var cur = byId[id];
				var prev = f.lastPeriod ? f.lastKnownRank : null; // 첫 관측(찜 직후)은 prev 없음 → TOP만 발화 가능
				var evs = [];
				if (cur) {
					if (cur.rank <= top && (!prev || prev > top)) evs.push({ type: 'TOP', txt: 'TOP ' + top + '에 들었어요 (' + cur.rank + '위)' });
					else if (prev && (prev - cur.rank) >= rise) evs.push({ type: 'RISE', txt: (prev - cur.rank) + '계단 올라 ' + cur.rank + '위가 됐어요' });
					else if (prev && (cur.rank - prev) >= drop) evs.push({ type: 'DROP', txt: (cur.rank - prev) + '계단 내려가 ' + cur.rank + '위가 됐어요' });
				} else if (prev && list && list.length) {
					evs.push({ type: 'OUT', txt: '순위권 밖으로 내려갔어요 (직전 ' + prev + '위)' });
				}
				// 기준 순위 갱신 (이벤트 유무와 무관)
				if (list && list.length) {
					var nr = cur ? cur.rank : null;
					if (f.lastKnownRank !== nr || f.lastPeriod !== periodKey) { f.lastKnownRank = nr; f.lastPeriod = periodKey; changed = true; }
				}
				if (!evs.length) return;
				var ev = evs[0]; // 항목당 대표 1건
				var key = id + '|' + periodKey + '|' + ev.type;
				if (notified[key]) return;
				notified[key] = Date.now();
				out.push({ id: id, body: '찜한 ‘' + (f.title || (cur && cur.title) || '') + '’이(가) ' + ev.txt + '.', title: f.title || '', link: f.link || (cur && cur.link) || '' });
			});
			if (out.length || changed) { api.favSet(favs); api.notifiedSet(notified); }
			return out;
		};

		// ---------------------------------------------------------- 인물 신작 이벤트
		// list: [{id, title, person, link?}] — 감독/제작자 등이 person 필드
		api.personEvents = function (list, label) {
			label = label || '신작';
			var persons = api.personGet();
			var pks = Object.keys(persons);
			if (!pks.length || !list || !list.length) return [];
			var notified = api.notifiedGet();
			var changed = false;
			var out = [];
			pks.forEach(function (pk) {
				var p = persons[pk];
				if (p.alertEnabled === false) return;
				var fresh = [];
				list.forEach(function (it) {
					if (!it.person || !personMatch(p.name, it.person)) return;
					var key = 'PNEW|' + pk + '|' + (it.id || it.title);
					if (notified[key]) return;
					if (p.seedPending) { notified[key] = Date.now(); changed = true; return; } // 시딩(무알림)
					notified[key] = Date.now(); changed = true;
					fresh.push(it);
				});
				if (p.seedPending) { delete p.seedPending; changed = true; }
				if (!fresh.length) return;
				var first = fresh[0];
				out.push({
					body: fresh.length === 1
						? '찜한 ‘' + p.name + '’의 ' + label + ' ‘' + first.title + '’이(가) 등장했어요.'
						: '찜한 ‘' + p.name + '’의 ' + label + ' ' + fresh.length + '편 — ‘' + first.title + '’ 외 ' + (fresh.length - 1) + '편',
					title: first.title, link: first.link || '',
				});
			});
			if (changed) { api.personSet(persons); api.notifiedSet(notified); }
			return out;
		};

		// ---------------------------------------------------------- 알림 발송 + 이력 (요약 우선)
		api.notify = function (events, baseId) {
			if (!events || !events.length) return;
			api.logAdd(events);
			var msgs = events.length >= 3
				? [{ id: baseId, title: api.title, body: events.length + '건의 새 소식 — ' + events[0].body.replace(/^찜한 /, '') }]
				: events.map(function (ev, i) { return { id: baseId + i, title: api.title, body: ev.body }; });
			if (typeof window !== 'undefined' && window.flutter_inappwebview && window.flutter_inappwebview.callHandler) {
				msgs.forEach(function (m) { window.flutter_inappwebview.callHandler('yogurtLocalNotify', m); });
			} else if (typeof console !== 'undefined') { console.log('YgtFav.notify(no bridge):', JSON.stringify(msgs)); }
		};

		// 하루 1회 검사 스탬프
		api.checkedToday = function () {
			var d = new Date(Date.now() + 9 * 3600 * 1000);
			var p = function (n) { return (n < 10 ? '0' : '') + n; };
			var today = '' + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate());
			if (localStorage.getItem(K('favcheck_day')) === today) return true;
			try { localStorage.setItem(K('favcheck_day'), today); } catch (e) { }
			return false;
		};

		return api;
	}

	return { make: make };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = YgtFav;
