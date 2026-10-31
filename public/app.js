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
let session = new TextSync.Session();
let composing = false; // True while an input method (Hindi, Telugu, Chinese...) is building a character.
let held = []; // Changes from others that arrived mid-composition. Applying them would break the character.

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

function toast(text, { error = false } = {}) {
  const container = $('toasts');
  const node = element('div', error ? 'toast error' : 'toast', text);
  container.append(node);
  while (container.children.length > 3) container.firstChild.remove();
  setTimeout(() => node.classList.add('leaving'), 2600);
  setTimeout(() => node.remove(), 2850);
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
  $('files-count').hidden = fileCount === 0;
  $('files-count').textContent = fileCount;
  $('copy-text').disabled = $('clear-text').disabled = box.value.length === 0;
  const max = box.maxLength > 0 ? ` / ${box.maxLength.toLocaleString()}` : '';
  $('char-count').textContent = `${box.value.length.toLocaleString()}${max}`;
}

function showHome(error) {
  roomId = null;
  // Nothing from the room just left may show up in the next one.
  session = new TextSync.Session();
  held = [];
  online = 0;
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
  document.title = `Room ${id} · RoomShare`;
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

async function requestRoom(url) {
  const response = await fetch(url, { method: 'POST' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error ?? 'Something went wrong.'), { status: response.status });
  return body;
}

async function enterRoom(url) {
  const { id } = await requestRoom(url);
  roomId = id;
  showRoom(id);
  connect();
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
  const ws = new WebSocket(`${protocol}://${location.host}/api/rooms/${roomId}/ws`);
  socket = ws;

  ws.onmessage = (event) => handleMessage(JSON.parse(event.data));
  ws.onclose = () => {
    if (socket === ws && roomId) scheduleReconnect();
  };
}

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
    else scheduleReconnect();
  }
}

function setPresence(users) {
  online = users;
  $('presence-text').textContent = `${users} online`;
  presence.classList.remove('offline');
}

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
      maxFileBytes = data.maxFileBytes;
      box.maxLength = data.maxTextChars;
      $('size-hint').textContent = `Any file type, up to ${formatSize(data.maxFileBytes)} each`;
      filesList.replaceChildren();
      data.files.forEach(addFile);
      setPresence(data.users);
      applyResult(session.init(data.text, data.v));
      syncStates();
      break;
    case 'presence':
      setPresence(data.users);
      break;
    case 'text':
      if (composing) held.push(data);
      else applyResult(session.receive(data));
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
      syncStates();
      // On a phone the Files tab may be out of sight, so say that something arrived.
      if (stackedLayout.matches && panels.dataset.tab !== 'files') toast(`New file: ${data.file.name}`);
      break;
    case 'fileRemoved':
      filesList.querySelector(`[data-id="${data.id}"]`)?.remove();
      syncStates();
      break;
    case 'filesCleared':
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

function fileName(name) {
  const node = element('div', 'file-name', name);
  node.title = name; // Long names are cut to one line, so the full name is on hover and long press.
  return node;
}

function addFile(file) {
  const row = element('li', 'file');
  const info = element('div', 'file-info');
  info.append(fileName(file.name), element('div', 'file-meta', `${formatSize(file.size)} · ${formatTime(file.at)}`));

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
  actions.append(link, remove);
  row.dataset.id = file.id;
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

  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/rooms/${roomId}/files?name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      bar.value = event.loaded / event.total;
      status.textContent = `${formatSize(event.loaded)} of ${formatSize(event.total)}`;
    };
    xhr.onload = () => {
      if (xhr.status === 201) {
        row.remove();
        syncStates();
      } else {
        let reason = 'Upload failed.';
        try {
          reason = JSON.parse(xhr.responseText).error ?? reason;
        } catch {}
        fail(reason);
      }
      resolve();
    };
    xhr.onerror = () => {
      fail('Upload failed. Check your connection and try again.');
      resolve();
    };
    xhr.send(file);
  });
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

$('create-room').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await enterRoom('/api/rooms');
  } catch (error) {
    showHome(error.status ? error.message : 'Could not reach the server. Check your connection.');
  }
  button.disabled = false;
});

$('join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = parseRoomInput($('room-input').value);
  if (!id) return showHome('Enter the 8-character room ID, or paste the room link.');
  try {
    await enterRoom(`/api/rooms/${id}/join`);
  } catch (error) {
    showHome(error.status ? error.message : 'Could not reach the server. Check your connection.');
  }
});

$('leave-room').addEventListener('click', async () => {
  // Leaving as the last person ends the room, so that gets a second look.
  if (online <= 1) {
    const leave = await confirmDialog({
      title: 'Leave this room?',
      body: 'You are the only one here. Leaving deletes all files and text in this room for good.',
      action: 'Leave and delete',
    });
    if (!leave) return;
  }
  clearTimeout(reconnectTimer);
  closeSocket();
  showHome();
});

$('copy-id').addEventListener('click', () => copyWithToast(roomId, 'Room ID copied'));

$('share-room').addEventListener('click', async () => {
  const url = `${location.origin}/r/${roomId}`;
  // Phones and tablets have a share sheet that goes straight to their messaging apps.
  if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ title: 'Join my RoomShare room', url });
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
    }
  }
  copyWithToast(url, 'Invite link copied');
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

$('paste-text').addEventListener('click', async () => {
  box.focus();
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    // Browsers only allow this from a secure page and with permission. Pasting by hand always works.
    toast('Clipboard access is blocked here. Paste with Ctrl+V or a long press instead.', { error: true });
    return;
  }
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
  // A socket that is still connecting is left alone, or it would be replaced mid-handshake.
  if (document.visibilityState === 'visible' && roomId && (!socket || socket.readyState >= WebSocket.CLOSING)) {
    scheduleReconnect(0);
  }
});

window.addEventListener('popstate', () => location.reload());

const linkedRoom = location.pathname.match(/^\/r\/([a-z0-9]{8})$/)?.[1];
if (linkedRoom) {
  roomId = linkedRoom;
  rejoin();
}
