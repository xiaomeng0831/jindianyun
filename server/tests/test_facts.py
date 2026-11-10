"""Fact sheet: counts, order, notes, and nearest buildings come from code."""

import json
import re
from pathlib import Path

from facts import build_fact_sheet

ROOT = Path(__file__).resolve().parents[2]


def _load(name):
    return json.loads((ROOT / "data" / name).read_text(encoding="utf-8"))


def _centroids(basemap):
    groups = {}
    for building in basemap.get("buildings") or []:
        name = (building.get("name") or "").strip()
        poly = building.get("poly") or []
        if not name or not poly:
            continue
        bucket = groups.setdefault(name, [0.0, 0.0, 0])
        for lon, lat in poly:
            bucket[0] += lon
            bucket[1] += lat
            bucket[2] += 1
    return [
        {"name": name, "lon": value[0] / value[2], "lat": value[1] / value[2]}
        for name, value in groups.items()
    ]


def _live(stations):
    rows = []
    for index, station in enumerate(stations):
        rows.append(
            {
                "name": station["name"],
                "type": station["type"],
                "sockets": station["sockets"],
                "cabinets": station.get("cabinets") or 0,
                "approx": bool(station.get("approx") or station.get("socketsApprox")),
                "note": station.get("note") or "",
                "lon": station["lon"],
                "lat": station["lat"],
                "idle": (index * 3) % 11,
                "busy": 1,
                "fault": 0,
            }
        )
    return rows


def test_lithium_list_is_exact():
    stations = _load("stations.json")
    sheet = build_fact_sheet({"v": 1, "stations": _live(stations), "buildings": []}, "")
    line = next(item for item in sheet.splitlines() if item.startswith("锂电柜"))
    assert "共5处" in line
    for name in ("格园1斋", "治园17斋", "25/26斋", "桃园餐厅南侧", "31教北侧"):
        assert name in line
    assert "治园19斋" not in line


def test_empty_stations_follow_the_precomputed_order():
    payload = {
        "v": 1,
        "stations": [
            {"name": "平园24斋", "type": "bike", "sockets": 10, "cabinets": 0, "idle": 2, "busy": 8, "fault": 0},
            {"name": "治园17斋", "type": "bike", "sockets": 20, "cabinets": 1, "idle": 15, "busy": 5, "fault": 0},
            {"name": "55教北", "type": "car", "sockets": 6, "cabinets": 0, "idle": 3, "busy": 3, "fault": 0},
        ],
        "buildings": [],
    }
    sheet = build_fact_sheet(payload, "哪些站点现在比较空？")
    ranked = sheet.split("按空闲插口从多到少", 1)[1].split("各站静态资料", 1)[0]
    assert ranked.index("治园17斋") < ranked.index("55教北") < ranked.index("平园24斋")
    assert "空闲15/共20" in ranked
    assert "不要改顺序" in sheet


def test_notes_mark_fast_charging_and_estimates():
    stations = _load("stations.json")
    sheet = build_fact_sheet({"v": 1, "stations": _live(stations), "buildings": []}, "")
    admin = next(line for line in sheet.splitlines() if line.startswith("- 1895行政楼北侧"))
    gate = next(line for line in sheet.splitlines() if line.startswith("- 南门"))
    assert "快充 8 + 慢充 6" in admin
    assert "实测" in admin
    assert "预估" in gate
    assert "快充 4 + 慢充 4" in gate


def test_library_nearest_station_is_computed():
    stations = _load("stations.json")
    buildings = _centroids(_load("basemap.json"))
    sheet = build_fact_sheet(
        {"v": 1, "stations": _live(stations), "buildings": buildings},
        "郑东图书馆附近有充电桩吗？最近的是哪几个？",
    )
    line = next(item for item in sheet.splitlines() if item.startswith("郑东图书馆最近"))
    assert line.startswith("郑东图书馆最近：正园10斋")
    assert "没有叫这个名字的站点" in sheet
    assert "没有信息" not in line


def test_favorites_are_local_only():
    sheet = build_fact_sheet({"v": 1, "stations": [], "buildings": []}, "")
    assert "没有登录，也没有个人账户" in sheet
    assert "localStorage" in sheet
    assert "jindianyun:favorites" in sheet
    assert "含锂电柜" in sheet


def test_client_timeout_is_longer_than_upstream():
    import app as app_module

    source = (ROOT / "js" / "chat.js").read_text(encoding="utf-8")
    match = re.search(r"REQUEST_TIMEOUT_MS = (\d+)", source)
    assert match
    client_ms = int(match.group(1))
    assert client_ms > app_module.UPSTREAM_BUDGET * 1000
    assert client_ms < 45000


def test_structured_context_is_what_the_model_sees(app_module, chat_client):
    seen = []
    client = chat_client("好的", seen, peer=("127.0.0.1", 9))
    payload = {
        "v": 1,
        "stations": [
            {"name": "治园19斋", "type": "bike", "sockets": 10, "cabinets": 0, "idle": 1, "busy": 9, "fault": 0},
            {"name": "治园17斋", "type": "bike", "sockets": 20, "cabinets": 1, "idle": 15, "busy": 5, "fault": 0},
        ],
    }
    response = client.post(
        "/api/chat",
        json={
            "messages": [{"role": "user", "content": "哪些站点有锂电柜？一共几处？"}],
            "context": json.dumps(payload, ensure_ascii=False),
        },
    )
    assert response.status_code == 200
    fact = seen[0]["messages"][1]["content"]
    cabinet = next(line for line in fact.splitlines() if line.startswith("锂电柜"))
    assert "共1处" in cabinet
    assert "治园17斋" in cabinet
    assert "治园19斋" not in cabinet


def test_plain_context_is_still_forwarded(app_module, chat_client):
    seen = []
    client = chat_client("好的", seen, peer=("127.0.0.1", 9))
    response = client.post(
        "/api/chat",
        json={
            "messages": [{"role": "user", "content": "格园附近有充电桩吗？"}],
            "context": "格园1斋（自行车，空闲8/占用2/故障0，锂电柜1）",
        },
    )
    assert response.status_code == 200
    assert "格园1斋（自行车，空闲8/占用2/故障0，锂电柜1）" in seen[0]["messages"][1]["content"]
