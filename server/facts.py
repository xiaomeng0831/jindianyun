"""Deterministic fact sheet for the chat model.

The model must not count stations, sort them, or guess which ones have
lithium cabinets. Callers pass the structured payload the page already
knows (static fields from stations.json plus the live idle/busy/fault
counts) and this module renders the only numbers the model is allowed to
repeat.
"""

from __future__ import annotations

import json
import math
from typing import Any, Optional

MAX_STATIONS = 40
MAX_BUILDINGS = 120
MAX_NAME = 40
MAX_NOTE = 120


def parse_context_payload(text: str) -> Optional[dict[str, Any]]:
    raw = text.strip()
    if not raw.startswith("{"):
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict) or data.get("v") != 1:
        return None
    if not isinstance(data.get("stations"), list):
        return None
    buildings = data.get("buildings", [])
    if buildings is None:
        buildings = []
    if not isinstance(buildings, list):
        return None
    return data


def _text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:limit]


def _int(value: Any) -> Optional[int]:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value):
        return int(value)
    return None


def _float(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value):
        return None
    return float(value)


def _stations(raw: list[Any]) -> list[dict[str, Any]]:
    rows = []
    for item in raw[:MAX_STATIONS]:
        if not isinstance(item, dict):
            continue
        name = _text(item.get("name"), MAX_NAME)
        if not name:
            continue
        kind = item.get("type")
        sockets = _int(item.get("sockets"))
        cabinets = _int(item.get("cabinets")) or 0
        if cabinets < 0:
            cabinets = 0
        note = _text(item.get("note"), MAX_NOTE)
        estimated = bool(item.get("approx") or item.get("socketsApprox") or "预估" in note)
        rows.append(
            {
                "name": name,
                "type": "car" if kind == "car" else "bike",
                "sockets": sockets if sockets is not None and sockets >= 0 else None,
                "cabinets": cabinets,
                "estimated": estimated,
                "note": note,
                "lon": _float(item.get("lon")),
                "lat": _float(item.get("lat")),
                "idle": _int(item.get("idle")),
                "busy": _int(item.get("busy")),
                "fault": _int(item.get("fault")),
            }
        )
    return rows


def _buildings(raw: list[Any]) -> list[dict[str, Any]]:
    rows = []
    seen = set()
    for item in raw[:MAX_BUILDINGS]:
        if not isinstance(item, dict):
            continue
        name = _text(item.get("name"), MAX_NAME)
        lon = _float(item.get("lon"))
        lat = _float(item.get("lat"))
        if not name or lon is None or lat is None or name in seen:
            continue
        seen.add(name)
        rows.append({"name": name, "lon": lon, "lat": lat})
    return rows


def _meters(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    lat_m = 111_320.0
    lon_m = 111_320.0 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot((lon1 - lon2) * lon_m, (lat1 - lat2) * lat_m)


def _format_meters(distance: float) -> str:
    if distance < 1000:
        return f"约{max(10, int(round(distance / 10.0) * 10))}米"
    return f"约{distance / 1000:.1f}公里"


def _counts(station: dict[str, Any]) -> str:
    if station["idle"] is None:
        return "状态未知"
    busy = 0 if station["busy"] is None else station["busy"]
    fault = 0 if station["fault"] is None else station["fault"]
    total = station["sockets"] if station["sockets"] is not None else "?"
    return f"空闲{station['idle']}/共{total} 占用{busy} 故障{fault}"


def _mentioned_buildings(buildings: list[dict[str, Any]], user_text: str) -> list[dict[str, Any]]:
    if not user_text:
        return []
    hits = [b for b in buildings if len(b["name"]) >= 2 and b["name"] in user_text]
    hits.sort(key=lambda b: len(b["name"]), reverse=True)
    chosen = []
    for building in hits:
        if any(building["name"] in earlier["name"] and building["name"] != earlier["name"] for earlier in chosen):
            continue
        chosen.append(building)
        if len(chosen) == 3:
            break
    return chosen


def build_fact_sheet(payload: dict[str, Any], user_text: str = "") -> str:
    stations = _stations(payload.get("stations") or [])
    buildings = _buildings(payload.get("buildings") or [])
    bikes = sum(1 for s in stations if s["type"] == "bike")
    cars = sum(1 for s in stations if s["type"] == "car")
    cabinets = [s for s in stations if s["cabinets"] > 0]
    ranked = [s for s in stations if s["idle"] is not None]
    ranked.sort(
        key=lambda s: (
            -int(s["idle"]),
            -(s["idle"] / s["sockets"]) if s["sockets"] else 0,
            s["name"],
        )
    )

    lines = [
        "下面的数字和名单是程序算好的。只许转述，不要自己数站点、不要自己排序、不要增删锂电柜，也不要编造快充慢充或距离。",
        "没有登录，也没有个人账户。收藏只存在这台浏览器的 localStorage，键名 jindianyun:favorites。",
        "筛选在页面顶部：全部、自行车、汽车、含锂电柜、收藏。可以搜索站点或楼宇，拖动地图，用滚轮或双指缩放，右下角可以复位。没有独立 App，也没有导航。",
        "插口占用是模拟数据，不是学校或运营方的官方实时数据，不能用来决定去哪充电。实际状态以学校及运营方公布的信息为准。地图上的颜色同样是模拟的。",
        f"共计{len(stations)}个站：自行车{bikes}个，汽车{cars}个。",
        "锂电柜共"
        + str(len(cabinets))
        + "处，只有这些站："
        + ("；".join(f"{s['name']} {s['cabinets']}组" for s in cabinets) or "无")
        + "。没有出现在这一行的站都没有锂电柜。",
        "按空闲插口从多到少（已经排好，回答「哪里比较空」时从这张表的前面说起，不要改顺序，不要把表后部空闲很少的站说成比较空）：",
    ]
    if ranked:
        for index, station in enumerate(ranked, start=1):
            lines.append(f"{index}. {station['name']} {_counts(station)}")
    else:
        lines.append("（当前没有空闲统计）")

    lines.append("各站静态资料（车位数是否预估、快充慢充只以这一节为准）：")
    for station in stations:
        kind = "汽车" if station["type"] == "car" else "自行车"
        unit = "车位" if station["type"] == "car" else "插口"
        sockets = station["sockets"] if station["sockets"] is not None else "?"
        quality = "预估" if station["estimated"] else "实测"
        cabinet = f"锂电柜{station['cabinets']}组，" if station["cabinets"] else ""
        note = f"备注：{station['note']}" if station["note"] else "无备注"
        lines.append(f"- {station['name']}｜{kind}｜{unit}{sockets}（{quality}）｜{cabinet}{_counts(station)}｜{note}")

    mentioned = _mentioned_buildings(buildings, user_text)
    located = [s for s in stations if s["lon"] is not None and s["lat"] is not None]
    if mentioned and located:
        lines.append("用户提到的楼宇没有同名充电站时，直接说没有叫这个名字的站点，再给出下面算出的最近站点。不要说「没有信息」。")
        for building in mentioned:
            nearest = sorted(
                located,
                key=lambda s: _meters(building["lon"], building["lat"], s["lon"], s["lat"]),
            )[:3]
            parts = []
            for station in nearest:
                distance = _meters(building["lon"], building["lat"], station["lon"], station["lat"])
                parts.append(f"{station['name']}{_format_meters(distance)}")
            lines.append(f"{building['name']}最近：" + "；".join(parts) + "。")
    return "\n".join(lines)
