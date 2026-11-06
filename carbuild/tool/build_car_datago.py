# -*- coding: utf-8 -*-
"""공공데이터포털 자동차 신규등록정보 API -> data_car_kor_newreg.js 베이크.

원본: 한국교통안전공단 자동차종합정보 신규등록정보 서비스 (data.go.kr 15059401)
  - 이용허락범위 제한 없음, 일일 트래픽 3,000건
  - 응답은 필터 조합별 건수(dtaCo) 하나 -> 차원별로 반복 조회해 조립
인증키: .secret/datago_key.txt (git-ignored, 빌드 타임 전용)

실행: py -3 tool/build_car_datago.py [시작YYYYMM] [끝YYYYMM]
  기본: 202401 ~ 최신 공표월(익월 2일 공표 기준 자동 판단).
  월별 원본 응답은 tool/raw/car/datago/YYYYMM.json 에 캐시 (재실행 시 API 재호출 없음).
출력: assets/html/car/data/data_car_kor_newreg.js
"""

import datetime
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(BASE, "tool", "raw", "car", "datago")
KEY_FILE = os.path.join(BASE, ".secret", "datago_key.txt")
OUT = os.path.join(BASE, "assets", "html", "car", "data", "data_car_kor_newreg.js")

ENDPOINT = "https://apis.data.go.kr/B553881/newRegistlnfoService_02/getnewRegistlnfoService02"

KIND = {"1": "승용", "2": "승합", "3": "화물", "4": "특수"}
SIDO = {"1": "서울", "2": "부산", "3": "대구", "4": "인천", "5": "광주", "6": "대전",
        "7": "울산", "8": "세종", "9": "경기", "10": "강원", "11": "충북", "12": "충남",
        "13": "전북", "14": "전남", "15": "경북", "16": "경남", "17": "제주",
        # 2026.07 광주·전남 통합 이후 전남광주 등록분은 별도 코드 없이 99(기타)로 집계됨 — 합계 일치로 확인(202607: 12,544대)
        "99": "전남광주"}
FUEL = {"1": "CNG", "2": "경유", "3": "수소", "4": "LPG", "5": "전기",
        "6": "하이브리드(CNG)", "7": "하이브리드", "8": "휘발유",
        "9": "휘발유(무연)", "10": "휘발유(유연)", "11": "기타"}
USE = {"1": "자가용", "2": "영업용", "3": "관용"}
IMP = ["국산", "외산"]

_key_cache = None


def api_key():
    global _key_cache
    if _key_cache is None:
        with open(KEY_FILE, encoding="ascii") as f:
            _key_cache = f.read().strip()
    return _key_cache


def call(yy, mt, **extra):
    params = {"serviceKey": api_key(), "registYy": yy, "registMt": mt}
    params.update(extra)
    url = ENDPOINT + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                xml = r.read().decode("utf-8")
            root = ET.fromstring(xml)
            code = root.findtext("header/resultCode")
            if code in ("3", "03"):  # NODATA = 해당 조건 등록 0건 (또는 미공표 월)
                return 0
            if code not in ("0", "00"):
                raise RuntimeError("API error %s: %s" % (code, root.findtext("header/resultMsg")))
            v = root.findtext("body/dtaCo")
            return int(v) if v not in (None, "") else 0
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2)


def collect_month(ym):
    """한 달치 전 차원 조회 (총 38콜). 캐시 있으면 그대로 사용."""
    os.makedirs(RAW, exist_ok=True)
    cache = os.path.join(RAW, ym + ".json")
    if os.path.exists(cache):
        with open(cache, encoding="utf-8") as f:
            return json.load(f)

    yy, mt = ym[:4], ym[4:]
    total = call(yy, mt)
    if total <= 0:
        return None  # 아직 미공표

    m = {"ym": ym, "total": total, "kind": {}, "fuel": {}, "sido": {}, "use": {}, "imp": {}}
    for code, name in KIND.items():
        m["kind"][name] = call(yy, mt, vhctyAsortCode=code)
        time.sleep(0.1)
    for code, name in FUEL.items():
        m["fuel"][name] = call(yy, mt, useFuelCode=code)
        time.sleep(0.1)
    for code, name in SIDO.items():
        m["sido"][name] = call(yy, mt, registGrcCode=code)
        time.sleep(0.1)
    for code, name in USE.items():
        m["use"][name] = call(yy, mt, prposSeNm=code)
        time.sleep(0.1)
    for name in IMP:
        m["imp"]["수입" if name == "외산" else name] = call(yy, mt, hmmdImpSeNm=name)
        time.sleep(0.1)

    # 해당 월에 0인 시도(통합 전 '전남광주', 통합 후 '광주'·'전남')는 목록에서 뺌
    m["sido"] = {k: v for k, v in m["sido"].items() if v > 0}

    # 검증: 차원 합 == 총계 (시도/차종/국산수입은 전수 분할이어야 함)
    for dim in ("kind", "sido", "imp"):
        s = sum(m[dim].values())
        if abs(s - total) > max(2, total * 0.001):
            raise RuntimeError("%s %s 합 %d != 총 %d" % (ym, dim, s, total))
    for dim in ("kind", "fuel", "sido", "use", "imp"):
        for k, v in m[dim].items():
            if v < 0:
                raise RuntimeError("%s %s.%s 음수" % (ym, dim, k))

    with open(cache, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False)
    print("  %s: %s대" % (ym, format(total, ",")))
    return m


def month_range(start, end):
    y, m = int(start[:4]), int(start[4:])
    while True:
        ym = "%04d%02d" % (y, m)
        if ym > end:
            break
        yield ym
        m += 1
        if m > 12:
            y, m = y + 1, 1


def main():
    start = sys.argv[1] if len(sys.argv) > 1 else "202401"
    if len(sys.argv) > 2:
        end = sys.argv[2]
    else:
        d = datetime.date.today()
        # 당월 데이터는 익월 2일부터 -> 오늘 기준 전월까지 시도
        prev = d.replace(day=1) - datetime.timedelta(days=1)
        end = prev.strftime("%Y%m")

    months = []
    for ym in month_range(start, end):
        data = collect_month(ym)
        if data is None:
            print("  %s: 미공표 (중단)" % ym)
            break
        months.append(data)

    if not months:
        raise RuntimeError("수집된 월 없음")

    lines = []
    lines.append("// 국내 자동차 신규등록 통계 — tool/build_car_datago.py 생성, 수동 편집 금지")
    lines.append("// 출처: 한국교통안전공단 자동차종합정보 신규등록정보 (공공데이터포털 15059401, 이용허락범위 제한 없음)")
    lines.append("")
    lines.append("var newregMeta = " + json.dumps({
        "source": "한국교통안전공단 (공공데이터포털)",
        "sourceUrl": "https://www.data.go.kr/data/15059401/openapi.do",
        "generated": datetime.date.today().strftime("%Y.%m.%d"),
        "unit": "대",
        "note": "월간 신규등록 대수 (누적 아님)",
        "months": [m["ym"] for m in months],
    }, ensure_ascii=False) + ";")
    lines.append("")
    lines.append("var arrNewreg = [")
    for m in months:
        lines.append("  " + json.dumps(m, ensure_ascii=False) + ",")
    lines.append("];")
    lines.append("")

    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print("OK -> %s  (%s ~ %s, %d개월)" % (OUT, months[0]["ym"], months[-1]["ym"], len(months)))


if __name__ == "__main__":
    main()
