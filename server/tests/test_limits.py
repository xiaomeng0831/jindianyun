"""Rate limit, Retry-After, and the global upstream cap. Upstream is mocked."""


def _post(client, text, forwarded):
    return client.post(
        "/api/chat",
        json={"messages": [{"role": "user", "content": text}]},
        headers={"X-Forwarded-For": forwarded},
    )


def test_rate_limit_keys_on_rightmost_forwarded_ip(app_module, chat_client):
    app_module.limiter = app_module.RateLimiter(per_min=2, per_day=100)
    seen = []
    client = chat_client("格园有自行车充电点。", seen, peer=("127.0.0.1", 5000))
    real = "203.0.113.9"
    spoofed = f"1.2.3.4, {real}"

    assert _post(client, "格园附近有充电桩吗？", spoofed).status_code == 200
    assert _post(client, "怎么使用这个地图？", spoofed).status_code == 200
    blocked = _post(client, "哪些站点现在比较空？", f"9.9.9.9, {real}")
    assert blocked.status_code == 429
    assert blocked.json() == {"error": "请求过于频繁，请稍后再试"}
    assert blocked.headers["retry-after"].isdigit()
    assert int(blocked.headers["retry-after"]) >= 1
    assert len(seen) == 2

    other = _post(client, "格园附近有充电桩吗？", "1.2.3.4, 203.0.113.10")
    assert other.status_code == 200
    assert "retry-after" not in {name.lower() for name in other.headers}


def test_xff_does_not_split_buckets_for_a_direct_peer(app_module, chat_client):
    app_module.limiter = app_module.RateLimiter(per_min=1, per_day=100)
    client = chat_client("好的", peer=("198.51.100.7", 4000))
    assert _post(client, "怎么使用这个地图？", "203.0.113.1").status_code == 200
    blocked = _post(client, "怎么使用这个地图？", "203.0.113.2")
    assert blocked.status_code == 429
    assert blocked.json()["error"] == "请求过于频繁，请稍后再试"


def test_daily_ip_limit(app_module, chat_client):
    app_module.limiter = app_module.RateLimiter(per_min=10, per_day=2)
    client = chat_client("好的", peer=("127.0.0.1", 5000))
    forwarded = "198.51.100.20"
    assert _post(client, "怎么使用这个地图？", forwarded).status_code == 200
    assert _post(client, "怎么使用这个地图？", forwarded).status_code == 200
    blocked = _post(client, "怎么使用这个地图？", forwarded)
    assert blocked.status_code == 429
    assert blocked.json()["error"] == "今日请求次数已达上限，请明天再试"
    retry = int(blocked.headers["retry-after"])
    assert 1 <= retry <= 86400


def test_global_daily_cap_stops_upstream_calls(app_module, chat_client):
    app_module.daily_cap = app_module.DailyCap(2)
    seen = []
    client = chat_client("好的", seen, peer=("127.0.0.1", 5000))
    assert _post(client, "怎么使用这个地图？", "203.0.113.1").status_code == 200
    assert _post(client, "怎么使用这个地图？", "203.0.113.2").status_code == 200
    blocked = _post(client, "怎么使用这个地图？", "203.0.113.3")
    assert blocked.status_code == 429
    assert blocked.json() == {"error": "今日问答次数已达上限，请明天再试"}
    assert blocked.headers["retry-after"].isdigit()
    assert len(seen) == 2


def test_per_ip_reject_does_not_consume_global_cap(app_module, chat_client):
    app_module.limiter = app_module.RateLimiter(per_min=1, per_day=10)
    app_module.daily_cap = app_module.DailyCap(1)
    seen = []
    client = chat_client("好的", seen, peer=("127.0.0.1", 5000))
    assert _post(client, "怎么使用这个地图？", "203.0.113.4").status_code == 200
    blocked = _post(client, "怎么使用这个地图？", "203.0.113.4")
    assert blocked.status_code == 429
    assert blocked.json()["error"] == "请求过于频繁，请稍后再试"
    assert len(seen) == 1
    other = _post(client, "怎么使用这个地图？", "203.0.113.5")
    assert other.status_code == 429
    assert other.json()["error"] == "今日问答次数已达上限，请明天再试"
    assert len(seen) == 1
