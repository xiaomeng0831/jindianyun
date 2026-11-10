"""Client IP parsing. X-Forwarded-For is trusted only from the local proxy."""

import re
import time
from pathlib import Path

import pytest
from starlette.requests import Request

ROOT = Path(__file__).resolve().parents[2]


def _request(host: str, forwarded: str | list[str] | None = None, port: int = 1234) -> Request:
    headers = []
    if isinstance(forwarded, list):
        for item in forwarded:
            headers.append((b"x-forwarded-for", item.encode("latin1")))
    elif forwarded is not None:
        headers.append((b"x-forwarded-for", forwarded.encode("latin1")))
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/api/chat",
        "raw_path": b"/api/chat",
        "query_string": b"",
        "headers": headers,
        "client": (host, port),
        "server": ("127.0.0.1", 8765),
    }
    return Request(scope)


def test_spoofed_leftmost_xff_is_ignored(app_module):
    real = "203.0.113.50"
    request = _request("127.0.0.1", f"1.2.3.4, {real}")
    assert app_module.get_client_ip(request) == real


def test_xff_from_non_loopback_peer_is_ignored(app_module):
    request = _request("198.51.100.7", "203.0.113.50")
    assert app_module.get_client_ip(request) == "198.51.100.7"


@pytest.mark.parametrize("forwarded", ["", "   ", "not-an-ip", ",,,", "unknown"])
def test_empty_or_malformed_xff_falls_back_to_peer(app_module, forwarded):
    request = _request("127.0.0.1", forwarded)
    assert app_module.get_client_ip(request) == "127.0.0.1"


def test_missing_xff_falls_back_to_peer(app_module):
    assert app_module.get_client_ip(_request("::1")) == "::1"


def test_loopback_hops_are_skipped_from_the_right(app_module):
    request = _request("127.0.0.1", "1.2.3.4, 203.0.113.8, 127.0.0.1")
    assert app_module.get_client_ip(request) == "203.0.113.8"


def test_loopback_peer_still_reads_xff(app_module):
    """--no-proxy-headers leaves the TCP peer as 127.0.0.1 with a real port."""
    request = _request("127.0.0.1", "1.2.3.4, 203.0.113.9", port=52341)
    assert request.client.port != 0
    assert app_module.get_client_ip(request) == "203.0.113.9"


def test_rewritten_peer_with_port_zero_ignores_xff(app_module):
    """Default uvicorn proxy headers replace the peer, so the XFF branch never runs."""
    request = _request("10.0.0.9", "1.2.3.4, 203.0.113.9", port=0)
    assert app_module.get_client_ip(request) == "10.0.0.9"


def test_duplicate_xff_headers_use_rightmost(app_module):
    request = _request("127.0.0.1", ["1.2.3.4", "203.0.113.50"])
    assert app_module.get_client_ip(request) == "203.0.113.50"


def test_ipv6_rate_limit_uses_slash_64(app_module):
    limiter = app_module.RateLimiter(per_min=1, per_day=10)
    first = limiter.allow("2001:db8:1:2::1")
    second = limiter.allow("2001:db8:1:2::abcd")
    other = limiter.allow("2001:db8:9:9::1")
    assert first[0] is True
    assert second[0] is False
    assert other[0] is True
    assert app_module.rate_limit_key("2001:db8:1:2::1") == app_module.rate_limit_key("2001:db8:1:2::abcd")


def test_stale_rate_limit_keys_are_pruned(app_module):
    limiter = app_module.RateLimiter(per_min=10, per_day=100)
    old = time.time() - 90000
    for index in range(40):
        limiter._events[f"198.51.100.{index}"] = app_module.deque([old])
    limiter._ticks = 31
    assert limiter.allow("203.0.113.9")[0] is True
    assert len(limiter._events) == 1
    assert "203.0.113.9" in limiter._events


def test_launch_commands_pass_no_proxy_headers():
    service = (ROOT / "server" / "jindianyun-chat.service").read_text(encoding="utf-8")
    readme = (ROOT / "server" / "README.md").read_text(encoding="utf-8")
    exec_line = next(line for line in service.splitlines() if line.startswith("ExecStart="))
    assert "--no-proxy-headers" in exec_line
    assert re.search(r"(?<!no)--proxy-headers\b", exec_line) is None
    assert "uvicorn app:app --host 127.0.0.1 --port 8765 --no-proxy-headers" in readme
    assert "都不要加这个开关" not in readme
    assert "省略这个参数并不会关闭改写" in readme
    assert "MUST REPLACE" in service and "MUST REPLACE" in readme
    assert "your-user" in exec_line


def test_visitor_address_seen_by_caddy_is_not_a_trusted_proxy(app_module):
    # 140.248.50.x is a visitor address Caddy observed (Fastly is in front).
    request = _request("127.0.0.1", "1.2.3.4, 140.248.50.8")
    assert app_module.get_client_ip(request) == "140.248.50.8"
