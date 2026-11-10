"""Client IP parsing. X-Forwarded-For is trusted only from the local proxy."""

import pytest
from starlette.requests import Request


def _request(host: str, forwarded: str | None = None) -> Request:
    headers = []
    if forwarded is not None:
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
        "client": (host, 1234),
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


def test_visitor_address_seen_by_caddy_is_not_a_trusted_proxy(app_module):
    # 140.248.50.x is a visitor address Caddy observed (Fastly is in front).
    request = _request("127.0.0.1", "1.2.3.4, 140.248.50.8")
    assert app_module.get_client_ip(request) == "140.248.50.8"
