# -*- coding: utf-8 -*-
"""국토교통부 자동차등록현황보고 -> data_car_kor_reg.js 베이크.

원본: 통계누리 (stat.molit.go.kr) "YYYY년 MM월 자동차 등록자료 통계.xlsx"
라이선스: 공공누리(출처표시) — 상업적 이용 가능.
사용 시트: 01.통계표(시도별x차종), 10.연료별_등록현황, 19.연도별 자동차 등록현황.

실행: py -3 tool/build_car_molit.py [YYYYMM]   (apps/yogurt_app에서)
  월 생략 시 최신월(전월부터 거슬러 시도)을 자동 다운로드.
출력: assets/html/car/data/data_car_kor_reg.js
"""

import datetime
import json
import os
import re
import sys
import urllib.parse
import urllib.request

import openpyxl

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(BASE, "tool", "raw", "car")
OUT = os.path.join(BASE, "assets", "html", "car", "data", "data_car_kor_reg.js")

SIDO = ["서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종",
        "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주",
        "전남광주"]   # 2026.07 광주·전남 통합(전남광주통합특별시) 이후 통계는 '전남광주' 한 줄


def download(yyyymm):
    path = os.path.join(RAW, "molit_%s.xlsx" % yyyymm)
    if os.path.exists(path) and os.path.getsize(path) > 10000:
        return path
    fname = "%s년 %s월 자동차 등록자료 통계.xlsx" % (yyyymm[:4], yyyymm[4:])
    q = urllib.parse.quote(fname)
    url = ("https://stat.molit.go.kr/portal/common/downLoadFile.do"
           "?oFileName=%s&rFileName=%s&midpath=%%2Fstat_file%%2F" % (q, q))
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=90) as r:
        data = r.read()
    if len(data) < 10000 or data[:2] != b"PK":
        raise IOError("not an xlsx (%d bytes) for %s" % (len(data), yyyymm))
    with open(path, "wb") as f:
        f.write(data)
    print("downloaded", fname)
    return path


def latest_month():
    """전월부터 최대 4개월 거슬러 받기 시도 (공표는 익월 말)."""
    d = datetime.date.today().replace(day=1)
    for _ in range(4):
        d = (d - datetime.timedelta(days=1)).replace(day=1)
        ym = d.strftime("%Y%m")
        try:
            return ym, download(ym)
        except Exception as e:
            print("  %s 없음 (%s)" % (ym, e))
    raise RuntimeError("최근 4개월 파일을 받지 못함")


def num(v):
    if isinstance(v, (int, float)):
        return int(round(v))
    return None


def main():
    if len(sys.argv) > 1:
        ym = sys.argv[1]
        path = download(ym)
    else:
        ym, path = latest_month()

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)

    # 01.통계표: 시도별 차종 계 (계 컬럼 = 5,9,13,17 / 총계 = 21)
    ws = wb["01.통계표"]
    sido_rows = []
    nation = None
    for row in ws.iter_rows(min_row=6, values_only=True):
        name = str(row[0]).strip() if row[0] else ""
        if name in SIDO:
            sido_rows.append({
                "ko": name,
                "pass": num(row[5]), "van": num(row[9]),
                "truck": num(row[13]), "spec": num(row[17]),
                "total": num(row[21]),
            })
        elif name in ("계", "총계", "전국", "합계") and nation is None:
            nation = {"pass": num(row[5]), "van": num(row[9]),
                      "truck": num(row[13]), "spec": num(row[17]),
                      "total": num(row[21])}
    # 통합 이전 17개, 통합 이후 16개(광주·전남 → 전남광주)
    if len(sido_rows) not in (16, 17):
        raise RuntimeError("시도 %d개만 파싱됨" % len(sido_rows))
    if nation is None:
        nation = {k: sum(s[k] for s in sido_rows) for k in ("pass", "van", "truck", "spec", "total")}

    # 19.연도별: 년도 | ... 계(4,8,12,16) 합계계(20)
    ws = wb["19.연도별 자동차 등록현황"]
    years = []
    for row in ws.iter_rows(min_row=5, values_only=True):
        y = row[0]
        if isinstance(y, (int, float)) and 1990 < int(y) < 2100:
            years.append({"y": int(y), "pass": num(row[4]), "van": num(row[8]),
                          "truck": num(row[12]), "spec": num(row[16]),
                          "total": num(row[20])})

    # 10.연료별: 연료(0) 종별(1) 용도(2) 시도(3..19) 계(20)
    # 연료 총량 = 해당 연료의 용도별=='계' 행(종별 소계)의 '계' 컬럼 합
    ws = wb["10.연료별_등록현황"]
    fuels = {}
    fuel_order = []
    # '계' 컬럼 위치는 시도 수에 따라 바뀜(17개=20, 광주·전남 통합 후 16개=19) → 헤더(3행)에서 찾음
    hdr = list(ws.iter_rows(min_row=3, max_row=3, values_only=True))[0]
    tot_col = next((i for i, c in enumerate(hdr) if c and str(c).strip() == "계"), 20)
    for row in ws.iter_rows(min_row=5, values_only=True):
        fuel = str(row[0]).strip() if row[0] else ""
        kind = str(row[1]).strip() if row[1] else ""
        use = str(row[2]).strip() if row[2] else ""
        if not fuel or fuel == "총계":
            continue
        # 종별(승용/승합/화물/특수) 소계 행만 — 연료 단위 '계' 행까지 더하면 이중 집계
        if kind in ("승용", "승합", "화물", "특수") and use == "계":
            v = num(row[tot_col])
            if v is not None:
                if fuel not in fuels:
                    fuel_order.append(fuel)
                fuels[fuel] = fuels.get(fuel, 0) + v
    wb.close()

    # 검증: 시도 합계 == 전국 총계, 연료 합계 ~= 전국 총계
    s = sum(x["total"] for x in sido_rows)
    if nation["total"] and abs(s - nation["total"]) > nation["total"] * 0.001:
        raise RuntimeError("시도 합 %d != 전국 %d" % (s, nation["total"]))
    fs = sum(fuels.values())
    if abs(fs - nation["total"]) > nation["total"] * 0.01:
        print("WARN: 연료 합 %d vs 전국 %d" % (fs, nation["total"]))
    for x in sido_rows:
        for k in ("pass", "van", "truck", "spec", "total"):
            if x[k] is None or x[k] < 0:
                raise RuntimeError("bad value %s %s" % (x["ko"], k))

    month_label = "%s.%s" % (ym[:4], ym[4:])
    lines = []
    lines.append("// 국내 자동차 등록현황 — tool/build_car_molit.py 생성, 수동 편집 금지")
    lines.append("// 출처: 국토교통부 자동차등록현황보고 (통계누리, 공공누리 출처표시)")
    lines.append("")
    lines.append("var regMeta = " + json.dumps({
        "source": "국토교통부 자동차등록현황보고",
        "sourceUrl": "https://stat.molit.go.kr",
        "month": month_label,
        "generated": datetime.date.today().strftime("%Y.%m.%d"),
        "unit": "대",
        "note": "누적 등록대수 기준 (신차 판매량 아님)",
    }, ensure_ascii=False) + ";")
    lines.append("")
    lines.append("var regNation = " + json.dumps(nation) + ";")
    lines.append("")
    lines.append("var arrRegSido = [")
    for x in sido_rows:
        lines.append("  " + json.dumps(x, ensure_ascii=False) + ",")
    lines.append("];")
    lines.append("")
    lines.append("var arrRegYear = [")
    for x in years:
        lines.append("  " + json.dumps(x) + ",")
    lines.append("];")
    lines.append("")
    lines.append("var arrRegFuel = [")
    for f in fuel_order:
        lines.append("  " + json.dumps({"ko": f, "cnt": fuels[f]}, ensure_ascii=False) + ",")
    lines.append("];")
    lines.append("")

    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print("OK ->", OUT)
    print("기준월 %s | 전국 %s대 | 연도 %d~%d | 연료 %d종" % (
        month_label, format(nation["total"], ","), years[0]["y"], years[-1]["y"], len(fuel_order)))


if __name__ == "__main__":
    main()
