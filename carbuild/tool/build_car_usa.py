# -*- coding: utf-8 -*-
"""GCBC(goodcarbadcar.net) 미국 월간 판매 -> data_car_usa_month.js 재생성.

기존 데이터(201601~202312)는 그대로 보존하고 202401 이후를 GCBC 연도 페이지의
월별 테이블(Model | Jan..Dec)에서 이어붙인다. 섹션 구성(기존과 동일):
  s0 전체 top100 / s1 승용차 top50 / s2 SUV top50 / s3 픽업트럭 top15
  s4 고급차 = 2018.10부터 승용차 통합(빈 배열 유지)
승용차 = GCBC 차급 페이지(compact/midsize/small/large/sports) 합집합.

주의: 기존 파일의 s1 앞 12개(2025년 부분 갱신분)는 월 라벨 정렬이 깨져 있어
버리고 GCBC 데이터로 대체한다 (202501 Camry 19,007 일치 검증 포함).

실행: py -3 tool/build_car_usa.py   (apps/yogurt_app에서, 원본 HTML은 raw에 캐시)
출력: assets/html/car/data/data_car_usa_month.js 재작성
      + ygt0904_Car_USA_Month.html 의 월 옵션/update 갱신
"""

import datetime
import json
import os
import re
import sys
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(BASE, "tool", "raw", "car", "gcbc")
DATA = os.path.join(BASE, "assets", "html", "car", "data", "data_car_usa_month.js")
HTML = os.path.join(BASE, "assets", "html", "car", "ygt0904_Car_USA_Month.html")
OLD_JSON = os.path.join(BASE, "tool", "raw", "car", "usa_old.json")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

# 2024는 GCBC 멤버십(유료) 게이트 뒤라 수집하지 않음 (우회 금지 원칙) — 데이터 공백.
# 무료로 공개되는 전년+당해년만 수집. carfigures.com은 SPA 렌더라 정적 수집 불가 확인(2026-07).
# 2025년부터 올해까지(2024는 GCBC 유료 게이트로 공백) — 해가 바뀌면 자동으로 늘어남
YEARS = list(range(2025, datetime.date.today().year + 1))
# 연도별로 슬러그가 "us" / "u-s" 로 다름 -> 후보를 순서대로 시도
SEG_URLS = {
    "all": ["%d-us-auto-sales-figures-by-model-all-vehicle-ranked",
            "%d-u-s-auto-sales-figures-by-model-all-vehicle-ranked",
            "%d-u-s-auto-sales-figures-by-model-all-vehicle-ranked-2"],
    "suv": ["%d-us-suv-sales-figures-by-model-with-rankings",
            "%d-u-s-suv-sales-figures-by-model-with-rankings"],
    "pickup": ["%d-us-pickup-truck-sales-figures-by-model-with-rankings",
               "%d-u-s-pickup-truck-sales-figures-by-model-with-rankings"],
    "van": ["%d-us-commercial-van-sales-figures-by-model-with-rankings",
            "%d-u-s-commercial-van-sales-figures-by-model-with-rankings"],
    "minivan": ["%d-us-minivan-sales-figures-by-model-with-rankings",
                "%d-u-s-minivan-sales-figures-by-model-with-rankings"],
    # 승용차 통합 페이지 (2024/2025 존재, 2026 미존재 -> 차감 방식 폴백)
    "passenger": ["%d-us-passenger-car-sales-figures-by-model-with-rankings",
                  "%d-u-s-passenger-car-sales-figures-by-model-with-rankings"],
}
TOP_N = {"all": 100, "car": 50, "suv": 50, "pickup": 15, "minivan": 10, "van": 12}


def get_series(year, seg):
    """월별 테이블 파싱 결과 반환. 슬러그 변형을 순서대로 시도, 존재하지 않으면
    (catch-all 홈페이지 응답 = 월별 테이블 없음) None."""
    os.makedirs(RAW, exist_ok=True)
    cache = os.path.join(RAW, "%d-%s.html" % (year, seg))
    if os.path.exists(cache) and os.path.getsize(cache) > 100000:
        with open(cache, encoding="utf-8", errors="replace") as f:
            try:
                return parse_monthly(f.read(), year, seg)
            except RuntimeError:
                os.remove(cache)
    import time
    for attempt in range(3):  # 서버 캐시가 빈 로더/홈페이지를 반환하기도 함 -> nocache로 재시도
        for slug in SEG_URLS[seg]:
            url = "https://www.goodcarbadcar.net/" + (slug % year) + "/?nocache=%d" % int(time.time())
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=90) as r:
                html = r.read().decode("utf-8", "replace")
            try:
                data = parse_monthly(html, year, seg)
            except RuntimeError:
                time.sleep(1)
                continue  # catch-all / 월별 테이블 없음 -> 다음 변형
            with open(cache, "w", encoding="utf-8") as f:
                f.write(html)
            print("fetched %d %s (%s, %d rows)" % (year, seg, slug % year, len(data)))
            return data
        time.sleep(5)
    return None


def parse_monthly(html, year, seg):
    """월별(Model|Jan..Dec) 데이터 행 -> {model: [12 months]}.

    wpDataTables 마크업이 페이지에 따라 실제 tbody를 <table> 요소 밖에 두는
    경우가 있어, 테이블 단위 슬라이스 대신 페이지 전체 tbody에서
    '모델명 + 숫자 12개 이상' 패턴의 행만 골라낸다 (월별 테이블만 12개 숫자열).
    """
    if not (re.search(r">\s*Jan\s*<", html) and re.search(r">\s*Dec\s*<", html)):
        raise RuntimeError("monthly header not found: %d %s (catch-all?)" % (year, seg))
    out = {}
    for tbody in re.findall(r"<tbody[\s\S]*?</tbody>", html):
        rows = {}
        for tr in re.findall(r"<tr[\s\S]*?</tr>", tbody):
            cells = [re.sub(r"<[^>]+>", "", c).replace("&amp;", "&").strip()
                     for c in re.findall(r"<td[^>]*>([\s\S]*?)</td>", tr)]
            cells = [c for c in cells if c != ""]
            if not cells:
                continue
            model = cells[0]
            nums = []
            for c in cells[1:]:
                c2 = c.replace(",", "")
                if re.fullmatch(r"-?\d+(\.\d+)?", c2):
                    nums.append(int(float(c2)))
                elif c2 in ("&ndash;", "–", "-", "&mdash;", "—"):
                    # 아직 지나지 않은 달은 '–'로 표시됨(연중 페이지) → 0. 예전엔 이 행을 통째로 버려
                    # 7월 이후 2026 페이지를 못 읽고 6월에서 멈췄음(2026-11-06 수정)
                    nums.append(0)
            if len(nums) < 12 or not model or re.fullmatch(r"[\d,.]+", model):
                continue
            rows[model] = nums[:12]
        # 여러 tbody 중 유효 행이 가장 많은 것이 월별 테이블
        if len(rows) > len(out):
            out = rows
    if len(out) < 5:
        raise RuntimeError("too few rows: %d %s (%d)" % (year, seg, len(out)))
    return out


def comma(n):
    return format(n, ",")


def month_entries(series, year, mon, top_n):
    """series: {model: {(y,m): sell}} -> 해당 월 순위 엔트리 리스트 (기존 포맷)."""
    rows = []
    for model, mm in series.items():
        v = mm.get((year, mon), 0)
        if v > 0:
            rows.append((model, v))
    rows.sort(key=lambda x: (-x[1], x[0]))
    entries = []
    ym = "%04d%02d" % (year, mon)
    for i, (model, v) in enumerate(rows[:top_n], 1):
        mm = series[model]
        ytd = sum(mm.get((year, k), 0) for k in range(1, mon + 1))
        py, pm = (year, mon - 1) if mon > 1 else (year - 1, 12)
        prev = mm.get((py, pm))
        if prev:
            chg = (v - prev) / prev * 100
            chg_s = "%+.2f%%" % chg
            prev_s = comma(prev)
        else:
            chg_s, prev_s = "", ""
        entries.append({
            "month": ym, "rank": str(i), "car": model, "sell": comma(v),
            "prev": prev_s, "change": chg_s, "ytd": comma(ytd),
            "prev-ytd": "", "change-ytd": "",
        })
    return entries


def main():
    # 1) 기존 데이터 (node로 평가해 JSON 덤프 — 주석 섞인 JS라 직접 파싱 안 함)
    if not os.path.exists(OLD_JSON):
        raise RuntimeError("먼저 node로 usa_old.json을 만들어야 함 (README 참조)")
    with open(OLD_JSON, encoding="utf-8") as f:
        old = json.load(f)  # [5][96] — 202312..201601, s1은 2025 프리픽스 제거본

    # 2) GCBC 수집: seg -> {model: {(y,m): v}}
    seg_series = {s: {} for s in SEG_URLS}
    missing = []
    for seg in SEG_URLS:
        for year in YEARS:
            data = get_series(year, seg)
            if data is None:
                missing.append((year, seg))
                continue
            for model, months in data.items():
                d = seg_series[seg].setdefault(model, {})
                for i, v in enumerate(months, 1):
                    if v > 0:
                        d[(year, i)] = v
    for year, seg in missing:
        # passenger: 없으면 차감 방식으로 보완. van/minivan: 차감용 모델명 집합에만
        # 쓰이므로 가용 연도의 모델명으로 충분 (모델 구성은 연도간 거의 동일).
        if seg not in ("passenger", "van", "minivan"):
            raise RuntimeError("페이지 없음: %d %s" % (year, seg))
        print("  페이지 없음(허용): %d %s" % (year, seg))

    # 미니밴/밴: 해당 연도 세그먼트 페이지가 아직 없으면(예: 2026 minivan),
    # GCBC 자체 분류(가장 최근 세그먼트 페이지의 모델 구성)를 그대로 써서
    # 전체(all) 테이블에서 해당 모델들의 값을 보충한다 — 임의 분류 아님.
    for seg in ("minivan", "van"):
        seg_models = set(seg_series[seg].keys())
        for model in seg_models:
            all_mm = seg_series["all"].get(model, {})
            d = seg_series[seg][model]
            for (y, m), v in all_mm.items():
                if (y, m) not in d:
                    d[(y, m)] = v

    # 승용차 = passenger 페이지 (있는 연도) + 없으면 전체 - SUV/픽업/밴/미니밴
    car_series = {}
    for model, mm in seg_series["passenger"].items():
        car_series.setdefault(model, {}).update(mm)
    non_car = set()
    for seg in ("suv", "pickup", "van", "minivan"):
        non_car.update(seg_series[seg].keys())
    pass_years = {y for mm in seg_series["passenger"].values() for (y, _m) in mm}
    for model, mm in seg_series["all"].items():
        if model in non_car:
            continue
        for (y, m), v in mm.items():
            if y not in pass_years:
                car_series.setdefault(model, {})[(y, m)] = v

    # 3) 신규 월 범위: 202501 ~ 전체 테이블에 값이 있는 마지막 달 (2024 = 유료 게이트 공백)
    last = None
    for year in reversed(YEARS):
        for mon in range(12, 0, -1):
            if any(mm.get((year, mon), 0) > 0 for mm in seg_series["all"].values()):
                last = (year, mon)
                break
        if last:
            break
    if last is None or last < (2025, 12):
        raise RuntimeError("GCBC 신규 데이터가 비정상 (last=%s)" % (last,))
    print("최신 데이터 월:", last)

    new_months = []  # 최신 -> 202501 (내림차순)
    y, m = last
    while (y, m) >= (2025, 1):
        new_months.append((y, m))
        m -= 1
        if m == 0:
            y, m = y - 1, 12

    sections = [
        ("all", seg_series["all"], TOP_N["all"]),
        ("car", car_series, TOP_N["car"]),
        ("suv", seg_series["suv"], TOP_N["suv"]),
        ("pickup", seg_series["pickup"], TOP_N["pickup"]),
        ("lux", None, 0),  # 2018.10 이후 승용차 통합 — 빈 배열
        ("minivan", seg_series["minivan"], TOP_N["minivan"]),  # 2025~ (구버전 미수집)
        ("van", seg_series["van"], TOP_N["van"]),              # 상용밴, 2025~
    ]

    # 교차 검증: 기존 s1의 2025-01 1위(Camry 19,007)와 GCBC 값 일치해야 함
    camry = car_series.get("Toyota Camry", {}).get((2025, 1))
    if camry != 19007:
        print("WARN: 202501 Camry GCBC=%s (기존 데이터 19,007과 다름)" % camry)

    new_arr = []
    for si, (name, series, top_n) in enumerate(sections):
        month_arrays = []
        for (yy, mm) in new_months:
            month_arrays.append(month_entries(series, yy, mm, top_n) if series else [])
        # 기존분 (202312..201601) — 구버전에 없던 섹션(미니밴/밴)은 빈 배열
        month_arrays.extend(old[si] if si < len(old) else [[] for _ in old[0]])
        new_arr.append(month_arrays)

    # 4) JS 파일 재작성 (기존 헤더 주석 스타일 유지)
    sec_titles = ["전체순위", "승용차", "SUV", "픽업트럭", "고급차", "미니밴", "상용밴"]
    star = "//" + "*" * 100
    out = []
    out.append("// 미국 자동차 월간판매순위")
    out.append("")
    out.append("// ~202312: goodcarbadcar.net (구버전 수집분 보존)")
    out.append("// 202401~: goodcarbadcar.net 연도별 모델 테이블 (tool/build_car_usa.py 생성, 수동 편집 금지)")
    out.append("")
    out.append("")
    out.append("var arrUsaMonth =")
    out.append("")
    out.append("[")
    for si, arr in enumerate(new_arr):
        out.append("")
        out.append(star)
        out.append("//%s %s" % (sec_titles[si], "*" * (98 - len(sec_titles[si]) * 2)))
        out.append(star)
        out.append("")
        out.append("[")
        for month_arr in arr:
            if not month_arr:
                out.append("\t[],")
                continue
            out.append("\t[" + ",\n".join(json.dumps(e, ensure_ascii=False) for e in month_arr) + "],")
        out.append("],")
        out.append("")
    out.append("]")
    out.append("")
    # 월 목록(신규월 + 2023.12~2016.01) — 데이터 배열 순번과 1:1 (렌더러가 선택 순번으로 데이터를 꺼냄)
    all_months = ["%04d%02d" % (yy, mm) for (yy, mm) in new_months]
    yy, mm = 2023, 12
    while (yy, mm) >= (2016, 1):
        all_months.append("%04d%02d" % (yy, mm))
        mm -= 1
        if mm == 0:
            yy, mm = yy - 1, 12
    # 데이터 파일이 페이지의 월 선택 목록을 직접 맞춤: 구버전 앱 HTML은 월 목록이 고정이라
    # 원격 데이터만 새로 받으면 '6월' 자리에 10월 데이터가 나오는 어긋남이 생김 → 여기서 교정
    out.append("var usaMonthOpts = " + json.dumps(all_months) + ";")
    out.append("(function () {")
    out.append("\tvar s = document.getElementById('sel_month');")
    out.append("\tif (!s) return;")
    out.append("\tif (s.options.length === usaMonthOpts.length && s.options[0] && s.options[0].value === usaMonthOpts[0]) return;")
    out.append("\tvar h = '';")
    out.append("\tfor (var i = 0; i < usaMonthOpts.length; i++) { var m = usaMonthOpts[i]; h += '<option value=\"' + m + '\"' + (i === 0 ? ' selected' : '') + '>' + m.slice(0, 4) + '년 ' + m.slice(4) + '월</option>'; }")
    out.append("\ts.innerHTML = h;")
    out.append("\tif (s.parentNode) { var nx = document.querySelector('.button-next'); if (nx) nx.style.display = 'none'; }")
    out.append("})();")
    out.append("")
    with open(DATA, "w", encoding="utf-8") as f:
        f.write("\n".join(out))

    # 5) 0904 HTML 월 옵션 + update 스탬프 재생성 (번들용, HTML 없으면 생략 — github.io 자동 수집에선 데이터만)
    if not os.path.exists(HTML):
        print("OK -> %s (월 %d개: %s ~ 201601, HTML 생략)" % (DATA, len(all_months), all_months[0]))
        return
    opts = []
    for i, ym in enumerate(all_months):
        sel = " selected" if i == 0 else ""
        opts.append('\t\t\t\t\t\t<option value="%s"%s>%s년 %s월</option>' % (ym, sel, ym[:4], ym[4:]))
    with open(HTML, encoding="utf-8") as f:
        html = f.read()
    html = re.sub(r'(<select id="sel_month"[^>]*>)[\s\S]*?(</select>)',
                  lambda m: m.group(1) + "\n" + "\n".join(opts) + "\n\t\t\t\t\t" + m.group(2),
                  html, count=1)
    html = re.sub(r'var update = "[^"]*";',
                  'var update = "%s";' % datetime.date.today().strftime("%Y.%m.%d"), html)
    with open(HTML, "w", encoding="utf-8") as f:
        f.write(html)

    print("OK -> %s (월 %d개: %s ~ 201601)" % (DATA, len(all_months), all_months[0]))
    for si, t in enumerate(sec_titles):
        ne = sum(1 for a in new_arr[si] if a)
        print("  %s: %d/%d개월 데이터" % (t, ne, len(new_arr[si])))


if __name__ == "__main__":
    main()
