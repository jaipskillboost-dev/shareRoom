'use strict';

const $ = (id) => document.getElementById(id);

const home = $('home');
const roomView = $('room');
const homeError = $('home-error');
const presence = $('presence');
const filesList = $('files');
const uploads = $('uploads');
const box = $('shared-text');
const panels = $('panels');

let roomId = null;
let socket = null;
let maxFileBytes = Infinity;
let online = 0;
let reconnectTimer = null;
let reconnectAttempts = 0;
let locked = false; // Whether the room has a password.
let session = new TextSync.Session();
let composing = false; // True while an input method (Hindi, Telugu, Chinese...) is building a character.
let held = []; // Changes from others that arrived mid-composition. Applying them would break the character.
let me = null; // This person's public ID in the room, from the server.
let isOwner = false; // Whether this person created the room, which lets them lock it and set a timer.
let ownerId = null;
let roomClosed = false; // Locked: nobody new can join.
let deadline = null; // When the self-destruct timer ends the room, by this device's clock.
let unseen = 0; // Things that happened while the tab was hidden, shown in the tab title.
const people = new Map(); // Public ID -> name, for everyone connected now.
const typingNow = new Map(); // Public ID -> when they last typed.
const othersUploading = new Map(); // "pid:key" -> the row showing someone else's upload.

const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
};
const savedName = () => Device.cleanName(store.get('roomshare-name'));
const myName = () => savedName() ?? Device.deviceName(navigator.userAgent, navigator.maxTouchPoints);
let soundOn = store.get('roomshare-sound') !== 'off';

const stackedLayout = window.matchMedia('(max-width: 859px)'); // One section at a time, chosen with the tabs.

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

const formatTime = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // textContent keeps user content inert.
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/* ---------- Feedback: toasts and confirmation ---------- */

function toast(text, { error = false, long = false } = {}) {
  const container = $('toasts');
  const node = element('div', error ? 'toast error' : 'toast', text);
  container.append(node);
  while (container.children.length > 3) container.firstChild.remove();
  const visibleFor = long ? 6000 : 2600;
  setTimeout(() => node.classList.add('leaving'), visibleFor);
  setTimeout(() => node.remove(), visibleFor + 250);
}

function confirmDialog({ title, body, action }) {
  const dialog = $('confirm');
  if (typeof dialog.showModal !== 'function') return Promise.resolve(window.confirm(`${title}\n\n${body}`));

  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  $('confirm-ok').textContent = action;
  dialog.returnValue = '';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    dialog.showModal();
    $('confirm-cancel').focus(); // The safe choice is the one a stray Enter key lands on.
  });
}

$('confirm-ok').addEventListener('click', () => $('confirm').close('ok'));
$('confirm-cancel').addEventListener('click', () => $('confirm').close('cancel'));
$('confirm').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close('cancel'); // A click on the dimmed area.
});

/* ---------- Screens ---------- */

function syncStates() {
  const fileCount = filesList.children.length;
  $('no-files').hidden = fileCount > 0 || uploads.children.length > 0;
  $('delete-all-files').hidden = fileCount === 0;
  $('download-all').hidden = fileCount < 2;
  $('files-count').hidden = fileCount === 0;
  $('files-count').textContent = fileCount;
  $('copy-text').disabled = $('clear-text').disabled = box.value.length === 0;
  const max = box.maxLength > 0 ? ` / ${box.maxLength.toLocaleString()}` : '';
  $('char-count').textContent = `${box.value.length.toLocaleString()}${max}`;
}

function setCreatePasswordOpen(open) {
  $('create-password-row').hidden = !open;
  $('password-toggle').setAttribute('aria-expanded', open);
  if (!open) $('create-password').value = '';
}

function showHome(error) {
  closeViewer();
  roomId = null;
  // Nothing from the room just left may show up in the next one.
  session = new TextSync.Session();
  held = [];
  online = 0;
  locked = false;
  $('lock-badge').hidden = true;
  me = null;
  isOwner = false;
  ownerId = null;
  people.clear();
  typingNow.clear();
  othersUploading.clear();
  renderActivity();
  setClosed(false);
  setDeadline(null);
  unseen = 0;
  $('join-password-row').hidden = true;
  $('join-password').value = '';
  box.value = '';
  filesList.replaceChildren();
  uploads.replaceChildren();
  syncStates();
  roomView.hidden = true;
  home.hidden = false;
  homeError.hidden = !error;
  homeError.textContent = error ?? '';
  document.title = 'RoomShare';
  history.replaceState(null, '', '/');
}

function showRoom(id) {
  home.hidden = true;
  roomView.hidden = false;
  $('room-code').textContent = id;
  updateTitle();
  if (location.pathname !== `/r/${id}`) history.pushState(null, '', `/r/${id}`);
}

const tabs = [...document.querySelectorAll('[role="tab"]')];

function selectTab(name, { focus = false } = {}) {
  panels.dataset.tab = name;
  for (const tab of tabs) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', selected);
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  }
}

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  tab.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    selectTab(tabs[(index + step + tabs.length) % tabs.length].dataset.tab, { focus: true });
  });
});

/* ---------- Connection ---------- */

async function requestRoom(url, payload) {
  const options = { method: 'POST' };
  if (payload) Object.assign(options, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(body.error ?? 'Something went wrong.'), {
      status: response.status,
      needsPassword: body.needsPassword === true,
    });
  }
  return body;
}

async function enterRoom(url, payload) {
  const { id } = await requestRoom(url, payload);
  roomId = id;
  showRoom(id);
  connect();
}

// Back to the home screen with the password box open for a protected room.
function requirePassword(id, message) {
  showHome(message);
  if (id) $('room-input').value = id;
  $('join-password-row').hidden = false;
  $('join-password').focus();
}

// Handlers are detached first, so a socket that is being replaced cannot deliver messages or trigger a reconnect.
function closeSocket() {
  const old = socket;
  socket = null;
  if (!old) return;
  old.onmessage = old.onclose = null;
  old.close();
}

function connect() {
  closeSocket();
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  // The name goes with the connection, so the others' "joined" notice already shows it.
  const ws = new WebSocket(`${protocol}://${location.host}/api/rooms/${roomId}/ws?name=${encodeURIComponent(myName())}`);
  socket = ws;

  ws.onmessage = (event) => {
    if (event.data !== 'pong') handleMessage(JSON.parse(event.data));
  };
  ws.onclose = () => {
    if (socket === ws && roomId) scheduleReconnect();
  };
}

// Tells the server this tab is still here. A phone that loses signal or is locked stops sending these, and the
// others are told it left within about 15 seconds. Cloudflare answers them without waking the room.
setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN) socket.send('ping');
}, 5_000);

function scheduleReconnect(delay = Math.min(500 * 2 ** reconnectAttempts, 5000)) {
  clearTimeout(reconnectTimer);
  $('presence-text').textContent = 'Reconnecting…';
  presence.classList.add('offline');
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(rejoin, delay);
}

async function rejoin() {
  const id = roomId;
  if (!id) return;
  try {
    await enterRoom(`/api/rooms/${id}/join`);
  } catch (error) {
    // Only a clear answer from the server ends the room. Anything else is a network problem.
    if (error.status === 404) showHome('This room has ended.');
    else if (error.needsPassword) requirePassword(id, error.message);
    else scheduleReconnect();
  }
}

function setPresence(users) {
  online = users;
  $('presence-text').textContent = `${users} online`;
  presence.title = [...people.values()].join(', ');
  presence.classList.remove('offline');
}

function sendAction(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

const nameOf = (pid) => (pid === me ? 'You' : people.get(pid) ?? 'Someone');

function setPeople(list = []) {
  people.clear();
  for (const { pid, name } of list) people.set(pid, name);
  presence.title = [...people.values()].join(', ');
  if ($('room-menu').open) renderPeople();
}

/* ---------- Tab title, sound ---------- */

function updateTitle() {
  const base = roomId ? `Room ${roomId} · RoomShare` : 'RoomShare';
  document.title = unseen ? `(${unseen}) ${base}` : base;
}

// Counts what happens while the tab is in the background, so the tab title shows there is something new.
function noteUnseen() {
  if (!document.hidden) return;
  unseen += 1;
  updateTitle();
}

let audio = null;
// Browsers only allow sound after the person has touched the page, so the audio is set up on the first touch.
addEventListener('pointerdown', () => {
  try {
    audio ??= new AudioContext();
  } catch {}
}, { once: true });

function chime() {
  try {
    if (!audio) return;
    if (audio.state === 'suspended') audio.resume();
    const start = audio.currentTime;
    [880, 1318.5].forEach((frequency, index) => {
      const tone = audio.createOscillator();
      const volume = audio.createGain();
      const at = start + index * 0.12;
      tone.type = 'sine';
      tone.frequency.value = frequency;
      volume.gain.setValueAtTime(0.0001, at);
      volume.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
      volume.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      tone.connect(volume).connect(audio.destination);
      tone.start(at);
      tone.stop(at + 0.4);
    });
  } catch {}
}

function announceArrival() {
  noteUnseen();
  if (!soundOn) return;
  chime();
  navigator.vibrate?.(80);
}

/* ---------- Who is doing what ---------- */

function renderActivity() {
  const now = Date.now();
  const typing = [...typingNow].filter(([pid, at]) => pid !== me && now - at < 3500).map(([pid]) => nameOf(pid));
  $('activity').textContent =
    typing.length === 0 ? '' : typing.length === 1 ? `${typing[0]} is typing…` : `${typing.length} people are typing…`;
}
setInterval(renderActivity, 1000);

let lastTypingSent = 0;
function noteTyping() {
  if (Date.now() - lastTypingSent < 1500) return;
  lastTypingSent = Date.now();
  sendAction({ t: 'typing' });
}

// Someone else's upload shows as a row with their name and progress, until it finishes or they leave.
function showOthersUpload(data) {
  const id = `${data.pid}:${data.key}`;
  let entry = othersUploading.get(id);
  if (data.done) {
    entry?.row.remove();
    othersUploading.delete(id);
    syncStates();
    return;
  }
  if (!entry) {
    const row = element('li', 'file remote');
    const info = element('div', 'file-info');
    const bar = element('progress', 'upload-bar');
    bar.max = 1;
    const meta = element('div', 'file-meta');
    info.append(fileName(data.file), bar, meta);
    row.append(fileBadge(data.file), info);
    uploads.append(row);
    entry = { row, bar, meta, pid: data.pid };
    othersUploading.set(id, entry);
  }
  entry.bar.value = data.pct / 100;
  entry.meta.textContent = `${nameOf(data.pid)} is sending this · ${data.pct}%`;
  entry.seen = Date.now();
  syncStates();
}

function dropOthersUploads(pid) {
  for (const [id, entry] of othersUploading) {
    if (pid && entry.pid !== pid) continue;
    entry.row.remove();
    othersUploading.delete(id);
  }
  syncStates();
}

// A connection that drops mid-upload never says "done", so rows that stop moving are removed.
setInterval(() => {
  for (const [id, entry] of othersUploading) {
    if (Date.now() - entry.seen > 20_000) {
      entry.row.remove();
      othersUploading.delete(id);
    }
  }
  syncStates();
}, 5000);

/* ---------- Lock and timer ---------- */

function setClosed(closed) {
  roomClosed = closed;
  $('closed-badge').hidden = !closed;
  $('lock-toggle').setAttribute('aria-checked', closed);
}

let deadlineTicker = null;
function setDeadline(msLeft) {
  clearInterval(deadlineTicker);
  deadline = msLeft == null ? null : Date.now() + msLeft;
  $('timer-badge').hidden = deadline === null;
  if (deadline !== null) {
    const tick = () => {
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      const h = Math.floor(left / 3600);
      const m = Math.floor((left % 3600) / 60);
      const sec = String(left % 60).padStart(2, '0');
      $('timer-text').textContent = `Deletes in ${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${sec}`;
    };
    tick();
    deadlineTicker = setInterval(tick, 1000);
  }
  for (const button of document.querySelectorAll('#timer-options button')) {
    button.setAttribute('aria-pressed', deadline === null ? button.dataset.seconds === '0' : 'false');
  }
}

const describeTimer = (ms) => (ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)} hour` : `${Math.round(ms / 60_000)} minutes`);

/* ---------- Shared text ---------- */

function mapPosition(position, change) {
  if (position <= change.from) return position;
  if (position >= change.to) return position + change.insert.length - (change.to - change.from);
  return change.from + change.insert.length;
}

// Shows text that someone else changed, keeping the cursor where it was in the words around it.
function showText(next) {
  if (box.value === next) return;
  const change = TextSync.diff(box.value, next);
  const { selectionStart, selectionEnd } = box;
  box.value = next;
  // Setting the selection on a field that is not focused would pull focus into it on some browsers.
  if (document.activeElement === box) {
    box.setSelectionRange(mapPosition(selectionStart, change), mapPosition(selectionEnd, change));
  }
  syncStates();
}

function sendEdit(op) {
  // If the connection is down the edit simply stays unanswered, and the reconnect sends it again.
  if (op && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op }));
}

function applyResult({ value, send }) {
  if (value !== null) showText(value);
  sendEdit(send);
}

function typed() {
  applyResult({ value: null, send: session.edit(box.value) });
  syncStates();
  noteTyping();
}

box.addEventListener('compositionstart', () => {
  composing = true;
});
box.addEventListener('compositionend', () => {
  composing = false;
  typed();
  const queued = held;
  held = [];
  queued.forEach(handleMessage);
});
box.addEventListener('input', () => {
  if (!composing) typed();
});

/* ---------- Messages from the server ---------- */

function handleMessage(data) {
  switch (data.t) {
    case 'init':
      reconnectAttempts = 0;
      me = data.me ?? null;
      isOwner = data.owner === true;
      ownerId = data.ownerId ?? null;
      setPeople(data.people);
      setClosed(data.closed === true);
      setDeadline(data.expiresIn ?? null);
      dropOthersUploads();
      maxFileBytes = data.maxFileBytes;
      box.maxLength = data.maxTextChars;
      locked = data.locked;
      $('lock-badge').hidden = !locked;
      $('size-hint').textContent = `Any file type, up to ${formatSize(data.maxFileBytes)} each`;
      filesList.replaceChildren();
      data.files.forEach(addFile);
      setPresence(data.users);
      applyResult(session.init(data.text, data.v));
      syncStates();
      break;
    case 'presence':
      if (data.people) setPeople(data.people);
      setPresence(data.users);
      break;
    case 'joined':
      people.set(data.pid, data.name);
      if (data.pid !== me) {
        toast(`${data.name} joined`, { long: true });
        noteUnseen();
      }
      break;
    case 'left':
      toast(`${data.name} left`, { long: true });
      typingNow.delete(data.pid);
      renderActivity();
      dropOthersUploads(data.pid);
      break;
    case 'renamed':
      people.set(data.pid, data.name);
      refreshFileSenders();
      renderActivity();
      if ($('room-menu').open) renderPeople();
      break;
    case 'typing':
      typingNow.set(data.pid, Date.now());
      renderActivity();
      break;
    case 'uploading':
      showOthersUpload(data);
      break;
    case 'closed':
      setClosed(data.closed === true);
      if (data.byId !== me) toast(data.closed ? `${data.by} locked the room. Nobody new can join.` : `${data.by} unlocked the room.`);
      break;
    case 'timer':
      setDeadline(data.expiresIn ?? null);
      if (data.byId !== me) {
        toast(data.expiresIn ? `${data.by} set the room to delete itself in ${describeTimer(data.expiresIn)}.` : `${data.by} turned off the room's timer.`);
      }
      break;
    case 'ended':
      clearTimeout(reconnectTimer);
      closeSocket();
      showHome("The room's timer ran out, so the room, its text and its files were deleted.");
      break;
    case 'text':
      if (composing) held.push(data);
      else applyResult(session.receive(data));
      noteUnseen(); // Only counts while the tab is hidden, when it cannot be this person's own typing.
      break;
    case 'reject':
      if (composing) {
        held.push(data);
      } else {
        const value = session.reject(data.id);
        if (value !== null) showText(value);
      }
      break;
    case 'file':
      addFile(data.file);
      if (data.file.fromId !== me) announceArrival();
      syncStates();
      updateViewerBar();
      // On a phone the Files tab may be out of sight, so say that something arrived.
      if (stackedLayout.matches && panels.dataset.tab !== 'files') toast(`New file: ${data.file.name}`);
      break;
    case 'fileRemoved':
      if (viewing?.id === data.id) {
        closeViewer();
        toast('That file was deleted.');
      }
      filesList.querySelector(`[data-id="${data.id}"]`)?.remove();
      syncStates();
      updateViewerBar();
      break;
    case 'filesCleared':
      if (viewer.open) {
        closeViewer();
        toast('The files were deleted.');
      }
      filesList.replaceChildren();
      syncStates();
      break;
    case 'notice':
      toast(data.text, { error: true });
      break;
  }
}

/* ---------- Files ---------- */

const KINDS = {
  image: 'png jpg jpeg gif webp svg heic heif bmp avif tiff ico',
  video: 'mp4 mov mkv webm avi m4v wmv 3gp',
  audio: 'mp3 wav m4a flac ogg aac opus',
  document: 'pdf doc docx txt rtf md odt ppt pptx key pages',
  sheet: 'xls xlsx csv tsv ods numbers',
  archive: 'zip rar 7z tar gz tgz bz2',
};
const kindOfExtension = new Map(
  Object.entries(KINDS).flatMap(([kind, extensions]) => extensions.split(' ').map((ext) => [ext, kind])),
);

function fileBadge(name) {
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const badge = element('span', 'file-badge', (extension || 'file').slice(0, 4).toUpperCase());
  badge.dataset.kind = kindOfExtension.get(extension) ?? 'other';
  badge.setAttribute('aria-hidden', 'true');
  return badge;
}

// With `onOpen` the name is a button that opens the file in the viewer.
function fileName(name, onOpen) {
  const node = onOpen ? element('button', 'file-link', name) : element('div', 'file-name', name);
  if (onOpen) {
    node.type = 'button';
    node.addEventListener('click', onOpen);
  }
  node.title = name; // Long names are cut to one line, so the full name is on hover and long press.
  return node;
}

// "211 KB · 05:32 PM · from iPhone". A sender who has since changed their name shows the new one.
function fileMeta(file) {
  const sender = !file.fromId ? file.from : file.fromId === me ? 'you' : people.get(file.fromId) ?? file.from;
  return [formatSize(Number(file.size)), formatTime(Number(file.at)), sender && `from ${sender}`].filter(Boolean).join(' · ');
}

function refreshFileSenders() {
  for (const row of filesList.children) row.querySelector('.file-meta').textContent = fileMeta(row.dataset);
}

function addFile(file) {
  const viewable = FileTypes.isViewable(file.name);
  const row = element('li', 'file');
  const info = element('div', 'file-info');
  info.append(fileName(file.name, viewable ? () => openViewer(file.id) : undefined), element('div', 'file-meta', fileMeta(file)));

  const link = element('a', 'icon-btn');
  link.href = `/api/rooms/${roomId}/files/${file.id}`;
  link.download = file.name;
  link.title = 'Download';
  link.setAttribute('aria-label', `Download ${file.name}`);
  link.append(icon('download'));

  const remove = element('button', 'icon-btn danger');
  remove.type = 'button';
  remove.title = 'Delete';
  remove.setAttribute('aria-label', `Delete ${file.name}`);
  remove.append(icon('trash'));
  remove.addEventListener('click', () => deleteFiles(file.id));

  const actions = element('div', 'file-actions');
  if (viewable) {
    const open = element('button', 'icon-btn');
    open.type = 'button';
    open.title = 'View';
    open.setAttribute('aria-label', `View ${file.name}`);
    open.append(icon('eye'));
    open.addEventListener('click', () => openViewer(file.id));
    actions.append(open);
  }
  actions.append(link, remove);
  Object.assign(row.dataset, { id: file.id, name: file.name, size: file.size, viewable, at: file.at, from: file.from ?? '', fromId: file.fromId ?? '' });
  row.append(fileBadge(file.name), info, actions);
  filesList.prepend(row);
}

function uploadFile(file) {
  const row = element('li', 'file');
  const info = element('div', 'file-info');
  const status = element('div', 'file-meta', formatSize(file.size));
  const bar = element('progress', 'upload-bar');
  bar.max = 1;
  bar.value = 0;
  bar.setAttribute('aria-label', `Uploading ${file.name}`);
  info.append(fileName(file.name), bar, status);
  row.append(fileBadge(file.name), info);
  uploads.append(row);
  syncStates();

  const fail = (reason) => {
    bar.remove();
    status.textContent = reason;
    status.classList.add('error');
    const dismiss = element('button', 'icon-btn');
    dismiss.type = 'button';
    dismiss.title = 'Dismiss';
    dismiss.setAttribute('aria-label', `Dismiss ${file.name}`);
    dismiss.append(icon('trash'));
    dismiss.addEventListener('click', () => {
      row.remove();
      syncStates();
    });
    row.append(dismiss);
  };

  if (file.size > maxFileBytes) {
    fail(`Too large. The limit is ${formatSize(maxFileBytes)}.`);
    return Promise.resolve();
  }

  const room = roomId;
  const offline = 'Upload failed. Check your connection and try again.';
  const errorOf = async (response) => (await response.json().catch(() => ({}))).error ?? 'Upload failed.';

  // The others see this upload, with its progress, while it happens.
  const key = Math.random().toString(36).slice(2, 10);
  let lastShared = 0;
  const share = (pct) => {
    if (Date.now() - lastShared < 700 && pct < 100) return;
    lastShared = Date.now();
    sendAction({ t: 'uploading', key, file: file.name, size: file.size, pct });
  };
  share(0);

  // Three steps: reserve space and get an upload link, send the file to that link, then tell the room it arrived.
  // The link usually goes straight to file storage, so large files never pass through the server.
  return (async () => {
    let slot;
    try {
      const response = await fetch(`/api/rooms/${room}/uploads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, size: file.size }),
      });
      if (!response.ok) return fail(await errorOf(response));
      slot = await response.json();
    } catch {
      return fail(offline);
    }

    const sent = await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', slot.url);
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        bar.value = event.loaded / event.total;
        status.textContent = `${formatSize(event.loaded)} of ${formatSize(event.total)}`;
        share(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
      xhr.onerror = () => resolve(false);
      xhr.send(file);
    });
    if (!sent) return fail(offline);

    try {
      const response = await fetch(`/api/rooms/${room}/uploads/${slot.id}/complete`, { method: 'POST' });
      if (!response.ok) return fail(await errorOf(response));
    } catch {
      return fail(offline);
    }
    row.remove();
    syncStates();
  })().finally(() => sendAction({ t: 'uploading', key, done: true }));
}

async function uploadAll(files) {
  for (const file of files) await uploadFile(file);
}

// The list updates when the server's broadcast arrives, so everyone, including the sender, sees the same result.
async function deleteFiles(fileId) {
  try {
    const response = await fetch(`/api/rooms/${roomId}/files${fileId ? `/${fileId}` : ''}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) throw new Error();
  } catch {
    toast('Could not delete. Check your connection and try again.', { error: true });
  }
}

/* ---------- Viewing files ---------- */

const viewer = $('viewer');
const viewerBody = $('viewer-body');
let viewing = null; // The file on screen: { id, controller, cleanup }.

const viewUrl = (id) => `/api/rooms/${roomId}/files/${id}/view`;
const downloadUrl = (id) => `/api/rooms/${roomId}/files/${id}`;
const viewableRows = () => [...filesList.children].filter((row) => row.dataset.viewable === 'true');

function loadingNode() {
  const box = element('div', 'viewer-message');
  box.setAttribute('role', 'status');
  box.append(element('div', 'spinner'), element('p', '', 'Loading…'));
  return box;
}

function viewerMessage(text, fileId) {
  const box = element('div', 'viewer-message');
  box.append(element('p', '', text));
  if (fileId) {
    const link = element('a', 'btn', 'Download');
    link.href = downloadUrl(fileId);
    link.download = '';
    box.append(link);
  }
  viewerBody.replaceChildren(box);
}

// Stops everything the last file was doing. Video and PDFs would otherwise keep downloading in the background.
function endViewing() {
  if (!viewing) return;
  viewing.controller.abort();
  viewing.cleanup?.();
  viewing = null;
  viewerBody.replaceChildren();
}

// The title, position in the list, and the previous and next buttons.
function updateViewerBar() {
  if (!viewer.open || !viewing) return;
  const rows = viewableRows();
  const at = rows.findIndex((row) => row.dataset.id === viewing.id);
  if (at < 0) return;
  const row = rows[at];
  const { extension } = FileTypes.describe(row.dataset.name);
  $('viewer-title').textContent = row.dataset.name;
  const meta = [`${at + 1} of ${rows.length}`, formatSize(Number(row.dataset.size)), extension.toUpperCase()];
  if (viewing.pages) meta.push(`${viewing.pages} page${viewing.pages === 1 ? '' : 's'}`);
  $('viewer-meta').textContent = meta.filter(Boolean).join(' · ');
  $('viewer-prev').disabled = at === 0;
  $('viewer-next').disabled = at === rows.length - 1;
}

const renderers = {
  async image(current, { id }) {
    const picture = element('img', 'viewer-image');
    picture.alt = '';
    picture.decoding = 'async';
    picture.addEventListener('click', () => picture.classList.toggle('zoomed')); // Tap to see it at full size.
    const loaded = new Promise((resolve, reject) => {
      picture.onload = resolve;
      picture.onerror = () => reject(new Error('The browser could not show this image.'));
    });
    picture.src = viewUrl(id);
    current.cleanup = () => {
      picture.onload = picture.onerror = null;
      picture.removeAttribute('src');
    };
    await loaded;
    if (viewing === current) viewerBody.replaceChildren(picture);
  },

  async video(current, { id }) {
    const clip = element('video', 'viewer-video');
    clip.controls = true;
    clip.playsInline = true;
    clip.preload = 'metadata'; // Nothing but the start is fetched until play is pressed.
    const ready = new Promise((resolve, reject) => {
      clip.onloadedmetadata = resolve;
      clip.onerror = () => reject(new Error('The browser could not play this video.'));
    });
    clip.src = viewUrl(id);
    current.cleanup = () => {
      clip.pause();
      clip.onloadedmetadata = clip.onerror = null;
      clip.removeAttribute('src');
      clip.load(); // Drops the connection, so a half-watched video stops using bandwidth.
    };
    await ready;
    if (viewing === current) viewerBody.replaceChildren(clip);
  },

  async audio(current, { id, name }) {
    const card = element('div', 'viewer-audio');
    const player = element('audio');
    player.controls = true;
    player.preload = 'metadata';
    const ready = new Promise((resolve, reject) => {
      player.onloadedmetadata = resolve;
      player.onerror = () => reject(new Error('The browser could not play this audio.'));
    });
    player.src = viewUrl(id);
    card.append(icon('music'), element('p', '', name), player);
    current.cleanup = () => {
      player.pause();
      player.onloadedmetadata = player.onerror = null;
      player.removeAttribute('src');
      player.load();
    };
    await ready;
    if (viewing === current) viewerBody.replaceChildren(card);
  },

  async text(current, { id, name, size }) {
    const limit = 1024 * 1024;
    const response = await fetch(viewUrl(id), { headers: { Range: `bytes=0-${limit - 1}` }, signal: current.controller.signal });
    if (!response.ok) throw new Error('The file could not be read.');
    const bytes = await response.arrayBuffer();
    if (viewing !== current) return;

    let text = new TextDecoder().decode(bytes);
    const truncated = size > bytes.byteLength;
    const extension = FileTypes.extension(name);
    const note = truncated
      ? element('p', 'viewer-note', `Showing the first ${formatSize(limit)} of ${formatSize(size)}. Download the file to see the rest.`)
      : null;

    if (extension === 'csv' || extension === 'tsv') {
      const rows = parseDelimited(text, extension === 'tsv' ? '\t' : ',');
      const table = element('table', 'viewer-table');
      const head = element('thead');
      const body = element('tbody');
      rows.forEach((cells, index) => {
        const tr = element('tr');
        for (const cell of cells) tr.append(element(index === 0 ? 'th' : 'td', '', cell));
        (index === 0 ? head : body).append(tr);
      });
      table.append(head, body);
      const wrap = element('div', 'viewer-table-wrap');
      wrap.append(...(note ? [note] : []), table);
      viewerBody.replaceChildren(wrap);
      return;
    }

    if (extension === 'json' && !truncated) {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {} // Not valid JSON, so it is shown as it is.
    }
    const box = element('div', 'viewer-text');
    if (note) box.append(note);
    box.append(document.createTextNode(text)); // Always text, never markup.
    viewerBody.replaceChildren(box);
  },

  async pdf(current, { id }) {
    const library = await loadPdfLibrary();
    const task = library.getDocument({ url: viewUrl(id) });
    let observer = null;
    let resizer = null;
    current.cleanup = () => {
      observer?.disconnect();
      resizer?.disconnect();
      task.destroy();
    };
    const pdf = await task.promise;
    if (viewing !== current) return;
    current.pages = pdf.numPages;
    updateViewerBar();

    const first = await pdf.getPage(1);
    const natural = first.getViewport({ scale: 1 });
    const holder = element('div', 'viewer-pdf');

    // Pages are drawn only while near the screen and cleared when far away, so a long PDF cannot exhaust a phone's memory.
    async function paint(slot, cssWidth) {
      if (slot.painted || slot.painting) return;
      slot.painting = true;
      try {
        const page = await pdf.getPage(Number(slot.dataset.page));
        const size = page.getViewport({ scale: 1 });
        const sharpness = Math.min(window.devicePixelRatio || 1, 2);
        const scale = Math.min((cssWidth / size.width) * sharpness, Math.sqrt(12_000_000 / (size.width * size.height)));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${cssWidth}px`;
        slot.style.height = `${Math.round((cssWidth * size.height) / size.width)}px`;
        slot.replaceChildren(canvas);
        slot.task = page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport });
        await slot.task.promise;
        slot.painted = true;
      } catch {
        // Scrolling away cancels a page that is still being drawn.
      } finally {
        slot.painting = false;
        if (slot.wanted && !slot.painted && viewing === current) paint(slot, cssWidth);
      }
    }

    function release(slot) {
      slot.task?.cancel();
      slot.replaceChildren();
      slot.painted = false;
    }

    function layout() {
      observer?.disconnect();
      const cssWidth = Math.max(200, Math.min(viewerBody.clientWidth - 24, 900));
      const cssHeight = Math.round((cssWidth * natural.height) / natural.width);
      const slots = Array.from({ length: pdf.numPages }, (_, index) => {
        const slot = element('div', 'pdf-page');
        slot.dataset.page = index + 1;
        slot.style.width = `${cssWidth}px`;
        slot.style.height = `${cssHeight}px`;
        return slot;
      });
      holder.replaceChildren(...slots);
      observer = new IntersectionObserver(
        (entries) => {
          for (const { target, isIntersecting } of entries) {
            target.wanted = isIntersecting;
            if (isIntersecting) paint(target, cssWidth);
            else release(target);
          }
        },
        { root: viewerBody, rootMargin: '120% 0px' },
      );
      slots.forEach((slot) => observer.observe(slot));
    }

    layout();
    viewerBody.replaceChildren(holder);

    // Turning a phone sideways changes the width, so the pages are laid out again.
    let width = viewerBody.clientWidth;
    resizer = new ResizeObserver(() => {
      if (Math.abs(viewerBody.clientWidth - width) < 8) return;
      width = viewerBody.clientWidth;
      layout();
    });
    resizer.observe(viewerBody);
  },
};

let pdfLibrary = null;
function loadPdfLibrary() {
  // The reader is large, so it is fetched only the first time a PDF is opened.
  pdfLibrary ??= import('/vendor/pdfjs/pdf.min.mjs').then((library) => {
    library.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    return library;
  });
  pdfLibrary.catch(() => {
    pdfLibrary = null; // So that opening another PDF tries again.
  });
  return pdfLibrary;
}

// Reads comma- or tab-separated text, including quoted cells. Enough rows to look at, not to edit.
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < 2000; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') cell += char;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

async function showInViewer(index) {
  const row = viewableRows()[index];
  if (!row) return;
  endViewing();
  const file = { id: row.dataset.id, name: row.dataset.name, size: Number(row.dataset.size) };
  const current = (viewing = { id: file.id, controller: new AbortController(), cleanup: null, pages: 0 });
  updateViewerBar();
  $('viewer-open').href = viewUrl(file.id);
  $('viewer-download').href = downloadUrl(file.id);
  $('viewer-download').download = file.name;
  viewerBody.replaceChildren(loadingNode());
  viewerBody.scrollTop = 0;

  try {
    await renderers[FileTypes.describe(file.name).kind](current, file);
  } catch (error) {
    if (viewing !== current || error.name === 'AbortError') return;
    viewerMessage(
      error.name === 'PasswordException'
        ? 'This PDF is protected by a password. Download it to open it.'
        : `${error.message?.startsWith('The ') ? error.message : 'This file could not be shown.'} Download it to open it instead.`,
      file.id,
    );
  }
}

function openViewer(fileId) {
  const index = viewableRows().findIndex((row) => row.dataset.id === fileId);
  if (index < 0) return;
  if (!viewer.open) viewer.showModal();
  showInViewer(index);
}

function closeViewer() {
  if (viewer.open) viewer.close();
  endViewing();
}

function stepViewer(step) {
  const rows = viewableRows();
  const next = rows.findIndex((row) => row.dataset.id === viewing?.id) + step;
  if (viewing && next >= 0 && next < rows.length) showInViewer(next);
}

$('viewer-close').addEventListener('click', closeViewer);
$('viewer-prev').addEventListener('click', () => stepViewer(-1));
$('viewer-next').addEventListener('click', () => stepViewer(1));
viewer.addEventListener('close', endViewing); // Also runs when Esc closes it.
viewer.addEventListener('keydown', (event) => {
  if (event.target.closest?.('audio, video, input, textarea')) return; // Those use the arrow keys themselves.
  if (event.key === 'ArrowLeft') stepViewer(-1);
  else if (event.key === 'ArrowRight') stepViewer(1);
  else return;
  event.preventDefault();
});

/* ---------- Buttons ---------- */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  // The clipboard API needs https, so plain http on a local network falls back to the older route.
  const scratch = document.createElement('textarea');
  scratch.value = text;
  scratch.style.cssText = 'position:fixed;opacity:0';
  document.body.append(scratch);
  scratch.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {}
  scratch.remove();
  return copied;
}

async function copyWithToast(text, done) {
  if (await copyText(text)) toast(done);
  else toast('Could not copy. Select the text and copy it by hand.', { error: true });
}

function parseRoomInput(value) {
  // Accepts a bare ID or a pasted room link.
  return value.trim().toLowerCase().match(/(?:^|\/)([a-z0-9]{8})\/?$/)?.[1];
}

/* ---------- Bot check (only when the server has it switched on) ---------- */

const challengeKey = document.querySelector('meta[name="turnstile-site-key"]')?.content ?? '';
const challenge = { widget: null, token: '' };

function loadChallenge() {
  if (!challengeKey) return;
  $('turnstile').hidden = false;
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.async = true;
  script.onload = () => {
    challenge.widget = window.turnstile.render('#turnstile', {
      sitekey: challengeKey,
      callback: (token) => {
        challenge.token = token;
      },
      'expired-callback': () => {
        challenge.token = '';
      },
      'error-callback': () => {
        challenge.token = '';
      },
    });
  };
  script.onerror = () => {
    $('turnstile').textContent = 'The human check could not load. Reload the page to try again.';
  };
  document.head.append(script);
}

// Each token works once, so the check starts over after every attempt.
function renewChallenge() {
  challenge.token = '';
  if (challenge.widget !== null) window.turnstile.reset(challenge.widget);
}

/* ---------- Creating and joining ---------- */

$('password-toggle').addEventListener('click', () => {
  const open = $('create-password-row').hidden;
  setCreatePasswordOpen(open);
  if (open) $('create-password').focus();
});

$('create-room').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (challengeKey && !challenge.token) {
    showHome('Please wait for the human check to finish, then try again.');
    return;
  }
  button.disabled = true;
  try {
    await enterRoom('/api/rooms', { password: $('create-password').value, turnstileToken: challenge.token });
    setCreatePasswordOpen(false);
  } catch (error) {
    showHome(error.status ? error.message : 'Could not reach the server. Check your connection.');
  }
  if (challengeKey) renewChallenge();
  button.disabled = false;
});

$('join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = parseRoomInput($('room-input').value);
  if (!id) return showHome('Enter the 8-character room ID, or paste the room link.');
  const password = $('join-password').value;
  try {
    await enterRoom(`/api/rooms/${id}/join`, password ? { password } : undefined);
  } catch (error) {
    if (error.needsPassword) requirePassword(id, error.message);
    else showHome(error.status ? error.message : 'Could not reach the server. Check your connection.');
  }
});

$('leave-room').addEventListener('click', async () => {
  // Every device asks first, so a stray tap never drops anyone out. Leaving as the last person also ends the room.
  const last = online <= 1;
  const leave = await confirmDialog(
    last
      ? {
          title: 'Leave this room?',
          body: 'You are the only one here. Leaving deletes all files and text in this room for good.',
          action: 'Leave and delete',
        }
      : {
          title: 'Leave this room?',
          body: 'The room stays open for the others. You can come back with the room code while someone is still in it.',
          action: 'Leave',
        },
  );
  if (!leave) return;
  clearTimeout(reconnectTimer);
  closeSocket();
  showHome();
});

$('copy-id').addEventListener('click', () => copyWithToast(roomId, 'Room ID copied'));

/* ---------- Invite dialog ---------- */

const inviteUrl = () => `${location.origin}/r/${roomId}`;
// Phones and tablets have a share sheet that goes straight to their messaging apps.
const canShareNatively = () => Boolean(navigator.share) && window.matchMedia('(pointer: coarse)').matches;

function drawQr(url) {
  const svgNs = 'http://www.w3.org/2000/svg';
  try {
    const { size, path } = Qr.build(url);
    const svg = document.createElementNS(svgNs, 'svg');
    const bars = document.createElementNS(svgNs, 'path');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('aria-hidden', 'true');
    bars.setAttribute('d', path);
    bars.setAttribute('fill', '#000');
    svg.append(bars);
    $('qr').replaceChildren(svg);
    $('qr').hidden = false;
  } catch {
    $('qr').hidden = true; // The link below still works without the picture.
  }
}

$('share-room').addEventListener('click', () => {
  const url = inviteUrl();
  const dialog = $('invite');
  if (typeof dialog.showModal !== 'function') return copyWithToast(url, 'Invite link copied');
  $('invite-link').value = url;
  $('invite-lock').hidden = !locked;
  $('invite-native').hidden = !canShareNatively();
  drawQr(url);
  dialog.showModal();
  $('invite-copy').focus();
});

$('invite-copy').addEventListener('click', () => copyWithToast(inviteUrl(), 'Invite link copied'));
$('invite-close').addEventListener('click', () => $('invite').close());
$('invite').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close(); // A click on the dimmed area.
});
$('invite-link').addEventListener('focus', (event) => event.target.select());
$('invite-native').addEventListener('click', async () => {
  try {
    await navigator.share({ title: 'Join my RoomShare room', url: inviteUrl() });
  } catch (error) {
    if (error.name !== 'AbortError') copyWithToast(inviteUrl(), 'Invite link copied');
  }
});

$('copy-text').addEventListener('click', () => copyWithToast(box.value, 'Message copied'));

$('clear-text').addEventListener('click', async () => {
  const clear = await confirmDialog({
    title: 'Clear the message?',
    body: 'This empties the shared text for everyone in the room.',
    action: 'Clear all',
  });
  if (!clear) return;
  box.value = '';
  box.focus();
  typed();
});

// Pasted screenshots arrive named "image.png", which is no help in a list of files.
function nameClipboardFile(file) {
  if (!/^image\.\w+$/i.test(file.name)) return file;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return new File([file], `screenshot-${stamp}.${file.name.split('.').pop().toLowerCase()}`, { type: file.type });
}

function uploadPasted(files) {
  selectTab('files');
  uploadAll(files.map(nameClipboardFile));
}

// Pasting an image with the keyboard or a long press uploads it. Pasting text is left alone.
document.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files ?? [])];
  if (!roomId || roomView.hidden || files.length === 0) return;
  event.preventDefault();
  uploadPasted(files);
});

$('paste-text').addEventListener('click', async () => {
  box.focus();
  let text = '';
  const images = [];
  try {
    for (const item of await navigator.clipboard.read()) {
      const imageType = item.types.find((type) => type.startsWith('image/'));
      if (imageType) images.push(new File([await item.getType(imageType)], `image.${imageType.split('/')[1]}`, { type: imageType }));
      else if (item.types.includes('text/plain')) text += await (await item.getType('text/plain')).text();
    }
  } catch {
    try {
      text = await navigator.clipboard.readText();
    } catch {
      // Browsers only allow this from a secure page and with permission. Pasting by hand always works.
      toast('Clipboard access is blocked here. Paste with Ctrl+V or a long press instead.', { error: true });
      return;
    }
  }
  if (images.length) uploadPasted(images);
  if (!text) return;
  box.setRangeText(text, box.selectionStart, box.selectionEnd, 'end');
  if (box.maxLength > 0 && box.value.length > box.maxLength) {
    box.value = box.value.slice(0, box.maxLength);
    toast(`Pasted text was cut to ${box.maxLength.toLocaleString()} characters.`, { error: true });
  }
  typed();
});

$('delete-all-files').addEventListener('click', async () => {
  const count = filesList.children.length;
  const remove = await confirmDialog({
    title: count === 1 ? 'Delete this file?' : `Delete all ${count} files?`,
    body: 'They are removed for everyone in the room and cannot be brought back.',
    action: count === 1 ? 'Delete' : 'Delete all',
  });
  if (remove) deleteFiles();
});

$('file-input').addEventListener('change', (event) => {
  uploadAll([...event.target.files]);
  event.target.value = '';
});

// A dropped file outside the zone would otherwise navigate the browser to it and leave the room.
// Dropped text is left alone, so it still goes into the message box.
const carriesFiles = (event) => event.dataTransfer?.types.includes('Files');
window.addEventListener('dragover', (event) => {
  if (!carriesFiles(event) || !roomId) return;
  event.preventDefault();
  $('drop-overlay').hidden = false;
});
window.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) $('drop-overlay').hidden = true;
});
window.addEventListener('drop', (event) => {
  $('drop-overlay').hidden = true;
  if (!carriesFiles(event)) return;
  event.preventDefault();
  if (roomId) {
    selectTab('files');
    uploadAll([...event.dataTransfer.files]);
  }
});

// Phones suspend sockets in the background, so reconnect the moment the page returns.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && unseen) {
    unseen = 0;
    updateTitle();
  }
  // A socket that is still connecting is left alone, or it would be replaced mid-handshake.
  if (document.visibilityState === 'visible' && roomId && (!socket || socket.readyState >= WebSocket.CLOSING)) {
    scheduleReconnect(0);
  }
});

window.addEventListener('popstate', () => location.reload());

/* ---------- Installing the app ---------- */

let installPrompt = null;
const onIphone = /iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone;

// Chrome and Edge offer an install prompt. iPhones have none, so they get instructions instead.
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  $('install-app').hidden = false;
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  $('install-app').hidden = true;
});
if (onIphone) $('install-app').hidden = false;

$('install-app').addEventListener('click', async () => {
  if (!installPrompt) return toast('Tap the Share button, then "Add to Home Screen".', { long: true });
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('install-app').hidden = true;
});

/* ---------- Room options: people, name, sound, lock, timer ---------- */

function renderPeople() {
  const list = $('people-list');
  list.replaceChildren(
    ...[...people].map(([pid, name]) => {
      const row = element('li');
      const tags = [pid === me && 'you', pid === ownerId && 'created the room'].filter(Boolean).join(', ');
      row.append(element('span', '', name));
      if (tags) row.append(element('span', 'tag', tags));
      return row;
    }),
  );
}

$('room-options').addEventListener('click', () => {
  renderPeople();
  $('name-input').value = people.get(me) ?? myName();
  $('sound-toggle').setAttribute('aria-checked', soundOn);
  $('lock-toggle').disabled = !isOwner;
  for (const button of document.querySelectorAll('#timer-options button')) button.disabled = !isOwner;
  $('owner-hint').hidden = isOwner;
  $('room-menu').showModal();
});
$('room-menu-close').addEventListener('click', () => $('room-menu').close());
$('room-menu').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});

$('name-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = Device.cleanName($('name-input').value);
  if (!name) return toast('Enter a name, or close this to keep the one you have.', { error: true });
  store.set('roomshare-name', name);
  people.set(me, name);
  sendAction({ t: 'name', name });
  renderPeople();
  toast('Name saved');
});

$('sound-toggle').addEventListener('click', () => {
  soundOn = !soundOn;
  store.set('roomshare-sound', soundOn ? 'on' : 'off');
  $('sound-toggle').setAttribute('aria-checked', soundOn);
  if (soundOn) chime();
});

$('lock-toggle').addEventListener('click', () => {
  if (!isOwner) return;
  sendAction({ t: 'lock', closed: !roomClosed });
  toast(roomClosed ? 'Room unlocked' : 'Room locked. Nobody new can join.');
});

for (const button of document.querySelectorAll('#timer-options button')) {
  button.addEventListener('click', () => {
    if (!isOwner) return;
    const seconds = Number(button.dataset.seconds);
    sendAction({ t: 'timer', seconds });
    toast(seconds ? `The room will delete itself in ${describeTimer(seconds * 1000)}.` : 'Timer off');
  });
}

/* ---------- Download all, as one zip made in the browser ---------- */

const ZIP_LIMIT = 500 * 1024 * 1024; // The zip is built in memory, which phones in particular cannot spare much of.
let zipLibrary = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(script);
  });
}

function uniqueName(name, used) {
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n += 1) {
    const dot = name.lastIndexOf('.');
    candidate = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

$('download-all').addEventListener('click', async () => {
  const rows = [...filesList.children].reverse(); // Oldest first, the order they were shared in.
  const total = rows.reduce((sum, row) => sum + Number(row.dataset.size), 0);
  if (total > ZIP_LIMIT) {
    return toast(`That is ${formatSize(total)}, too much to zip in a browser. Download the files one at a time.`, { error: true, long: true });
  }
  const button = $('download-all');
  const label = button.querySelector('.btn-label');
  button.disabled = true;
  try {
    zipLibrary ??= loadScript('/vendor/fflate.js').then(() => window.fflate);
    const { Zip, ZipPassThrough } = await zipLibrary;
    const parts = [];
    let zip;
    const finished = new Promise((resolve, reject) => {
      zip = new Zip((error, chunk, final) => {
        if (error) return reject(error);
        parts.push(chunk);
        if (final) resolve();
      });
    });
    const used = new Set();
    let done = 0;
    for (const row of rows) {
      const entry = new ZipPassThrough(uniqueName(row.dataset.name, used)); // Stored as is: most files are already compressed.
      zip.add(entry);
      const response = await fetch(downloadUrl(row.dataset.id));
      if (!response.ok) throw new Error('download failed');
      const reader = response.body.getReader();
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        entry.push(value);
        done += value.length;
        label.textContent = `Zipping ${Math.round((done / Math.max(total, 1)) * 100)}%`;
      }
      entry.push(new Uint8Array(0), true);
    }
    zip.end();
    await finished;
    const url = URL.createObjectURL(new Blob(parts, { type: 'application/zip' }));
    const link = element('a');
    link.href = url;
    link.download = `roomshare-${roomId}.zip`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    toast('Could not make the zip. Try again, or download the files one at a time.', { error: true });
  } finally {
    label.textContent = 'Download all';
    button.disabled = false;
  }
});

/* ---------- Scan a QR code to join ---------- */

const scanner = { stream: null, timer: null, reader: null };
let jsQrLibrary = null;

function showScanError(text) {
  $('scan-error').textContent = text;
  $('scan-error').hidden = false;
}

function stopScanner() {
  clearTimeout(scanner.timer);
  scanner.stream?.getTracks().forEach((track) => track.stop());
  scanner.stream = null;
  $('scan-video').srcObject = null;
}

// The browser's own QR reader where it has one (most phones), otherwise jsQR, loaded only now.
async function qrReader() {
  if ('BarcodeDetector' in window) {
    try {
      if ((await BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
        const detector = new BarcodeDetector({ formats: ['qr_code'] });
        return async (video) => (await detector.detect(video))[0]?.rawValue ?? null;
      }
    } catch {}
  }
  jsQrLibrary ??= loadScript('/vendor/jsQR.js').then(() => window.jsQR);
  const jsQR = await jsQrLibrary;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  return async (video) => {
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return jsQR(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data ?? null;
  };
}

$('scan-qr').hidden = !navigator.mediaDevices?.getUserMedia; // Cameras only work on secure (https) pages.

$('scan-qr').addEventListener('click', async () => {
  $('scan-error').hidden = true;
  $('scan').showModal();
  try {
    scanner.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch {
    return showScanError('The camera is blocked. Allow it for this site, or type the room ID instead.');
  }
  const video = $('scan-video');
  video.srcObject = scanner.stream;
  await video.play().catch(() => {});
  let read;
  try {
    read = await qrReader();
  } catch {
    return showScanError('The QR reader could not load. Type the room ID instead.');
  }
  const look = async () => {
    if (!scanner.stream) return;
    let text = null;
    try {
      if (video.readyState >= 2) text = await read(video);
    } catch {}
    const id = text && parseRoomInput(text);
    if (id) {
      $('scan').close();
      $('room-input').value = id;
      $('join-form').requestSubmit();
      return;
    }
    if (text) showScanError('That QR code is not a RoomShare room. Try the code on the screen that shows the room.');
    scanner.timer = setTimeout(look, text ? 1200 : 150);
  };
  look();
});
$('scan-close').addEventListener('click', () => $('scan').close());
$('scan').addEventListener('close', stopScanner);

loadChallenge();

const linkedRoom = location.pathname.match(/^\/r\/([a-z0-9]{8})$/)?.[1];
if (linkedRoom) {
  roomId = linkedRoom;
  rejoin();
}
