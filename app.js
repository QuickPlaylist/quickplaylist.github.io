/*
 * Plex Playlists — a static PWA that lists the video playlists on your Plex
 * server(s) and opens them in the Plex app.
 *
 * Privacy model: there are no credentials in this code. Each person signs in
 * with Plex's own PIN flow; the resulting token is stored only in this
 * browser's localStorage and is only ever sent to plex.tv and to the person's
 * own Plex servers.
 */
'use strict';

const PRODUCT = 'Plex Playlists';
const PLEX_TV = 'https://plex.tv';
const CLIENTS = 'https://clients.plex.tv';
const PROBE_TIMEOUT_MS = 5000;
const AUTO_REFRESH_MS = 60_000;

// ---------- storage (every access guarded: private mode can throw) ----------
const store = {
  get(k, fallback = null) {
    try { const v = localStorage.getItem('pp.' + k); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem('pp.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem('pp.' + k); } catch { /* ignore */ } },
  clearAll() {
    try { Object.keys(localStorage).filter(k => k.startsWith('pp.')).forEach(k => localStorage.removeItem(k)); }
    catch { /* ignore */ }
  },
};

function clientId() {
  let id = store.get('clientId');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) ||
      Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    store.set('clientId', id);
  }
  return id;
}

function plexHeaders(token) {
  const h = {
    Accept: 'application/json',
    'X-Plex-Product': PRODUCT,
    'X-Plex-Version': '1.0',
    'X-Plex-Client-Identifier': clientId(),
    'X-Plex-Platform': 'Web',
    'X-Plex-Device-Name': PRODUCT,
  };
  if (token) h['X-Plex-Token'] = token;
  return h;
}

async function fetchJSON(url, { token, method = 'GET', timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { method, headers: plexHeaders(token), signal: ctrl.signal, referrerPolicy: 'no-referrer' });
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
    return await res.json();
  } finally { clearTimeout(t); }
}

// ---------- Plex sign-in (PIN flow) ----------
async function createPin() {
  return fetchJSON(`${PLEX_TV}/api/v2/pins?strong=true`, { method: 'POST' });
}

function authUrl(pin, forwardUrl) {
  const p = new URLSearchParams({
    clientID: clientId(),
    code: pin.code,
    'context[device][product]': PRODUCT,
  });
  if (forwardUrl) p.set('forwardUrl', forwardUrl);
  return `https://app.plex.tv/auth#?${p.toString()}`;
}

async function pollPin(id, { until = Date.now() + 10 * 60_000 } = {}) {
  while (Date.now() < until) {
    try {
      const pin = await fetchJSON(`${PLEX_TV}/api/v2/pins/${encodeURIComponent(id)}`);
      if (pin.authToken) return pin.authToken;
      if (pin.expiresAt && Date.parse(pin.expiresAt) < Date.now()) return null;
    } catch (e) {
      if (e.status === 404) return null; // pin gone
    }
    await sleep(2000);
  }
  return null;
}

async function signIn() {
  // Open the window synchronously (inside the tap) so popup blockers allow it.
  const win = window.open('', '_blank');
  let pin;
  try { pin = await createPin(); }
  catch (e) { if (win) win.close(); showError('Could not reach plex.tv. Check your connection and try again.'); return; }
  store.set('pendingPin', { id: pin.id, at: Date.now() });
  const done = new URL('auth-done.html', location.href).href;
  if (win && !win.closed) {
    win.location.href = authUrl(pin, done);
    renderWaitingForSignIn();
    finishSignIn(pin.id);
  } else {
    // Popup blocked: go there in this tab and come back to the app.
    location.href = authUrl(pin, location.href.split('#')[0]);
  }
}

let polling = null;
async function finishSignIn(pinId) {
  if (polling === pinId) return;
  polling = pinId;
  const token = await pollPin(pinId);
  polling = null;
  store.del('pendingPin');
  if (!token) { route(); return; }
  store.set('token', token);
  store.del('servers');
  route();
}

// ---------- server discovery ----------
async function discoverServers(token) {
  const list = await fetchJSON(`${CLIENTS}/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1`, { token });
  const pageIsHttps = location.protocol === 'https:';
  const servers = list
    .filter(r => (r.provides || '').split(',').includes('server'))
    .map(r => ({
      id: r.clientIdentifier,
      name: r.name,
      owned: !!r.owned,
      token: r.accessToken || token,
      connections: (r.connections || [])
        .filter(c => !pageIsHttps || c.uri.startsWith('https://')) // https page can't call http servers
        .sort((a, b) => rank(a) - rank(b))
        .map(c => ({ uri: c.uri, relay: !!c.relay })),
    }))
    .filter(s => s.connections.length);
  // Owned servers first.
  servers.sort((a, b) => Number(b.owned) - Number(a.owned) || a.name.localeCompare(b.name));
  return servers;

  function rank(c) { return (c.relay ? 20 : 0) + (c.local ? 0 : 10) + (c.IPv6 ? 1 : 0); }
}

async function probe(uri, token) {
  await fetchJSON(`${uri}/identity`, { token, timeout: PROBE_TIMEOUT_MS });
  return uri;
}

// Find a reachable address: try all direct ones at once, relays only if none answer.
async function pickConnection(server) {
  if (server.uri) {
    try { return await probe(server.uri, server.token); } catch { /* re-pick */ }
  }
  const direct = server.connections.filter(c => !c.relay);
  const relay = server.connections.filter(c => c.relay);
  for (const group of [direct, relay]) {
    if (!group.length) continue;
    try { return await Promise.any(group.map(c => probe(c.uri, server.token))); } catch { /* next group */ }
  }
  return null;
}

async function getServers({ force = false } = {}) {
  const token = store.get('token');
  let servers = force ? null : store.get('servers');
  if (!servers) {
    servers = await discoverServers(token);
    store.set('servers', servers);
  }
  return servers;
}

async function serverRequest(server, path) {
  let uri = server.uri;
  if (!uri) uri = await connect(server);
  try {
    return await fetchJSON(uri + path, { token: server.token });
  } catch (e) {
    if (e.status === 401) throw e;
    // Address may have changed (e.g. left home Wi-Fi). Re-pick once.
    server.uri = null;
    uri = await connect(server);
    return fetchJSON(uri + path, { token: server.token });
  }
}

async function connect(server) {
  const uri = await pickConnection(server);
  if (!uri) { const e = new Error('unreachable'); e.unreachable = server.name; throw e; }
  server.uri = uri;
  const all = store.get('servers') || [];
  const s = all.find(x => x.id === server.id);
  if (s) { s.uri = uri; store.set('servers', all); }
  return uri;
}

// ---------- data ----------
async function loadPlaylists({ force = false } = {}) {
  let servers = await getServers({ force });
  if (!servers.length && !force) servers = await getServers({ force: true });
  const results = await Promise.allSettled(servers.map(async s => {
    const data = await serverRequest(s, '/playlists?playlistType=video');
    return (data.MediaContainer.Metadata || []).map(p => ({
      server: s.id,
      serverName: s.name,
      id: p.ratingKey,
      title: p.title,
      count: p.leafCount || 0,
      duration: p.duration || 0,
      smart: !!p.smart,
      art: p.composite || p.thumb || null,
      updatedAt: p.updatedAt || 0,
    }));
  }));
  const playlists = [];
  const errors = [];
  results.forEach((r, i) => r.status === 'fulfilled' ? playlists.push(...r.value) : errors.push({ server: servers[i].name, err: r.reason }));
  if (errors.some(e => e.err && e.err.status === 401) && !playlists.length) throw Object.assign(new Error('auth'), { status: 401 });
  return { servers, playlists, errors };
}

async function loadItems(serverId, playlistId) {
  const servers = await getServers();
  const s = servers.find(x => x.id === serverId);
  if (!s) throw new Error('Server not found');
  const data = await serverRequest(s, `/playlists/${encodeURIComponent(playlistId)}/items`);
  const mc = data.MediaContainer;
  return {
    title: mc.title,
    items: (mc.Metadata || []).map(m => ({
      key: m.key,
      title: m.title,
      type: m.type,
      show: m.grandparentTitle || null,
      se: m.type === 'episode' && m.parentIndex != null ? `S${m.parentIndex} · E${m.index}` : null,
      year: m.year || null,
      duration: m.duration || 0,
      offset: m.viewOffset || 0,
      watched: (m.viewCount || 0) > 0,
      thumb: m.type === 'episode' ? (m.thumb || m.grandparentThumb) : (m.art && m.type === 'clip' ? m.art : m.thumb),
      poster: m.type === 'movie',
    })),
  };
}

// ---------- links ----------
function plexAppLink(serverId, metadataKey) {
  return `plex://play/?metadataKey=${encodeURIComponent(metadataKey)}&server=${encodeURIComponent(serverId)}`;
}
function plexWebLink(serverId, metadataKey) {
  const isPlaylist = metadataKey.startsWith('/playlists/');
  const page = isPlaylist ? 'playlist' : 'details';
  return `https://app.plex.tv/desktop/#!/server/${encodeURIComponent(serverId)}/${page}?key=${encodeURIComponent(metadataKey)}`;
}
function openLink(serverId, key) {
  return store.get('linkMode', 'app') === 'web' ? plexWebLink(serverId, key) : plexAppLink(serverId, key);
}

function imageUrl(server, path, w, h) {
  if (!path || !server || !server.uri) return null;
  if (/^https?:/.test(path)) return path;
  const p = new URLSearchParams({ width: w, height: h, minSize: 1, upscale: 1, url: path, 'X-Plex-Token': server.token });
  return `${server.uri}/photo/:/transcode?${p}`;
}

// ---------- UI helpers ----------
const $ = sel => document.querySelector(sel);
const main = $('#main');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return n;
}
function bg(url) { return url ? `background-image:url("${url.replace(/"/g, '%22')}")` : null; }

function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

function setBar({ title, back = false, refresh = false, menu = false }) {
  $('#title').textContent = title;
  document.title = title === 'Playlists' ? PRODUCT : `${title} · ${PRODUCT}`;
  $('#back').hidden = !back;
  $('#refresh').hidden = !refresh;
  $('#menu').hidden = !menu;
}
function setSpinning(on) { $('#refresh').classList.toggle('spinning', on); }

function showError(msg) {
  const old = main.querySelector('.notice.error');
  if (old) old.remove();
  main.prepend(el('p', { class: 'notice error', role: 'alert' }, msg));
}

function describeError(e) {
  if (e && e.unreachable) return `Can't reach "${e.unreachable}". Is the server on? If you're away from home, make sure Remote Access is enabled in Plex.`;
  if (e && e.status === 401) return 'Plex says your sign-in has expired. Please sign in again.';
  return 'Could not load from Plex. Pull to refresh or tap ↻ to try again.';
}

// ---------- views ----------
function renderSignIn() {
  setBar({ title: 'Playlists' });
  main.replaceChildren(el('section', { class: 'empty' },
    el('h2', {}, 'Your Plex playlists, one tap away'),
    el('p', {}, 'Sign in with your Plex account. Your sign-in stays on this device — it is never sent to anyone but Plex and your own server.'),
    el('button', { class: 'btn primary big', onclick: signIn }, 'Sign in with Plex'),
  ));
}

function renderWaitingForSignIn() {
  setBar({ title: 'Playlists' });
  main.replaceChildren(el('section', { class: 'empty' },
    el('h2', {}, 'Finish signing in'),
    el('p', {}, 'Sign in on the Plex page that just opened. When it says you can close it, come back here.'),
    el('button', { class: 'btn', onclick: () => { store.del('pendingPin'); renderSignIn(); } }, 'Cancel'),
  ));
}

let lastSig = '';
let refreshing = null;

function renderPlaylists(data, { stale = false } = {}) {
  setBar({ title: 'Playlists', refresh: true, menu: true });
  const servers = data.servers || [];
  const byId = Object.fromEntries(servers.map(s => [s.id, s]));
  const groups = new Map();
  for (const p of data.playlists) {
    if (!groups.has(p.server)) groups.set(p.server, []);
    groups.get(p.server).push(p);
  }
  const kids = [];
  if (data.errors && data.errors.length) {
    for (const e of data.errors) kids.push(el('p', { class: 'notice error' }, describeError({ unreachable: e.server })));
  }
  if (!data.playlists.length) {
    kids.push(el('section', { class: 'empty' },
      el('h2', {}, servers.length ? 'No video playlists yet' : 'No Plex server found'),
      el('p', {}, servers.length
        ? 'Create a playlist in Plex and it will show up here automatically.'
        : 'This Plex account has no server it can reach. Check that your server is signed in to the same account.'),
    ));
  }
  const multi = groups.size > 1;
  for (const [sid, list] of groups) {
    list.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
    if (multi) kids.push(el('h2', { class: 'section-title' }, list[0].serverName));
    kids.push(el('ul', { class: 'grid' }, list.map(p => el('li', {},
      el('a', { class: 'card', href: `#/p/${encodeURIComponent(p.server)}/${encodeURIComponent(p.id)}` },
        el('div', { class: 'art', style: bg(imageUrl(byId[sid], p.art, 400, 400)), 'aria-hidden': 'true' },
          p.art ? '' : (p.title.trim()[0] || '?').toUpperCase()),
        el('p', { class: 'name' }, p.title),
        el('p', { class: 'meta' }, `${p.count} video${p.count === 1 ? '' : 's'}${p.duration ? ' · ' + fmtDuration(p.duration) : ''}`),
      )))));
  }
  if (stale) kids.unshift(el('p', { class: 'notice' }, 'Showing your last list — updating…'));
  main.replaceChildren(...kids);
}

function renderSkeletonGrid() {
  main.replaceChildren(el('ul', { class: 'grid' }, Array.from({ length: 6 }, () => el('li', {},
    el('div', { class: 'card' }, el('div', { class: 'art skeleton' }), el('p', { class: 'name muted' }, ' '))))));
}

async function showHome({ force = false } = {}) {
  const cached = store.get('playlists');
  if (cached && main.dataset.view !== 'home') renderPlaylists(cached);
  else if (!cached) { setBar({ title: 'Playlists', refresh: true, menu: true }); renderSkeletonGrid(); }
  main.dataset.view = 'home';
  await refreshHome({ force });
}

async function refreshHome({ force = false } = {}) {
  if (refreshing) return refreshing;
  setSpinning(true);
  refreshing = (async () => {
    try {
      const data = await loadPlaylists({ force });
      const sig = JSON.stringify([data.playlists, data.errors.map(e => e.server)]);
      store.set('playlists', { servers: data.servers, playlists: data.playlists, errors: [] });
      if (main.dataset.view === 'home' && (sig !== lastSig || force)) renderPlaylists(data);
      lastSig = sig;
    } catch (e) {
      if (e.status === 401) { signOut(); return; }
      if (main.dataset.view === 'home') showError(describeError(e));
    } finally {
      setSpinning(false);
      refreshing = null;
    }
  })();
  return refreshing;
}

async function showPlaylist(serverId, playlistId) {
  main.dataset.view = `p:${serverId}:${playlistId}`;
  const view = main.dataset.view;
  const cachedList = (store.get('playlists') || { playlists: [] }).playlists.find(p => p.server === serverId && p.id === playlistId);
  setBar({ title: cachedList ? cachedList.title : 'Playlist', back: true, refresh: true, menu: true });
  const cacheKey = `items.${serverId}.${playlistId}`;
  const cached = store.get(cacheKey);
  if (cached) renderItems(serverId, playlistId, cached);
  else main.replaceChildren(el('ul', { class: 'list' }, Array.from({ length: 5 }, () => el('li', {}, el('div', { class: 'item' }, el('div', { class: 'thumb skeleton' }), el('div', { class: 'text' }, ' '))))));
  setSpinning(true);
  try {
    const data = await loadItems(serverId, playlistId);
    store.set(cacheKey, data);
    if (main.dataset.view === view && JSON.stringify(data) !== JSON.stringify(cached)) renderItems(serverId, playlistId, data);
  } catch (e) {
    if (e.status === 401) { signOut(); return; }
    if (main.dataset.view === view) showError(describeError(e));
  } finally { setSpinning(false); }
}

function renderItems(serverId, playlistId, data) {
  const server = (store.get('servers') || []).find(s => s.id === serverId);
  setBar({ title: data.title, back: true, refresh: true, menu: true });
  const total = data.items.reduce((a, i) => a + i.duration, 0);
  const listKey = `/playlists/${playlistId}`;
  const cachedList = (store.get('playlists') || { playlists: [] }).playlists.find(p => p.server === serverId && p.id === playlistId);
  main.replaceChildren(
    el('section', { class: 'hero' },
      el('div', { class: 'art', style: bg(imageUrl(server, cachedList && cachedList.art, 300, 300)), 'aria-hidden': 'true' }),
      el('div', {},
        el('p', { class: 'meta' }, `${data.items.length} video${data.items.length === 1 ? '' : 's'}${total ? ' · ' + fmtDuration(total) : ''}`),
        data.items.length ? el('a', { class: 'btn primary', href: openLink(serverId, listKey) }, '▶ Play all in Plex') : null,
      ),
    ),
    data.items.length
      ? el('ol', { class: 'list' }, data.items.map((it, i) => el('li', {},
        el('a', { class: 'item', href: openLink(serverId, it.key) },
          el('span', { class: 'num', 'aria-hidden': 'true' }, it.watched ? '✓' : String(i + 1)),
          el('div', { class: 'thumb' + (it.poster ? ' poster' : ''), style: bg(imageUrl(server, it.thumb, it.poster ? 120 : 240, it.poster ? 180 : 135)), 'aria-hidden': 'true' }),
          el('div', { class: 'text' },
            el('div', { class: 't' }, it.title),
            el('div', { class: 's' }, [it.show, it.se, it.year, it.duration ? fmtDuration(it.duration) : null].filter(Boolean).join(' · ')),
            it.offset && it.duration ? el('div', { class: 'progress', 'aria-label': 'In progress' }, el('i', { style: `width:${Math.min(100, (it.offset / it.duration) * 100).toFixed(1)}%` })) : null,
          ),
        ))))
      : el('section', { class: 'empty' }, el('h2', {}, 'This playlist is empty'), el('p', {}, 'Add videos to it in Plex and they will show up here.')),
  );
}

// ---------- settings ----------
function signOut() {
  const keep = { clientId: store.get('clientId'), linkMode: store.get('linkMode') };
  store.clearAll();
  if (keep.clientId) store.set('clientId', keep.clientId);
  if (keep.linkMode) store.set('linkMode', keep.linkMode);
  lastSig = '';
  main.dataset.view = '';
  if ($('#settings').open) $('#settings').close();
  location.hash = '';
  renderSignIn();
}

async function openSettings() {
  const d = $('#settings');
  $('#link-mode').value = store.get('linkMode', 'app');
  const who = $('#signed-in-as');
  who.textContent = '';
  d.showModal();
  try {
    const u = await fetchJSON(`${PLEX_TV}/api/v2/user`, { token: store.get('token') });
    who.textContent = `Signed in to Plex as ${u.username || u.title || 'your account'}.`;
  } catch { /* offline: leave blank */ }
}

// ---------- routing ----------
function route() {
  const pending = store.get('pendingPin');
  if (!store.get('token')) {
    if (pending && Date.now() - pending.at < 10 * 60_000) { renderWaitingForSignIn(); finishSignIn(pending.id); }
    else renderSignIn();
    return;
  }
  const m = location.hash.match(/^#\/p\/([^/]+)\/([^/]+)$/);
  if (m) showPlaylist(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
  else showHome();
}

// Back returns to the list. If we got here from the list, pop history so the
// phone's own back gesture stays in sync; if the app was opened straight onto
// a playlist, replace the entry instead.
let cameFromHome = false;
window.addEventListener('hashchange', e => { cameFromHome = !new URL(e.oldURL).hash.startsWith('#/p/'); });
$('#back').addEventListener('click', () => {
  if (cameFromHome) history.back();
  else location.replace(location.href.split('#')[0] + '#');
});
$('#refresh').addEventListener('click', () => {
  const m = location.hash.match(/^#\/p\/([^/]+)\/([^/]+)$/);
  if (m) showPlaylist(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
  else refreshHome({ force: true });
});
$('#menu').addEventListener('click', openSettings);
$('#signout').addEventListener('click', signOut);
$('#link-mode').addEventListener('change', e => { store.set('linkMode', e.target.value); route(); });
window.addEventListener('hashchange', route);

// Keep the list fresh: refresh whenever the app comes back to the foreground,
// and every minute while it's open.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && store.get('token')) route();
});
setInterval(() => {
  if (document.visibilityState === 'visible' && store.get('token') && main.dataset.view === 'home') refreshHome();
}, AUTO_REFRESH_MS);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* app still works without it */ });
}

route();
