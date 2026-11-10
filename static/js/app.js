(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const els = {
    main: $('main'), thread: $('thread'), messages: $('messages'), empty: $('empty'),
    emptySlot: $('emptyComposerSlot'), dock: $('composerDock'), disclaimer: $('disclaimer'),
    form: $('composer'), input: $('input'), send: $('sendBtn'),
    history: $('history'), title: $('chatTitle'), convMenuBtn: $('convMenuBtn'),
    sidebar: $('sidebar'), backdrop: $('backdrop'), sidebarToggle: $('sidebarToggle'), sidebarOpen: $('sidebarOpen'),
    searchToggle: $('searchToggle'), searchWrap: $('searchWrap'), searchInput: $('searchInput'),
    settingsBtn: $('settingsBtn'), statusDot: $('statusDot'), theme: $('themeBtn'),
    menu: $('menu'), modal: $('modal'), modalTitle: $('modalTitle'), modalBody: $('modalBody'),
    modalCancel: $('modalCancel'), modalConfirm: $('modalConfirm'), toast: $('toast'),
  };

  const ICON = {
    bot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2z"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg>',
    retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8"/><path d="M3 3v5h5"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2M16 7l3 3M18 5l2 2"/></svg>',
    theme: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 3v18" /><path d="M12 3a9 9 0 010 18" fill="currentColor"/></svg>',
  };

  const state = {
    conversations: [],
    currentId: null,
    messages: [],        // [{id, role, content}]
    controller: null,
    search: '',
    quota: (() => { try { return JSON.parse($('quotaData').textContent); } catch { return null; } })(),
    limits: (() => { try { return JSON.parse($('limitsData').textContent); } catch { return {}; } })(),
    contextStartId: null,   // first message the model still "sees" (null = whole chat fits)
  };

  // ---------------------------------------------------------------- utils
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const isMobile = () => matchMedia('(max-width: 860px)').matches;

  const CSRF = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const HEADERS = { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF };
  function goToLogin() {
    location.href = '/login?next=' + encodeURIComponent(location.pathname);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, { headers: HEADERS, ...opts });
    if (res.status === 401) { goToLogin(); throw new Error('Session expired'); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
    return res.json();
  }

  let toastTimer;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
  }

  async function copyText(text, btn) {
    try { await navigator.clipboard.writeText(text); } catch { return; }
    if (!btn) return toast('Copied to clipboard');
    const original = btn.innerHTML;
    btn.innerHTML = btn.classList.contains('code-copy') ? `${ICON.check}<span>Copied!</span>` : ICON.check;
    setTimeout(() => { btn.innerHTML = original; }, 1500);
  }

  // ---------------------------------------------------------------- quota
  const quotaExhausted = () => !!state.quota && !state.quota.unlimited && state.quota.remaining <= 0;

  function renderQuota() {
    const q = state.quota;
    const pill = $('quotaPill');
    const banner = $('limitBanner');
    const out = quotaExhausted();
    if (!q || q.unlimited) {
      pill.hidden = true;
    } else {
      pill.hidden = false;
      pill.textContent = out ? 'No free messages left'
        : `${q.remaining} of ${q.limit} free message${q.limit === 1 ? '' : 's'} left`;
      pill.classList.toggle('low', !out && q.remaining <= 3);
      pill.classList.toggle('out', out);
    }
    banner.hidden = !out;
    if (out) $('limitBannerText').textContent = `You've used all ${q.limit} free messages on this account. Contact the administrator to get more.`;
    els.form.classList.toggle('exhausted', out);
    els.input.disabled = out;
    els.input.placeholder = out ? 'Free message limit reached' : 'Message Nova';
    document.querySelectorAll('.chip').forEach((c) => { c.disabled = out; });
    updateSendState();
  }

  async function refreshQuota() {
    try { state.quota = (await api('/api/me')).quota; renderQuota(); } catch {}
  }

  function blockedByQuota() {
    if (!quotaExhausted()) return false;
    toast(`You've used all ${state.quota.limit} free messages`);
    return true;
  }

  // ------------------------------------------------------------- markdown
  function renderMarkdown(text) {
    if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true }));
    return `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
  }
  function enhanceCode(container) {
    container.querySelectorAll('pre > code').forEach((code) => {
      const pre = code.parentElement;
      if (pre.parentElement.classList.contains('code-block')) return;
      const lang = (code.className.match(/language-(\S+)/) || [])[1] || 'code';
      const wrap = document.createElement('div');
      wrap.className = 'code-block';
      wrap.innerHTML = `<div class="code-head"><span>${escapeHtml(lang)}</span><button class="code-copy">${ICON.copy}<span>Copy code</span></button></div>`;
      pre.replaceWith(wrap);
      wrap.appendChild(pre);
      wrap.querySelector('.code-copy').addEventListener('click', (e) => copyText(code.innerText, e.currentTarget));
    });
  }

  // ------------------------------------------------------- thread rendering
  function setEmptyState() {
    const empty = state.messages.length === 0 && !state.controller;
    els.main.classList.toggle('is-empty', empty);
    if (empty && els.form.parentElement !== els.emptySlot) els.emptySlot.appendChild(els.form);
    if (!empty && els.form.parentElement !== els.dock) els.dock.insertBefore(els.form, els.disclaimer);
  }

  function actionButton(icon, title, onClick) {
    const b = document.createElement('button');
    b.innerHTML = icon; b.title = title; b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
    return b;
  }

  function userMessageEl(msg, index) {
    const el = document.createElement('div');
    el.className = 'msg user';
    el.innerHTML = '<div class="bubble"></div><div class="msg-actions"></div>';
    el.querySelector('.bubble').textContent = msg.content;
    const actions = el.querySelector('.msg-actions');
    actions.append(
      actionButton(ICON.copy, 'Copy', (e) => copyText(msg.content, e.currentTarget)),
      actionButton(ICON.edit, 'Edit message', () => startEdit(el, index)),
    );
    return el;
  }

  function assistantMessageEl(msg) {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = `<div class="avatar">${ICON.bot}</div><div class="body"><div class="content"></div><div class="msg-actions"></div></div>`;
    if (msg) fillAssistant(el, msg.content);
    return el;
  }

  function fillAssistant(el, text) {
    const content = el.querySelector('.content');
    content.innerHTML = renderMarkdown(text);
    enhanceCode(content);
  }

  function renderThread() {
    els.messages.innerHTML = '';
    let lastAssistant = null;
    state.messages.forEach((m, i) => {
      const el = m.role === 'user' ? userMessageEl(m, i) : assistantMessageEl(m);
      if (m.role === 'assistant') lastAssistant = el;
      els.messages.appendChild(el);
    });
    state.messages.forEach((m, i) => {
      if (m.role !== 'assistant') return;
      const el = els.messages.children[i];
      const actions = el.querySelector('.msg-actions');
      actions.append(actionButton(ICON.copy, 'Copy', (e) => copyText(m.content, e.currentTarget)));
      if (el === lastAssistant && i === state.messages.length - 1) {
        actions.append(actionButton(ICON.retry, 'Regenerate', regenerate));
        el.classList.add('last');
      }
    });
    markContextWindow();
    setEmptyState();
  }

  // Older messages that no longer fit the context window are dimmed, with a divider.
  function markContextWindow() {
    els.messages.querySelector('.context-divider')?.remove();
    const idx = state.contextStartId == null ? -1 : state.messages.findIndex((m) => m.id === state.contextStartId);
    if (idx <= 0) return;
    const nodes = [...els.messages.children];
    nodes.slice(0, idx).forEach((n) => n.classList.add('out-of-context'));
    const div = document.createElement('div');
    div.className = 'context-divider';
    div.title = `Only the most recent messages (about ${(state.limits.max_context_tokens || 0).toLocaleString()} tokens) are sent to the model.`;
    div.innerHTML = '<span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>Messages above are no longer in Nova’s memory for this chat</span>';
    els.messages.insertBefore(div, nodes[idx]);
  }

  function setContext(info) {
    state.contextStartId = info && info.trimmed ? info.first_message_id : null;
  }

  function scrollToBottom(force) {
    const t = els.thread;
    if (force || t.scrollHeight - t.scrollTop - t.clientHeight < 150) t.scrollTop = t.scrollHeight;
  }

  // ------------------------------------------------------------ history UI
  function groupLabel(ts) {
    const d = new Date(ts * 1000);
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const diffDays = Math.floor((startOfToday - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
    if (diffDays <= 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return 'Previous 7 Days';
    if (diffDays < 30) return 'Previous 30 Days';
    return d.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  }

  function renderHistory() {
    els.history.innerHTML = '';
    if (!state.conversations.length) {
      els.history.innerHTML = `<div class="history-empty">${state.search ? 'No chats match your search.' : 'Your chats will appear here.'}</div>`;
      return;
    }
    let group = null, groupEl = null;
    for (const c of state.conversations) {
      const label = groupLabel(c.updated_at);
      if (label !== group) {
        group = label;
        groupEl = document.createElement('div');
        groupEl.className = 'history-group';
        groupEl.innerHTML = `<div class="history-group-label">${escapeHtml(label)}</div>`;
        els.history.appendChild(groupEl);
      }
      const item = document.createElement('div');
      item.className = 'history-item' + (c.id === state.currentId ? ' active' : '');
      item.dataset.id = c.id;
      item.innerHTML = `<a class="history-link" href="/c/${c.id}"></a><button class="history-more" aria-label="Chat options">${ICON.more}</button>`;
      const link = item.querySelector('.history-link');
      link.textContent = c.title; link.title = c.title;
      link.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        openConversation(c.id, true);
      });
      item.querySelector('.history-more').addEventListener('click', (e) => {
        e.stopPropagation();
        item.classList.add('menu-open');
        showMenu(e.currentTarget, [
          { icon: ICON.edit, label: 'Rename', run: () => startRename(c.id) },
          { icon: ICON.trash, label: 'Delete', danger: true, run: () => confirmDelete(c) },
        ], () => item.classList.remove('menu-open'));
      });
      groupEl.appendChild(item);
    }
  }

  async function loadConversations() {
    const q = state.search ? `?q=${encodeURIComponent(state.search)}` : '';
    try { state.conversations = await api(`/api/conversations${q}`); } catch { state.conversations = []; }
    renderHistory();
  }

  function updateTitle() {
    const c = state.conversations.find((x) => x.id === state.currentId);
    const title = c ? c.title : '';
    els.title.textContent = title === 'New chat' ? '' : title;
    document.title = title && title !== 'New chat' ? `${title} · Nova` : 'Nova Assistant';
    els.convMenuBtn.hidden = !state.currentId;
  }

  function setActive() {
    els.history.querySelectorAll('.history-item').forEach((n) => n.classList.toggle('active', n.dataset.id === state.currentId));
    updateTitle();
  }

  // ------------------------------------------------------------ navigation
  function abortStream() {
    if (!state.controller) return;
    state.controller.abort();
    state.controller = null;
    setBusy(false);
  }

  async function openConversation(id, push) {
    abortStream();
    try {
      const conv = await api(`/api/conversations/${id}`);
      state.currentId = conv.id;
      state.messages = conv.messages;
      setContext(conv.context);
      if (!state.conversations.some((c) => c.id === conv.id)) state.conversations.unshift(conv);
      if (push) history.pushState({ id }, '', `/c/${id}`);
      renderThread();
      setActive();
      scrollToBottom(true);
      closeMobileSidebar();
      els.input.focus();
    } catch {
      toast('Conversation not found');
      newChat(true);
    }
  }

  function newChat(push = true) {
    abortStream();
    state.currentId = null;
    state.messages = [];
    state.contextStartId = null;
    if (push && location.pathname !== '/') history.pushState({}, '', '/');
    renderThread();
    setActive();
    closeMobileSidebar();
    els.input.value = ''; autosize(); updateSendState();
    els.input.focus();
  }

  window.addEventListener('popstate', () => {
    const m = location.pathname.match(/^\/c\/([\w-]+)/);
    if (m) openConversation(m[1], false); else newChat(false);
  });

  // ------------------------------------------------------------- chatting
  async function sendMessage(text) {
    text = text.trim();
    if (!text || state.controller || blockedByQuota()) return;
    els.input.value = ''; autosize();
    state.messages.push({ id: null, role: 'user', content: text });
    renderThread();
    scrollToBottom(true);
    await stream({ conversation_id: state.currentId, content: text });
  }

  async function regenerate() {
    if (state.controller || !state.currentId || blockedByQuota()) return;
    if (state.messages.at(-1)?.role === 'assistant') state.messages.pop();
    renderThread();
    await stream({ conversation_id: state.currentId, regenerate: true });
  }

  async function submitEdit(index, newText) {
    newText = newText.trim();
    if (!newText || state.controller || blockedByQuota()) return;
    let msg = state.messages[index];
    if (!msg.id) {  // id unknown (e.g. stopped very early) — refresh from server
      const conv = await api(`/api/conversations/${state.currentId}`);
      state.messages = conv.messages;
      msg = state.messages[index];
      if (!msg || msg.role !== 'user') return renderThread();
    }
    state.messages = state.messages.slice(0, index);
    state.messages.push({ id: null, role: 'user', content: newText });
    renderThread();
    await stream({ conversation_id: state.currentId, content: newText, edit_message_id: msg.id });
  }

  function startEdit(el, index) {
    if (state.controller) return;
    const msg = state.messages[index];
    el.innerHTML = `<div class="edit-box"><textarea rows="1"></textarea><div class="edit-actions"><button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-primary" data-a="send">Send</button></div></div>`;
    const ta = el.querySelector('textarea');
    if (state.limits.max_input_chars) ta.maxLength = state.limits.max_input_chars;
    ta.value = msg.content;
    const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 300) + 'px'; };
    ta.addEventListener('input', fit); fit();
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') renderThread();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitEdit(index, ta.value); }
    });
    el.querySelector('[data-a=cancel]').addEventListener('click', renderThread);
    el.querySelector('[data-a=send]').addEventListener('click', () => submitEdit(index, ta.value));
  }

  async function stream(body) {
    const el = assistantMessageEl();
    el.classList.add('streaming');
    el.querySelector('.content').innerHTML = '<span class="typing"></span>';
    els.messages.appendChild(el);
    scrollToBottom(true);

    const controller = new AbortController();
    state.controller = controller;
    setBusy(true);
    setEmptyState();

    let reply = '', errorMsg = null, stopped = false, convId = body.conversation_id;
    let scheduled = false;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST', headers: HEADERS,
        body: JSON.stringify(body), signal: controller.signal,
      });
      if (res.status === 401) { goToLogin(); return; }
      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        if (data.quota) { state.quota = data.quota; renderQuota(); }
        throw new Error(data.error || 'Free message limit reached.');
      }
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();
        for (const raw of parts) {
          const evt = (raw.match(/^event: (.*)$/m) || [])[1];
          const line = (raw.match(/^data: (.*)$/m) || [])[1];
          if (!evt || !line) continue;
          const data = JSON.parse(line);

          if (evt === 'meta') {
            convId = data.conversation_id;
            if (data.quota) { state.quota = data.quota; renderQuota(); }
            if (data.context) setContext(data.context);
            const lastUser = [...state.messages].reverse().find((m) => m.role === 'user');
            if (lastUser && data.user_message_id) lastUser.id = data.user_message_id;
            if (data.is_new) {
              state.currentId = convId;
              history.pushState({ id: convId }, '', `/c/${convId}`);
              state.conversations.unshift({ id: convId, title: 'New chat', updated_at: Date.now() / 1000 });
              renderHistory(); setActive();
            }
          } else if (evt === 'delta') {
            reply += data.text;
            if (!scheduled) {
              scheduled = true;
              requestAnimationFrame(() => { scheduled = false; fillAssistant(el, reply); scrollToBottom(); });
            }
          } else if (evt === 'title') {
            const c = state.conversations.find((x) => x.id === data.conversation_id);
            if (c) c.title = data.title;
            renderHistory(); setActive();
          } else if (evt === 'done') {
            if (reply) state.messages.push({ id: data.assistant_message_id, role: 'assistant', content: reply });
          } else if (evt === 'error') {
            errorMsg = data.message;
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') stopped = true; else errorMsg = err.message;
    }

    if (state.controller === controller) state.controller = null;
    setBusy(false);
    refreshQuota();  // server refunds requests that produced no reply

    // Stopped mid-stream: server persists the partial reply; mirror it locally.
    if (reply && state.messages.at(-1)?.role !== 'assistant' && convId === state.currentId) {
      state.messages.push({ id: null, role: 'assistant', content: reply });
    }
    if (convId !== state.currentId) { setEmptyState(); loadConversations(); return; } // user navigated away

    renderThread();
    const last = els.messages.lastElementChild;
    if (errorMsg || (stopped && !reply)) {
      const target = (last && last.classList.contains('assistant') && reply) ? last : (() => {
        const e = assistantMessageEl(); els.messages.appendChild(e); return e;
      })();
      const note = document.createElement('div');
      note.className = errorMsg ? 'error-box' : 'stopped-note';
      note.textContent = errorMsg || 'Stopped generating.';
      target.querySelector('.body').insertBefore(note, target.querySelector('.msg-actions'));
      if (errorMsg && state.messages.at(-1)?.role === 'user') {
        target.querySelector('.msg-actions').append(actionButton(ICON.retry, 'Retry', regenerate));
        target.classList.add('last');
      }
    }
    scrollToBottom();
    loadConversations();
  }

  // --------------------------------------------------------- rename/delete
  function startRename(id) {
    if (isMobile()) openMobileSidebar();
    else if (document.documentElement.classList.contains('sidebar-collapsed')) setSidebar(true);
    const item = els.history.querySelector(`.history-item[data-id="${id}"]`);
    const conv = state.conversations.find((c) => c.id === id);
    if (!item || !conv) return;
    const link = item.querySelector('.history-link');
    const input = document.createElement('input');
    input.className = 'history-rename';
    input.value = conv.title;
    link.replaceWith(input);
    item.querySelector('.history-more').hidden = true;
    input.focus(); input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return; done = true;
      const title = input.value.trim();
      if (save && title && title !== conv.title) {
        try {
          await api(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) });
          conv.title = title;
        } catch (e) { toast(e.message); }
      }
      renderHistory(); setActive();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  function confirmModal({ title, body, confirmLabel = 'Delete' }) {
    return new Promise((resolve) => {
      els.modalTitle.textContent = title;
      els.modalBody.innerHTML = body;
      els.modalConfirm.textContent = confirmLabel;
      els.modal.hidden = false;
      els.modalConfirm.focus();
      const close = (val) => {
        els.modal.hidden = true;
        els.modalConfirm.onclick = els.modalCancel.onclick = els.modal.onclick = null;
        document.removeEventListener('keydown', onKey);
        resolve(val);
      };
      const onKey = (e) => { if (e.key === 'Escape') close(false); };
      document.addEventListener('keydown', onKey);
      els.modalConfirm.onclick = () => close(true);
      els.modalCancel.onclick = () => close(false);
      els.modal.onclick = (e) => { if (e.target === els.modal) close(false); };
    });
  }

  async function confirmDelete(conv) {
    const ok = await confirmModal({
      title: 'Delete chat?',
      body: `This will delete <strong>${escapeHtml(conv.title)}</strong>. This can’t be undone.`,
    });
    if (!ok) return;
    try {
      await api(`/api/conversations/${conv.id}`, { method: 'DELETE' });
      state.conversations = state.conversations.filter((c) => c.id !== conv.id);
      if (conv.id === state.currentId) newChat(true);
      renderHistory(); setActive();
      toast('Chat deleted');
    } catch (e) { toast(e.message); }
  }

  async function confirmDeleteAll() {
    const ok = await confirmModal({ title: 'Clear chat history?', body: 'This will permanently delete <strong>all</strong> your conversations.', confirmLabel: 'Delete all' });
    if (!ok) return;
    await api('/api/conversations', { method: 'DELETE' });
    state.conversations = [];
    newChat(true);
    renderHistory();
    toast('All chats deleted');
  }

  // ----------------------------------------------------------------- menu
  let menuOnClose = null;
  function showMenu(anchor, items, onClose) {
    hideMenu();
    els.menu.innerHTML = '';
    for (const it of items) {
      if (it === '-') { els.menu.appendChild(document.createElement('hr')); continue; }
      if (it.info) { const d = document.createElement('div'); d.className = 'menu-info'; d.innerHTML = it.info; els.menu.appendChild(d); continue; }
      const b = document.createElement('button');
      b.innerHTML = `${it.icon || ''}<span>${escapeHtml(it.label)}</span>`;
      if (it.danger) b.className = 'danger';
      b.addEventListener('click', () => { hideMenu(); it.run(); });
      els.menu.appendChild(b);
    }
    els.menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    const m = els.menu.getBoundingClientRect();
    let top = r.bottom + 6, left = r.left;
    if (top + m.height > innerHeight - 8) top = r.top - m.height - 6;
    if (left + m.width > innerWidth - 8) left = innerWidth - m.width - 8;
    els.menu.style.top = `${Math.max(8, top)}px`;
    els.menu.style.left = `${Math.max(8, left)}px`;
    menuOnClose = onClose || null;
  }
  function hideMenu() {
    if (els.menu.hidden) return;
    els.menu.hidden = true;
    if (menuOnClose) { menuOnClose(); menuOnClose = null; }
  }
  document.addEventListener('click', (e) => { if (!els.menu.contains(e.target)) hideMenu(); });
  window.addEventListener('resize', hideMenu);
  els.history.addEventListener('scroll', hideMenu);

  // ------------------------------------------------------------- sidebar
  function setSidebar(open) {
    document.documentElement.classList.toggle('sidebar-collapsed', !open);
    lsSet('sidebar', open ? 'open' : 'closed');
  }
  const openMobileSidebar = () => { els.sidebar.classList.add('open'); els.backdrop.classList.add('show'); };
  const closeMobileSidebar = () => { els.sidebar.classList.remove('open'); els.backdrop.classList.remove('show'); };

  els.sidebarToggle.addEventListener('click', () => (isMobile() ? closeMobileSidebar() : setSidebar(false)));
  els.sidebarOpen.addEventListener('click', () => (isMobile() ? openMobileSidebar() : setSidebar(true)));
  els.backdrop.addEventListener('click', closeMobileSidebar);

  // -------------------------------------------------------------- search
  let searchTimer;
  els.searchToggle.addEventListener('click', () => {
    els.searchWrap.hidden = !els.searchWrap.hidden;
    if (!els.searchWrap.hidden) els.searchInput.focus();
    else if (state.search) { els.searchInput.value = ''; state.search = ''; loadConversations(); }
  });
  els.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.search = els.searchInput.value.trim(); loadConversations(); }, 200);
  });
  els.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { els.searchToggle.click(); }
  });

  // ------------------------------------------------------------ composer
  function setBusy(busy) {
    els.send.classList.toggle('stop', busy);
    els.send.setAttribute('aria-label', busy ? 'Stop generating' : 'Send');
    els.send.title = busy ? 'Stop generating' : 'Send';
    updateSendState();
  }
  function updateSendState() {
    els.send.disabled = !state.controller && (!els.input.value.trim() || quotaExhausted());
    updateCharCount();
  }
  function updateCharCount() {
    const max = state.limits.max_input_chars;
    const counter = $('charCount');
    if (!max || !counter) return;
    const len = els.input.value.length;
    counter.hidden = len < max * 0.8;
    counter.textContent = `${len.toLocaleString()} / ${max.toLocaleString()}`;
    counter.classList.toggle('near', len >= max * 0.8 && len < max);
    counter.classList.toggle('full', len >= max);
  }
  function autosize() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 220) + 'px';
  }

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.controller) { state.controller.abort(); return; }
    sendMessage(els.input.value);
  });
  els.form.addEventListener('click', (e) => { if (e.target === els.form) els.input.focus(); });
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); els.form.requestSubmit(); }
  });
  els.input.addEventListener('input', () => { autosize(); updateSendState(); });
  document.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => sendMessage(b.dataset.prompt)));
  document.querySelectorAll('[data-action="new-chat"]').forEach((b) => b.addEventListener('click', () => newChat(true)));

  // ------------------------------------------------------- top/foot menus
  function toggleTheme() {
    const root = document.documentElement;
    const isDark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = isDark ? 'light' : 'dark';
    lsSet('theme', root.dataset.theme);
  }
  els.theme.addEventListener('click', toggleTheme);

  els.convMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const conv = state.conversations.find((c) => c.id === state.currentId);
    if (!conv) return;
    showMenu(e.currentTarget, [
      { icon: ICON.edit, label: 'Rename', run: () => startRename(conv.id) },
      { icon: ICON.trash, label: 'Delete', danger: true, run: () => confirmDelete(conv) },
    ]);
  });

  let healthInfo = 'Checking connection…';
  const USERNAME = $('userName')?.textContent.trim() || '';

  // ------------------------------------------------------ change password
  const pw = { modal: $('pwModal'), form: $('pwForm'), error: $('pwError'), save: $('pwSave'), cancel: $('pwCancel') };
  function openPasswordModal() {
    pw.form.reset(); pw.error.textContent = '';
    pw.modal.hidden = false;
    pw.form.elements.current.focus();
  }
  const closePasswordModal = () => { pw.modal.hidden = true; };
  async function savePassword() {
    const f = pw.form.elements;
    if (f.new.value.length < 8) { pw.error.textContent = 'New password must be at least 8 characters.'; return; }
    if (f.new.value !== f.confirm.value) { pw.error.textContent = 'New passwords do not match.'; return; }
    pw.save.disabled = true;
    try {
      await api('/api/me/password', { method: 'POST', body: JSON.stringify({ current: f.current.value, new: f.new.value }) });
      closePasswordModal(); toast('Password updated');
    } catch (err) { pw.error.textContent = err.message; }
    finally { pw.save.disabled = false; }
  }
  pw.save.addEventListener('click', savePassword);
  pw.cancel.addEventListener('click', closePasswordModal);
  pw.modal.addEventListener('click', (e) => { if (e.target === pw.modal) closePasswordModal(); });
  pw.form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); savePassword(); }
    if (e.key === 'Escape') closePasswordModal();
  });
  els.settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showMenu(e.currentTarget, [
      { info: `Signed in as <strong>${escapeHtml(USERNAME)}</strong><br>${
        !state.quota || state.quota.unlimited ? 'Unlimited messages'
          : `${state.quota.used} of ${state.quota.limit} free messages used`}` },
      { info: healthInfo },
      '-',
      { icon: ICON.key, label: 'Change password', run: openPasswordModal },
      { icon: ICON.theme, label: 'Toggle theme', run: toggleTheme },
      { icon: ICON.trash, label: 'Delete all chats', danger: true, run: confirmDeleteAll },
      '-',
      { icon: ICON.logout, label: 'Log out', run: () => { abortStream(); $('logoutForm').submit(); } },
    ]);
  });

  // Keyboard shortcuts (ChatGPT-style)
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); newChat(true); }
    if (mod && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); setSidebar(document.documentElement.classList.contains('sidebar-collapsed')); }
    if (e.key === 'Escape') hideMenu();
  });

  // ---------------------------------------------------------------- init
  (async function init() {
    renderQuota();
    await loadConversations();
    const m = location.pathname.match(/^\/c\/([\w-]+)/);
    if (m) await openConversation(m[1], false); else newChat(false);

    fetch('/api/health').then((r) => r.json()).then((d) => {
      els.statusDot.classList.add(d.ok ? 'ok' : 'err');
      healthInfo = d.ok
        ? `Connected to Amazon Bedrock<br>Account ${escapeHtml(d.account)}<br>${escapeHtml(d.model)}`
        : `Not connected<br>${escapeHtml(d.error || '')}`;
    }).catch(() => { els.statusDot.classList.add('err'); healthInfo = 'Not connected'; });
  })();
})();
