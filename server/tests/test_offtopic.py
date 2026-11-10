"""Server-side backstop when the model returns source code."""


def ask(client, text="你好"):
    return client.post("/api/chat", json={"messages": [{"role": "user", "content": text}]})


def test_fenced_code_is_replaced(app_module, chat_client):
    client = chat_client("```python\ndef quick_sort(arr):\n    return arr\n```")
    response = ask(client, "帮我写一个 Python 快速排序")
    assert response.status_code == 200
    assert response.json()["reply"] == app_module.OFF_TOPIC_REPLY
    assert "```" not in response.json()["reply"]
    assert "quick_sort" not in response.json()["reply"]


def test_unfenced_source_is_replaced(app_module, chat_client):
    source = "def quick_sort(arr):\n    if len(arr) <= 1:\n        return arr\n"
    client = chat_client(source)
    assert ask(client).json()["reply"] == app_module.OFF_TOPIC_REPLY


def test_javascript_function_is_replaced(app_module, chat_client):
    client = chat_client("function sort(xs) {\n  return xs;\n}")
    assert ask(client).json()["reply"] == app_module.OFF_TOPIC_REPLY


def test_normal_chinese_answer_is_kept(app_module, chat_client):
    reply = "格园1斋有自行车充电点，锂电柜1组。地图上绿色表示空闲较多，请以现场为准。"
    client = chat_client(reply)
    assert ask(client, "格园附近有充电桩吗？").json()["reply"] == reply
    assert not app_module.looks_like_code(reply)


def test_inline_backticks_are_not_treated_as_code(app_module):
    reply = "筛选在顶部。`空闲` 表示插口没人用，`占用` 表示正在充电。"
    assert not app_module.looks_like_code(reply)


def test_off_topic_reply_is_not_a_prompt_leak(app_module):
    assert not app_module.leaks_system_prompt(app_module.OFF_TOPIC_REPLY)
    assert not app_module.looks_like_code(app_module.OFF_TOPIC_REPLY)
