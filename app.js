(async function () {
  const $ = (sel) => document.querySelector(sel);

  const shareScreen = $('#share-screen');
  const chatScreen = $('#chat-screen');
  const shareLinkInput = $('#share-link');
  const copyBtn = $('#copy-btn');
  const enterBtn = $('#enter-btn');
  const statusPill = $('#status-pill');
  const messages = $('#messages');
  const textInput = $('#text-input');
  const sendBtn = $('#send-btn');
  const fileInput = $('#file-input');
  const attachBtn = $('#attach-btn');
  const deleteBtn = $('#delete-btn');
  const confirmOverlay = $('#confirm-overlay');
  const confirmDeleteBtn = $('#confirm-delete-btn');
  const cancelDeleteBtn = $('#cancel-delete-btn');
  const deletedOverlay = $('#deleted-overlay');

  let roomId, key, ws;
  let isOwner = false;
  let ownerToken = null;

  function setStatus(text, cls) {
    statusPill.textContent = text;
    statusPill.className = 'pill ' + (cls || '');
  }

  function parseHash() {
    const h = location.hash.replace(/^#/, '');
    if (!h) return null;
    const [rid, keyB64] = h.split('.');
    if (!rid || !keyB64) return null;
    return { rid, keyB64 };
  }

  async function init() {
    const parsed = parseHash();
    if (!parsed) {
      // Creator flow: generate a new room + key, show shareable link.
      roomId = EnclaveCrypto.randomId();
      key = await EnclaveCrypto.generateKey();
      const keyB64 = await EnclaveCrypto.exportKey(key);
      const link = `${location.origin}${location.pathname}#${roomId}.${keyB64}`;
      shareLinkInput.value = link;
      history.replaceState(null, '', `#${roomId}.${keyB64}`);

      // Generate a private owner token. This NEVER goes in the shared link —
      // it only ever lives in this browser's sessionStorage, so only the
      // person who created the room can ever delete it.
      isOwner = true;
      ownerToken = EnclaveCrypto.randomId();
      sessionStorage.setItem(`enclave-owner-${roomId}`, ownerToken);

      shareScreen.classList.remove('hidden');
      chatScreen.classList.add('hidden');
    } else {
      roomId = parsed.rid;
      key = await EnclaveCrypto.importKey(parsed.keyB64);

      // If this same browser was the one that created this room earlier
      // (e.g. you're opening your own link again), recognize it as owner.
      const stored = sessionStorage.getItem(`enclave-owner-${roomId}`);
      if (stored) {
        isOwner = true;
        ownerToken = stored;
      }
      enterChat();
    }
  }

  enterBtn.addEventListener('click', enterChat);

  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(shareLinkInput.value);
    copyBtn.textContent = 'Copied!';
    setTimeout(() => (copyBtn.textContent = 'Copy Link'), 1500);
  });

  function enterChat() {
    shareScreen.classList.add('hidden');
    chatScreen.classList.remove('hidden');
    if (isOwner) deleteBtn.classList.remove('hidden');
    else deleteBtn.classList.add('hidden');
    connect();
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let wsUrl = `${proto}://${location.host}/ws?room=${encodeURIComponent(roomId)}`;
    if (isOwner && ownerToken) wsUrl += `&owner=${encodeURIComponent(ownerToken)}`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => setStatus('Waiting for the other person…', 'waiting');

    ws.onclose = () => {
      if (!deletedOverlay.classList.contains('hidden')) return;
      setStatus('Disconnected', 'error');
    };

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'presence') {
        if (msg.count >= 2) setStatus('Connected — encrypted', 'connected');
        else setStatus('Waiting for the other person…', 'waiting');
        return;
      }
      if (msg.type === 'room-deleted') {
        showDeleted();
        return;
      }
      if (msg.type === 'delete-denied') {
        alert("Only the person who created this chat link can delete it.");
        return;
      }
      if (msg.type === 'cipher') {
        const envelope = await EnclaveCrypto.decryptJSON(key, msg);
        await renderIncoming(envelope);
      }
    };
  }

  async function renderIncoming(envelope) {
    if (envelope.kind === 'text') {
      addBubble('them', envelope.text);
    } else if (envelope.kind === 'file') {
      const bubble = addBubble('them', null, true);
      try {
        const res = await fetch(`/download/${roomId}/${envelope.fileId}`);
        const cipherBuf = await res.arrayBuffer();
        const plainBuf = await EnclaveCrypto.decryptBytes(key, envelope.fileIv, cipherBuf);
        renderMedia(bubble, plainBuf, envelope.mime, envelope.filename);
      } catch (e) {
        bubble.textContent = '[Failed to load attachment]';
      }
    }
  }

  function addBubble(who, text, loading) {
    const div = document.createElement('div');
    div.className = 'bubble ' + who;
    if (loading) {
      div.textContent = 'Decrypting attachment…';
    } else {
      div.textContent = text;
    }
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
  }

  function renderMedia(container, arrayBuffer, mime, filename) {
    container.textContent = '';
    const blob = new Blob([arrayBuffer], { type: mime });
    const url = URL.createObjectURL(blob);
    if (mime.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = url;
      img.className = 'media';
      container.appendChild(img);
    } else if (mime.startsWith('video/')) {
      const vid = document.createElement('video');
      vid.src = url;
      vid.controls = true;
      vid.className = 'media';
      container.appendChild(vid);
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'file';
      a.textContent = `⬇ ${filename || 'Download file'}`;
      container.appendChild(a);
    }
    messages.scrollTop = messages.scrollHeight;
  }

  async function sendText() {
    const text = textInput.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    const envelope = { kind: 'text', text };
    const cipher = await EnclaveCrypto.encryptJSON(key, envelope);
    ws.send(JSON.stringify({ type: 'cipher', ...cipher }));
    addBubble('me', text);
    textInput.value = '';
  }

  sendBtn.addEventListener('click', sendText);
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendText();
    }
  });

  attachBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file || !ws || ws.readyState !== WebSocket.OPEN) return;

    const bubble = addBubble('me', null, true);
    bubble.textContent = 'Encrypting & sending…';

    try {
      const buf = await file.arrayBuffer();
      const { iv: fileIv, data: cipherBuf } = await EnclaveCrypto.encryptBytes(key, buf);
      const fileId = EnclaveCrypto.randomId();

      const form = new FormData();
      form.append('blob', new Blob([cipherBuf]), fileId);
      const res = await fetch(`/upload/${roomId}/${fileId}`, { method: 'POST', body: form });
      if (!res.ok) throw new Error('upload failed');

      const envelope = {
        kind: 'file',
        fileId,
        fileIv,
        filename: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size
      };
      const cipher = await EnclaveCrypto.encryptJSON(key, envelope);
      ws.send(JSON.stringify({ type: 'cipher', ...cipher }));

      renderMedia(bubble, buf, envelope.mime, envelope.filename);
    } catch (e) {
      bubble.textContent = '[Failed to send attachment]';
    }
  });

  deleteBtn.addEventListener('click', () => confirmOverlay.classList.remove('hidden'));
  cancelDeleteBtn.addEventListener('click', () => confirmOverlay.classList.add('hidden'));

  confirmDeleteBtn.addEventListener('click', async () => {
    if (!isOwner) return; // defensive — button is hidden for non-owners anyway
    confirmOverlay.classList.add('hidden');
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'delete-room', token: ownerToken }));
      } else {
        await fetch(`/api/rooms/${roomId}/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: ownerToken })
        });
      }
    } catch (_) {}
    showDeleted();
  });

  function showDeleted() {
    deletedOverlay.classList.remove('hidden');
    if (ws) {
      try { ws.close(); } catch (_) {}
    }
  }

  init();
})();
