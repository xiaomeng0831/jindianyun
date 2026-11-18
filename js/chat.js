/**
 * 津电云 · 悬浮问答助手
 * ------------------------------------------------------------------
 * 零构建、无密钥。把最近若干轮对话和可选的站点摘要 POST 到
 * CHAT_API_URL，回复只按纯文本（加粗 / 行内代码 / 换行）渲染。
 * 对话记录只放在 sessionStorage，关闭标签页即消失。
 */

/** 问答接口。密钥只放在服务器端；更换地址时只改这一处。 */
export const CHAT_API_URL = 'https://23-100-88-70.sslip.io/api/chat';

const STORAGE_KEY = 'jindianyun:chat';
/** 一轮 = 用户一句 + 助手一句。请求体里最多带最近这些轮。服务端再只把最后 12 条转给模型。 */
const MAX_TURNS = 12;
const MAX_REQUEST_MESSAGES = MAX_TURNS * 2;
const MAX_STORED_MESSAGES = 40;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_INPUT_LENGTH = 800;
const MAX_REPLY_LENGTH = 4000;

const COPY = {
  unreachable: '助手服务暂时连不上，请稍后再试。地图仍可正常使用。',
  timeout: '助手响应超时，请稍后再试。',
  limited: '提问太频繁了，请稍等一会儿再试。',
  failed: '助手暂时没能回答，请稍后再试。',
  empty: '助手没有返回内容，请换个问法试试。',
  thinking: '正在回复',
  cleared: '对话已清空',
};

/**
 * @param {HTMLElement | null} root
 * @param {{ getContext?: () => string }} [options]
 */
export function mountChatWidget(root, options = {}) {
  if (!root || root.dataset.mounted === 'true') return;
  const panel = root.querySelector('#chat-panel');
  const launcher = root.querySelector('#chat-launcher');
  const form = root.querySelector('#chat-form');
  const input = root.querySelector('#chat-input');
  const sendButton = root.querySelector('#chat-send');
  const log = root.querySelector('#chat-log');
  const empty = root.querySelector('#chat-empty');
  const clearButton = root.querySelector('#chat-clear');
  const closeButton = root.querySelector('#chat-close');
  const status = root.querySelector('#chat-status');
  if (!panel || !launcher || !form || !input || !sendButton || !log || !empty) {
    console.error('[津电云] 助手标记不完整，已跳过');
    return;
  }

  root.dataset.mounted = 'true';
  const getContext = typeof options.getContext === 'function' ? options.getContext : () => '';

  let messages = loadHistory();
  let pending = false;
  let generation = 0;
  /** @type {AbortController | null} */
  let activeController = null;

  const pendingNode = document.createElement('div');
  pendingNode.className = 'chat-bubble is-pending';
  pendingNode.setAttribute('role', 'status');
  const pendingDots = document.createElement('span');
  pendingDots.className = 'chat-dots';
  pendingDots.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i += 1) pendingDots.append(document.createElement('i'));
  const pendingText = document.createElement('span');
  pendingText.className = 'visually-hidden';
  pendingText.textContent = COPY.thinking;
  pendingNode.append(pendingDots, pendingText);

  function setStatus(text) {
    if (status) status.textContent = text || '';
  }

  function persist() {
    const stored = messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .slice(-MAX_STORED_MESSAGES);
    try {
      if (!stored.length) sessionStorage.removeItem(STORAGE_KEY);
      else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch { /* 隐私模式或配额满时只保留当前页内存 */ }
  }

  function render() {
    const bubbles = log.querySelectorAll('.chat-bubble');
    bubbles.forEach((node) => node.remove());
    empty.hidden = messages.length > 0;
    for (const message of messages) log.append(renderBubble(message));
    if (pending) log.append(pendingNode);
    log.scrollTop = log.scrollHeight;
    sendButton.disabled = pending || !input.value.trim();
    panel.setAttribute('aria-busy', pending ? 'true' : 'false');
  }

  function openPanel() {
    panel.hidden = false;
    panel.setAttribute('aria-hidden', 'false');
    launcher.setAttribute('aria-expanded', 'true');
    launcher.setAttribute('aria-label', '关闭津电云助手');
    root.classList.add('is-open');
    render();
    window.requestAnimationFrame(() => input.focus());
  }

  function closePanel() {
    panel.hidden = true;
    panel.setAttribute('aria-hidden', 'true');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.setAttribute('aria-label', '打开津电云助手');
    root.classList.remove('is-open');
    if (getComputedStyle(launcher).visibility === 'hidden') {
      document.getElementById('map')?.focus({ preventScroll: true });
    } else {
      launcher.focus({ preventScroll: true });
    }
  }

  function togglePanel() {
    if (panel.hidden) openPanel();
    else closePanel();
  }

  function clearChat() {
    generation += 1;
    activeController?.abort();
    activeController = null;
    pending = false;
    messages = [];
    persist();
    render();
    setStatus(COPY.cleared);
    input.focus();
  }

  function send(raw) {
    const content = String(raw ?? '').trim().slice(0, MAX_INPUT_LENGTH);
    if (!content || pending) return;
    messages.push({ role: 'user', content });
    input.value = '';
    resizeInput();
    pending = true;
    persist();
    render();
    setStatus(COPY.thinking);
    void requestReply();
  }

  async function requestReply() {
    const gen = generation;
    const controller = new AbortController();
    activeController = controller;
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let context = '';
    try {
      const value = getContext();
      if (typeof value === 'string') context = value.trim();
    } catch (error) {
      console.error('[津电云] 助手上下文生成失败', error);
    }

    try {
      const reply = await postChat(transcriptForRequest(), context, controller.signal);
      if (gen !== generation) return;
      messages.push({ role: 'assistant', content: reply });
      persist();
      setStatus(reply);
    } catch (error) {
      if (gen !== generation) return;
      const text = messageForFailure(error, controller.signal.aborted);
      messages.push({ role: 'error', content: text });
      setStatus(text);
    } finally {
      window.clearTimeout(timer);
      if (activeController === controller) activeController = null;
      if (gen === generation) {
        pending = false;
        render();
      }
    }
  }

  function transcriptForRequest() {
    return messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .slice(-MAX_REQUEST_MESSAGES)
      .map((message) => ({ role: message.role, content: message.content }));
  }

  launcher.setAttribute('aria-label', '打开津电云助手');
  launcher.addEventListener('click', togglePanel);
  closeButton?.addEventListener('click', closePanel);
  clearButton?.addEventListener('click', clearChat);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    send(input.value);
  });
  input.addEventListener('input', () => {
    resizeInput();
    sendButton.disabled = pending || !input.value.trim();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    send(input.value);
  });
  root.querySelectorAll('[data-suggest]').forEach((button) => {
    button.addEventListener('click', () => send(button.dataset.suggest || button.textContent || ''));
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || panel.hidden) return;
    const searchResults = document.getElementById('search-results');
    if (searchResults && !searchResults.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    closePanel();
  }, true);

  bindKeyboardOffset(root);
  resizeInput();
  render();

  function resizeInput() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 96)}px`;
  }
}

function loadHistory() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((message) => (
        message
        && (message.role === 'user' || message.role === 'assistant')
        && typeof message.content === 'string'
        && message.content.trim()
      ))
      .slice(-MAX_STORED_MESSAGES)
      .map((message) => ({ role: message.role, content: message.content }));
  } catch {
    return [];
  }
}

function renderBubble(message) {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble is-${message.role}`;
  bubble.dataset.role = message.role;
  const who = document.createElement('span');
  who.className = 'visually-hidden';
  who.textContent = message.role === 'user' ? '你说：' : message.role === 'assistant' ? '助手说：' : '提示：';
  bubble.append(who);
  if (message.role === 'assistant') appendFormatted(bubble, message.content);
  else bubble.append(document.createTextNode(message.content));
  return bubble;
}

/** 先按换行拆开，再识别 **加粗** 与 `代码`。全程只用文本节点，不插入原始 HTML。 */
function appendFormatted(parent, text) {
  const source = String(text);
  const lines = source.split('\n');
  lines.forEach((line, index) => {
    if (index > 0) parent.append(document.createTextNode('\n'));
    const pattern = /\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
    let last = 0;
    let match = pattern.exec(line);
    while (match) {
      if (match.index > last) parent.append(document.createTextNode(line.slice(last, match.index)));
      if (match[1] != null) {
        const strong = document.createElement('strong');
        strong.textContent = match[1];
        parent.append(strong);
      } else if (match[2] != null) {
        const code = document.createElement('code');
        code.textContent = match[2];
        parent.append(code);
      }
      last = match.index + match[0].length;
      match = pattern.exec(line);
    }
    if (last < line.length) parent.append(document.createTextNode(line.slice(last)));
  });
}

/** 只采用服务端写给访客的短中文错误。英文或带链接、标记的正文仍用页面上的固定提示。 */
function userFacingServerError(data) {
  const text = data && typeof data.error === 'string' ? data.error.trim() : '';
  if (text.length < 2 || text.length > 80) return '';
  if (!/[\u3400-\u9fff]/.test(text)) return '';
  if (/[<>]|https?:|api[_-]?key|token|bearer|secret|password|sk-|密钥|密码/i.test(text)) return '';
  if (/[A-Za-z0-9+/=_-]{20,}/.test(text)) return '';
  return text;
}

async function postChat(transcript, context, signal) {
  const payload = { messages: transcript };
  if (context) payload.context = context;

  let response;
  try {
    response = await fetch(CHAT_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      credentials: 'omit',
      cache: 'no-store',
      signal,
      body: JSON.stringify(payload),
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    const failure = new Error(COPY.unreachable);
    failure.name = 'ChatError';
    throw failure;
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const fallback = response.status === 429 ? COPY.limited : COPY.failed;
    const failure = new Error(userFacingServerError(data) || fallback);
    failure.name = 'ChatError';
    throw failure;
  }

  const reply = data && typeof data.reply === 'string' ? data.reply.trim() : '';
  if (!reply) {
    const failure = new Error(COPY.empty);
    failure.name = 'ChatError';
    throw failure;
  }
  return reply.length > MAX_REPLY_LENGTH ? `${reply.slice(0, MAX_REPLY_LENGTH)}…` : reply;
}

function messageForFailure(error, aborted) {
  if (aborted) return COPY.timeout;
  if (error?.name === 'ChatError' && typeof error.message === 'string') return error.message;
  return COPY.unreachable;
}

/** 软键盘顶起可视区域时，把悬浮按钮和面板抬到键盘上方。 */
function bindKeyboardOffset(widget) {
  const viewport = window.visualViewport;
  if (!viewport) return;
  let last = '0px';
  const update = () => {
    const offset = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
    const next = `${offset}px`;
    if (next === last) return;
    last = next;
    widget.style.setProperty('--chat-vv-offset', next);
  };
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
}
