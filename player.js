/*
 * In-app player. Streams straight from the person's Plex server, so the Plex
 * app (and its "Who's watching?" screen) is never involved.
 *
 * - Plays the file as-is when the browser can (MP4/H.264 etc.), otherwise asks
 *   Plex for an HLS stream (it copies the video when it can, converts when not).
 * - Resumes where you left off and reports progress back to Plex, so
 *   "Continue watching" and watched marks stay correct in the Plex apps.
 * - Plays the rest of the playlist in order.
 */
'use strict';

(() => {
  const TIMELINE_EVERY_MS = 10_000;
  const UP_NEXT_SECONDS = 5;
  const RELAY_BITRATE = 2000; // Plex's relay is slow; keep streams small there.

  let s = null;      // current session state
  let ui = null;     // DOM refs
  let hlsLib = null; // promise for hls.js, loaded on first need
  // Last playback failure, for bug reports. Issues are public, so it holds only
  // fixed wording, numbers and codec names: never text from Plex or the browser.
  let lastError = null;

  function loadHls() {
    if (!hlsLib) {
      hlsLib = new Promise((resolve, reject) => {
        const tag = document.createElement('script');
        tag.src = 'vendor/hls.light.min.js';
        tag.onload = () => resolve(window.Hls);
        tag.onerror = () => { hlsLib = null; reject(new Error('Could not load the video player')); };
        document.head.append(tag);
      });
    }
    return hlsLib;
  }

  function uuid() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  }

  function build() {
    const root = document.createElement('div');
    root.className = 'player';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Video player');
    root.hidden = true;
    root.innerHTML = `
      <div class="p-top">
        <button class="icon-btn p-close" aria-label="Close player">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
        <div class="p-title"><strong></strong><small></small></div>
        <button class="icon-btn p-fs" aria-label="Full screen">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>
        </button>
      </div>
      <video playsinline controls preload="auto"></video>
      <div class="p-status" hidden>
        <p class="p-msg"></p>
        <div class="p-actions"></div>
      </div>
      <div class="p-bottom">
        <button class="btn p-prev">‹ Previous</button>
        <button class="btn p-restart" hidden>↺ Start over</button>
        <button class="btn p-next">Next ›</button>
      </div>`;
    document.body.append(root);
    const q = sel => root.querySelector(sel);
    ui = {
      root, video: q('video'), title: q('.p-title strong'), sub: q('.p-title small'),
      status: q('.p-status'), msg: q('.p-msg'), actions: q('.p-actions'),
      prev: q('.p-prev'), next: q('.p-next'), restart: q('.p-restart'),
    };
    q('.p-close').addEventListener('click', () => close());
    q('.p-fs').addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) { try { screen.orientation.unlock(); } catch { /* ignore */ } }
    });
    ui.prev.addEventListener('click', () => go(s.index - 1));
    ui.next.addEventListener('click', () => go(s.index + 1));
    ui.restart.addEventListener('click', () => { ui.video.currentTime = 0; ui.restart.hidden = true; ui.video.play().catch(() => {}); });

    const v = ui.video;
    v.addEventListener('playing', () => { hideStatus(); timeline('playing'); });
    v.addEventListener('pause', () => { if (!v.ended) timeline('paused'); });
    v.addEventListener('ended', onEnded);
    v.addEventListener('error', () => onMediaError());
    v.addEventListener('timeupdate', () => { if (s && v.currentTime > 30) ui.restart.hidden = true; });

    window.addEventListener('popstate', () => { if (s && s.pushed) { s.pushed = false; close(); } });
    document.addEventListener('keydown', e => { if (s && e.key === 'Escape' && !document.fullscreenElement) close(); });
  }

  // ---------- public ----------
  async function open(opts) {
    if (!ui) build();
    // Opening does exactly what Next does: show the player and load. It does
    // not go fullscreen by itself, because phones let a video start with
    // sound only within a few seconds of a tap, and going fullscreen uses
    // that tap up. The ⛶ button (or the video's own control) goes fullscreen.
    if (s) await teardown();
    s = { ...opts, pushed: false, timer: null, upNext: null };
    ui.root.hidden = false;
    document.documentElement.classList.add('player-open');
    history.pushState({ ppPlayer: 1 }, '');
    s.pushed = true;
    load(s.index);
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) { await document.exitFullscreen(); return; }
      await ui.root.requestFullscreen({ navigationUI: 'hide' });
      try { await screen.orientation.lock('landscape'); } catch { /* not supported */ }
    } catch {
      // iPhone: only the video itself can go fullscreen.
      if (ui.video.webkitEnterFullscreen) ui.video.webkitEnterFullscreen();
    }
  }

  async function close() {
    if (!s) return;
    const done = s.onClose;
    if (s.pushed) { s.pushed = false; history.back(); }
    await teardown();
    s = null;
    ui.root.hidden = true;
    document.documentElement.classList.remove('player-open');
    try { if (document.fullscreenElement) await document.exitFullscreen(); } catch { /* ignore */ }
    try { screen.orientation.unlock(); } catch { /* ignore */ }
    if (done) done();
  }

  // ---------- loading ----------
  function go(i) {
    if (!s || i < 0 || i >= s.items.length) return;
    load(i);
  }

  async function load(i, { forceHls = false, retried = false, keepReloaded = false } = {}) {
    await teardown({ keepOpen: true });
    s.index = i;
    s.session = uuid();
    s.forcedHls = forceHls;
    s.mediaInfo = null;
    s.hlsVia = null;
    if (!keepReloaded) s.reloaded = false;
    const item = s.items[i];
    ui.title.textContent = item.title;
    ui.sub.textContent = `${s.playlistTitle} · ${i + 1} of ${s.items.length}`;
    ui.prev.disabled = i === 0;
    ui.next.disabled = i === s.items.length - 1;
    ui.restart.hidden = true;
    showStatus('Loading…');
    mediaSession(item);

    let meta;
    try {
      meta = await api(`/library/metadata/${encodeURIComponent(item.ratingKey)}`);
      meta = meta.MediaContainer.Metadata[0];
    } catch (e) {
      if (!retried && s.reconnect) {
        try { s.server = await s.reconnect(); return load(i, { forceHls, retried: true, keepReloaded }); } catch { /* fall through */ }
      }
      return fail("Can't reach your Plex server.", [['Try again', () => load(i)], ['Close', close]]);
    }
    s.meta = meta;
    s.duration = meta.duration || item.duration || 0;
    const media = (meta.Media || [])[0];
    const part = media && (media.Part || [])[0];
    if (media) s.mediaInfo = describeMedia(media);
    if (!part) return fail('This video has no playable file.', [['Skip', () => go(i + 1)], ['Close', close]]);

    // Resume unless it's (nearly) finished.
    const offset = meta.viewOffset || 0;
    s.startAt = offset > 0 && (!s.duration || offset < s.duration * 0.95) ? offset / 1000 : 0;

    const bitrate = maxBitrate();
    const direct = !forceHls && !bitrate && canPlayDirect(media);
    try {
      if (direct) await playDirect(part);
      else await playHls(bitrate);
    } catch (e) {
      fail(e.message || 'Could not play this video.', [['Try again', () => load(i)], ['Close', close]], e.report || errorKind(e));
      return;
    }
    if (s.startAt) ui.restart.hidden = false;
    s.timer = setInterval(() => { if (!ui.video.paused) timeline('playing'); }, TIMELINE_EVERY_MS);
  }

  function maxBitrate() {
    const q = s.quality || 'auto';
    if (q === 'original') return 0;
    if (q === 'auto') return s.server.relay ? RELAY_BITRATE : 0;
    return Number(q) || 0;
  }

  // File format only (e.g. "mkv / hevc / eac3 / 1080p"): enough to reproduce, nothing personal.
  // Each field is picked from a list of known names; anything else is "other".
  const KNOWN = {
    container: ['mkv', 'mp4', 'm4v', 'mov', 'avi', 'webm', 'mpegts', 'ts', 'm2ts', 'mpeg', 'wmv', 'asf', 'flv', '3gp', 'ogg'],
    videoCodec: ['h264', 'hevc', 'av1', 'vp9', 'vp8', 'mpeg2video', 'mpeg4', 'msmpeg4v3', 'vc1', 'wmv3', 'h263', 'mjpeg', 'theora'],
    audioCodec: ['aac', 'ac3', 'eac3', 'dca', 'dca-ma', 'dts', 'truehd', 'flac', 'opus', 'mp3', 'mp2', 'vorbis', 'pcm', 'alac', 'wmapro', 'wmav2'],
    videoResolution: ['sd', '480', '576', '720', '1080', '2k', '4k', '8k'],
  };
  function describeMedia(m) {
    const pick = k => (m[k] == null ? null : KNOWN[k].includes(String(m[k]).toLowerCase()) ? String(m[k]).toLowerCase() : 'other');
    const res = pick('videoResolution');
    return [pick('container'), pick('videoCodec'), pick('audioCodec'), res && (/^\d+$/.test(res) ? res + 'p' : res)].filter(Boolean).join(' / ');
  }

  // An error that came with its own report-safe wording.
  const own = (msg, report = msg) => Object.assign(new Error(msg), { report });

  // Any other error, as a category only: error text can quote server replies or addresses.
  const ERROR_NAMES = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError', 'ReferenceError', 'NotAllowedError',
    'NotSupportedError', 'InvalidStateError', 'SecurityError', 'QuotaExceededError', 'NetworkError', 'TimeoutError']);
  function errorKind(e) {
    if (e && e.status) return `HTTP ${Number(e.status) || 'error'}`;
    if (e && e.name === 'AbortError') return 'request cancelled or timed out';
    if (e && e.name === 'TypeError' && /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/.test(e.message)) return 'network error';
    return e && ERROR_NAMES.has(e.name) ? e.name : 'other error';
  }

  const CONTAINERS = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm' };
  const VCODECS = { h264: 'avc1.640028', hevc: 'hvc1.1.6.L120.90', av1: 'av01.0.08M.08', vp9: 'vp09.00.40.08', vp8: 'vp8' };
  const ACODECS = { aac: 'mp4a.40.2', mp3: 'mp4a.6B', opus: 'opus', vorbis: 'vorbis', flac: 'flac' };
  function canPlayDirect(media) {
    const type = CONTAINERS[media.container];
    const vc = VCODECS[media.videoCodec];
    const ac = media.audioCodec ? ACODECS[media.audioCodec] : null;
    if (!type || !vc || (media.audioCodec && !ac)) return false;
    const codecs = [vc, ac].filter(Boolean).join(', ');
    return ui.video.canPlayType(`${type}; codecs="${codecs}"`) !== '';
  }

  function serverUrl(path, extra = {}) {
    const p = new URLSearchParams({ ...extra, 'X-Plex-Token': s.server.token });
    return `${s.server.uri}${path}${path.includes('?') ? '&' : '?'}${p}`;
  }

  async function playDirect(part) {
    s.mode = 'direct';
    const v = ui.video;
    v.src = serverUrl(part.key);
    if (s.startAt) v.addEventListener('loadedmetadata', () => { v.currentTime = s.startAt; }, { once: true });
    await start();
  }

  function hlsParams(bitrate) {
    const h = s.headers;
    const p = {
      path: s.meta.key,
      protocol: 'hls',
      directPlay: 0,
      directStream: 1,
      directStreamAudio: 1,
      mediaIndex: 0,
      partIndex: 0,
      fastSeek: 1,
      offset: 0,
      session: s.session,
      subtitles: 'burn',
      location: s.server.relay ? 'wan' : 'lan',
      'X-Plex-Session-Identifier': s.session,
      'X-Plex-Client-Identifier': h['X-Plex-Client-Identifier'],
      'X-Plex-Product': h['X-Plex-Product'],
      'X-Plex-Platform': 'Chrome',
      'X-Plex-Client-Profile-Extra':
        'add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac,mp3)',
    };
    if (bitrate) Object.assign(p, { maxVideoBitrate: bitrate, videoBitrate: bitrate, videoQuality: 60 });
    else p.videoQuality = 100;
    return p;
  }

  async function playHls(bitrate) {
    s.mode = 'hls';
    const params = hlsParams(bitrate);
    // Ask Plex first so a "can't play" answer becomes a readable message.
    const d = await api(`/video/:/transcode/universal/decision?${new URLSearchParams(params)}`).catch(() => null);
    const mc = d && d.MediaContainer;
    if (mc && mc.generalDecisionCode >= 2000) {
      // Show Plex's reason on screen; the report gets only the numeric code.
      throw own(`Plex can't play this video: ${mc.generalDecisionText || 'unknown reason'}`,
        `Plex can't play this video (decision code ${Number(mc.generalDecisionCode)})`);
    }
    const url = serverUrl('/video/:/transcode/universal/start.m3u8', params);
    const v = ui.video;
    const Hls = await loadHls().catch(() => null);
    if (Hls && Hls.isSupported()) {
      s.hlsVia = 'hls.js';
      const hls = new Hls({ startPosition: s.startAt || -1, enableWorker: true, maxBufferLength: 30 });
      s.hls = hls;
      let recovered = false;
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; hls.recoverMediaError(); return; }
        onMediaError();
      });
      hls.loadSource(url);
      hls.attachMedia(v);
      await new Promise((resolve, reject) => {
        hls.once(Hls.Events.MANIFEST_PARSED, resolve);
        hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) reject(own('Plex could not start the stream.')); });
      });
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      s.hlsVia = 'the browser';
      v.src = url;
      if (s.startAt) v.addEventListener('loadedmetadata', () => { v.currentTime = s.startAt; }, { once: true });
    } else {
      throw own("This browser can't play this video.");
    }
    await start();
  }

  async function start() {
    try { await ui.video.play(); }
    catch (e) {
      if (e && e.name === 'AbortError') return; // replaced by another load
      // The phone refused to start with sound. A tap here always works.
      showStatus('', [['▶ Play', () => { hideStatus(); ui.video.play().catch(() => {}); }]]);
    }
  }

  function onMediaError() {
    // Ignore errors from an empty or torn-down <video>.
    if (!s || !s.mode) return;
    const err = ui.video.error;
    const code = err ? `${err.code}${err.message ? ' ' + err.message : ''}` : 'stream';
    // First error on this video: reload it once, exactly as Next would.
    if (!s.reloaded) { s.reloaded = true; load(s.index, { forceHls: s.forcedHls, keepReloaded: true }); return; }
    // A direct file the browser still won't play: let Plex convert it.
    if (s.mode === 'direct' && !s.forcedHls) { load(s.index, { forceHls: true, keepReloaded: true }); return; }
    // The report gets the error number and the browser's leading error name (e.g.
    // PIPELINE_ERROR_DECODE), never the rest of its message. Browser error names
    // always contain an underscore, so an all-caps word such as a server name won't match.
    const name = err && typeof err.message === 'string' ? (err.message.match(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/) || [])[0] : null;
    const safe = err ? `MediaError ${Number(err.code) || '?'}${name ? ' ' + name : ''}` : 'stream error';
    fail(`Playback stopped with an error (${code}).`, [['Try again', () => load(s.index, { forceHls: true })], ['Skip', () => go(s.index + 1)], ['Close', close]],
      `Playback stopped with an error (${safe})`);
  }

  // An error state: remember what failed for a bug report, and offer to file one.
  // `msg` is shown on screen; `report` is the only wording a bug report gets.
  function fail(msg, actions, report = msg) {
    const how = s.mode === 'hls' ? (s.hlsVia ? `HLS via ${s.hlsVia}` : 'HLS, before the stream started') : s.mode === 'direct' ? 'direct play' : 'before playback started';
    lastError = { report, how, media: s.mediaInfo };
    showStatus(msg, s.report ? [...actions, ['Report a problem', s.report]] : actions);
  }

  function onEnded() {
    timeline('stopped');
    scrobble();
    if (s.index >= s.items.length - 1) {
      showStatus('That was the last video in the playlist.', [['Play again from the start', () => load(0)], ['Close', close]]);
      return;
    }
    const next = s.items[s.index + 1];
    let n = UP_NEXT_SECONDS;
    const tick = () => {
      if (!s) return;
      if (n <= 0) { go(s.index + 1); return; }
      ui.msg.textContent = `Up next: ${next.title} in ${n}…`;
      n -= 1;
      s.upNext = setTimeout(tick, 1000);
    };
    showStatus('', [['Play now', () => go(s.index + 1)], ['Cancel', () => { clearTimeout(s.upNext); hideStatus(); }]]);
    tick();
  }

  async function teardown() {
    if (!s) return;
    clearTimeout(s.upNext);
    clearInterval(s.timer);
    s.timer = null;
    const v = ui.video;
    if (s.meta && v.currentTime > 0 && !v.ended) {
      timeline('stopped');
      if (s.duration && v.currentTime * 1000 >= s.duration * 0.9) scrobble();
    }
    if (s.hls) { s.hls.destroy(); s.hls = null; }
    if (s.mode === 'hls' && s.session) {
      fetch(serverUrl('/video/:/transcode/universal/stop', { session: s.session }), { headers: s.headers }).catch(() => {});
    }
    v.pause();
    v.removeAttribute('src');
    v.load();
    s.mode = null;
    s.meta = null;
  }

  // ---------- talking to Plex ----------
  async function api(path) {
    const res = await fetch(s.server.uri + path, { headers: s.headers });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return res.json();
  }

  function timeline(state) {
    if (!s || !s.meta) return;
    const p = {
      ratingKey: s.meta.ratingKey, key: s.meta.key, state,
      time: Math.round(ui.video.currentTime * 1000),
      duration: s.duration || Math.round((ui.video.duration || 0) * 1000),
      identifier: 'com.plexapp.plugins.library',
    };
    fetch(`${s.server.uri}/:/timeline?${new URLSearchParams(p)}`, { headers: { ...s.headers, 'X-Plex-Session-Identifier': s.session } }).catch(() => {});
  }

  function scrobble() {
    if (!s || !s.meta) return;
    const p = { identifier: 'com.plexapp.plugins.library', key: s.meta.ratingKey };
    fetch(`${s.server.uri}/:/scrobble?${new URLSearchParams(p)}`, { headers: s.headers }).catch(() => {});
  }

  // ---------- bits of UI ----------
  function showStatus(msg, actions = []) {
    ui.msg.textContent = msg;
    ui.actions.replaceChildren(...actions.map(([label, fn], i) => {
      const b = document.createElement('button');
      b.className = 'btn' + (i === 0 ? ' primary' : '');
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    }));
    ui.status.hidden = false;
  }
  function hideStatus() { ui.status.hidden = true; }

  function mediaSession(item) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: item.title, album: s.playlistTitle });
      navigator.mediaSession.setActionHandler('previoustrack', s.index > 0 ? () => go(s.index - 1) : null);
      navigator.mediaSession.setActionHandler('nexttrack', s.index < s.items.length - 1 ? () => go(s.index + 1) : null);
    } catch { /* ignore */ }
  }

  window.Player = { open, close, info: () => ({ open: !!s, lastError }), forgetError: () => { lastError = null; } };
})();
