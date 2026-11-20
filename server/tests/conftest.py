"""Offline fixtures. No network and no real API key."""

import json
import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture()
def app_module(tmp_path, monkeypatch):
    key = tmp_path / "key"
    key.write_text("test-key", encoding="utf-8")
    monkeypatch.setenv("SILICONFLOW_KEY_FILE", str(key))
    sys.modules.pop("app", None)
    import app as module

    return module


def _with_peer(app, peer):
    """Starlette 0.41's TestClient always reports the peer as testclient."""

    async def wrapped(scope, receive, send):
        if scope["type"] == "http":
            scope = {**scope, "client": peer}
        await app(scope, receive, send)

    return wrapped


@pytest.fixture()
def chat_client(app_module):
    opened = []

    def factory(reply_text="好的", seen=None, peer=("testclient", 50000)):
        def handler(request: httpx.Request):
            if seen is not None:
                seen.append(json.loads(request.content))
            return httpx.Response(200, json={"choices": [{"message": {"content": reply_text}}]})

        app_module.app.state.http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        client = TestClient(_with_peer(app_module.app, peer))
        opened.append(client)
        return client

    yield factory
    for client in opened:
        client.close()
