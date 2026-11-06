# -*- coding: utf-8 -*-
"""미국 자동차 시장 총량 (FRED + BEA 병합) -> data_car_usa_total.js 베이크.

1순위 FRED API (api.stlouisfed.org, 무료 키), 2순위 BEA API (NIUnderlyingDetail
U70205S) — 같은 지표를 양쪽에서 받아 **빈 월을 서로 채운다** (값이 둘 다 있으면
FRED 우선, 원천은 동일한 BEA 통계라 사실상 일치). BEA 키 미활성/실패 시 FRED
단독으로 동작.

단위: 천 대(원본) -> 대(베이크). 월간, 계절조정 없음(NSA).
키: .secret/fred_api_key.txt / .secret/bea_api_key.txt (git-ignored)

실행: py -3 tool/build_car_usa_total.py   (apps/yogurt_app에서)
원본 응답은 tool/raw/car/fred/, tool/raw/car/bea/ 에 날짜별 보관.
출력: assets/html/car/data/data_car_usa_total.js
"""

import datetime
import json
import os
import urllib.parse
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(BASE, "tool", "raw", "car")
OUT = os.path.join(BASE, "assets", "html", "car", "data", "data_car_usa_total.js")

# 지표 키 -> FRED 시리즈 id (전부 Thousands of Units, Monthly NSA)
FRED_SERIES = {
    "total": "TOTALNSA",      # 전체 (경량차 + 대형트럭)
    "lt": "LTOTALNSA",        # 경량차 (승용 + 경트럭)
    "auto": "LAUTONSA",       # 승용차 (국산 + 수입)
    "ltruck": "LTRUCKNSA",    # 경트럭 (SUV/픽업/밴 포함)
    "dauto": "DAUTONSA",      # 국산 승용
    "fauto": "FAUTONSA",      # 수입 승용
    "dltruck": "DLTRUCKSNSA", # 국산 경트럭
    "fltruck": "FLTRUCKSNSA", # 수입 경트럭
    "htruck": "HTRUCKSNSA",   # 대형트럭
}

# BEA U70205S LineDescription -> 지표 키 (활성화되면 자동 병합)
BEA_LINES = {
    "Total vehicle sales": "total",
    "Total light vehicle sales": "lt",
    "Total auto sales": "auto",
    "Total light truck sales": "ltruck",
    "Domestic auto sales": "dauto",
    "Foreign auto sales": "fauto",
    "Domestic light truck sales": "dltruck",
    "Foreign light truck sales": "fltruck",
    "Heavy truck sales": "htruck",
}


def read_key(name):
    path = os.path.join(BASE, ".secret", name)
    if not os.path.exists(path):
        return None
    with open(path, encoding="ascii") as f:
        return f.read().strip()


def save_raw(kind, name, text):
    d = os.path.join(RAW, kind, datetime.date.today().strftime("%Y"), datetime.date.today().strftime("%m"))
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, name), "w", encoding="utf-8") as f:
        f.write(text)


def http_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8")


def fetch_fred(key):
    """{지표: {ym: 대수}}"""
    out = {}
    for metric, sid in FRED_SERIES.items():
        url = ("https://api.stlouisfed.org/fred/series/observations?"
               + urllib.parse.urlencode({"series_id": sid, "api_key": key, "file_type": "json"}))
        text = http_json(url)
        save_raw("fred", sid + ".json", text)
        obs = json.loads(text)["observations"]
        d = {}
        for o in obs:
            if o["value"] in (".", "", None):
                continue
            ym = o["date"][:7].replace("-", "")
            d[ym] = int(round(float(o["value"]) * 1000))  # 천 대 -> 대
        out[metric] = d
        print("  FRED %-8s %-12s %d개월 (~%s)" % (metric, sid, len(d), max(d) if d else "-"))
    return out


def fetch_bea(key):
    """{지표: {ym: 대수}} — 실패/미활성 시 None"""
    try:
        url = ("https://apps.bea.gov/api/data/?"
               + urllib.parse.urlencode({"UserID": key, "method": "GetData",
                                         "DataSetName": "NIUnderlyingDetail",
                                         "TableName": "U70205S", "Frequency": "M",
                                         "Year": "ALL", "ResultFormat": "JSON"}))
        text = http_json(url)
        j = json.loads(text)
        res = j["BEAAPI"]["Results"]
        if isinstance(res, dict) and "Error" in res:
            print("  BEA 사용 불가: %s" % res["Error"].get("APIErrorDescription"))
            return None
        save_raw("bea", "U70205S.json", text)
        out = {m: {} for m in FRED_SERIES}
        for row in res["Data"]:
            metric = BEA_LINES.get(row.get("LineDescription", "").strip())
            if metric is None:
                continue
            tp = row["TimePeriod"]  # 2026M06
            if "M" not in tp:
                continue
            ym = tp.replace("M", "")
            v = float(row["DataValue"].replace(",", ""))
            out[metric][ym] = int(round(v * 1000))  # 천 대 -> 대
        for m in out:
            if out[m]:
                print("  BEA  %-8s %d개월 (~%s)" % (m, len(out[m]), max(out[m])))
        return out
    except Exception as e:
        print("  BEA 조회 실패 (%s) — FRED 단독 진행" % e)
        return None


def main():
    fred_key = read_key("fred_api_key.txt")
    if not fred_key:
        raise RuntimeError(".secret/fred_api_key.txt 없음")
    bea_key = read_key("bea_api_key.txt")

    print("FRED 수집...")
    fred = fetch_fred(fred_key)
    bea = None
    if bea_key:
        print("BEA 수집...")
        bea = fetch_bea(bea_key)

    # 병합: FRED 우선, 빈 월은 BEA로 채움 (지표×월 단위)
    months = set()
    merged = {}
    fill_cnt = 0
    for metric in FRED_SERIES:
        d = dict(fred.get(metric, {}))
        if bea and bea.get(metric):
            for ym, v in bea[metric].items():
                if ym not in d:
                    d[ym] = v
                    fill_cnt += 1
        merged[metric] = d
        months.update(d.keys())
    months = sorted(months)
    if bea:
        print("BEA로 채운 빈 값: %d개" % fill_cnt)

    # 검증: 합계 정합 (반올림 오차 허용), 음수 금지
    bad = 0
    for ym in months:
        t = merged["total"].get(ym)
        lt = merged["lt"].get(ym)
        a, l = merged["auto"].get(ym), merged["ltruck"].get(ym)
        h = merged["htruck"].get(ym)
        for m in FRED_SERIES:
            v = merged[m].get(ym)
            if v is not None and v < 0:
                raise RuntimeError("음수: %s %s" % (m, ym))
        if a is not None and l is not None and lt is not None and abs((a + l) - lt) > 2000:
            bad += 1
        if lt is not None and h is not None and t is not None and abs((lt + h) - t) > 2000:
            bad += 1
    if bad:
        print("WARN: 합계 불일치 %d건 (>2천대)" % bad)

    rows = []
    for ym in months:
        row = {"ym": ym}
        for metric in FRED_SERIES:
            v = merged[metric].get(ym)
            if v is not None:
                row[metric] = v
        rows.append(row)

    lines = []
    lines.append("// 미국 자동차 시장 총량 (월간 판매, NSA) — tool/build_car_usa_total.py 생성, 수동 편집 금지")
    lines.append("// 출처: FRED(세인트루이스 연준) + BEA — 원천은 미 상무부 경제분석국(BEA), 퍼블릭 도메인")
    lines.append("")
    lines.append("var usaTotalMeta = " + json.dumps({
        "source": "FRED / U.S. BEA",
        "sourceUrl": "https://fred.stlouisfed.org",
        "generated": datetime.date.today().strftime("%Y.%m.%d"),
        "unit": "대",
        "note": "판매(retail sales) 기준, 계절조정 없음. 승용=Autos, 경트럭=SUV·픽업·밴 포함.",
        "months": [r["ym"] for r in rows],
        "beaMerged": bool(bea),
    }, ensure_ascii=False) + ";")
    lines.append("")
    lines.append("var arrUsaTotal = [")
    for r in rows:
        lines.append("  " + json.dumps(r) + ",")
    lines.append("];")
    lines.append("")

    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print("OK -> %s (%s ~ %s, %d개월)" % (OUT, months[0], months[-1], len(months)))


if __name__ == "__main__":
    main()
