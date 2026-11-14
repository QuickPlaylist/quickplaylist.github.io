# Plex Playlists

A tiny installable web app (PWA) that shows the video playlists on your Plex
server. Tap a playlist to see its videos. Tap a video, or **Play all**, to
play it right there, streamed straight from your server.

- **Always current.** Playlists load live from your server each time you open
  the app or switch back to it, and every minute while it is open. New
  playlists appear on their own.
- **No shared logins.** The code has no credentials in it. Each person signs in
  with their own Plex account through Plex's sign-in page. The token is kept
  only in that browser on that device, and is sent only to plex.tv and to that
  person's own Plex servers. Anyone can use the same copy of the app safely.
- **Plays in the app.** It streams from your server, so the Plex app and its
  *Who's watching?* screen never appear. It picks up where you left off, plays
  the rest of the playlist in order, and reports progress to Plex, so watched
  marks and *Continue Watching* stay correct everywhere.
- **Plex Home profiles.** If your account has several profiles, the app asks
  *Who's watching?* once and remembers the answer. Change it any time in
  **Settings**.
- **No backend.** Static files only. Host it anywhere that serves HTTPS, such as GitHub Pages.

## Install on your phone

1. Open the app's address in your phone's browser.
2. Tap **Sign in with Plex** and sign in on the Plex page that opens.
3. Add it to your home screen:
   - **Android (Chrome):** menu ⋮ → *Add to Home screen* / *Install app*.
   - **iPhone (Safari):** Share → *Add to Home Screen*.

The home-screen icon now opens straight to your playlists.

Tip: open one playlist and add *that* page to your home screen to get a
button that goes straight to it.

## Playback

- If your browser can play the file as it is (for example MP4 with H.264 and
  AAC), the app plays the file directly, with no extra work for the server.
- Otherwise Plex sends an HLS stream. Plex copies the video when it can and
  converts it only when it has to. On iPhone the browser plays HLS itself;
  everywhere else the bundled [hls.js](https://github.com/video-dev/hls.js)
  (Apache-2.0, in `vendor/`) plays it.
- **Settings → Video quality**:
  - *Automatic* (the default) plays at original quality, except through
    Plex's relay, where it uses 2 Mbps.
  - Pick a lower quality to save mobile data.

### Opening the Plex app instead

**Settings → When I tap a video** can also open the Plex app, through
`plex://play/?metadataKey=…&server=…`, or Plex Web. Plex has never documented
the app link. If the Plex app shows *Who's watching?*, it drops the link, which
is why *Play it here* is the default.

## Requirements and limits

- The app talks to your Plex server from the browser over HTTPS, using the
  secure `*.plex.direct` addresses that Plex provides. At home it uses the
  local address. Away from home it needs **Remote Access** turned on in Plex,
  or it falls back to Plex's relay.
- It shows video playlists only, not music or photo playlists.
- If your account can see more than one server, the playlists are grouped by
  server.

## Hosting your own copy

Any static host works. For GitHub Pages: *Settings → Pages → Deploy from a
branch → `main` / root*. The app uses relative paths, so it works from a
sub-path like `https://<user>.github.io/plex-playlists/`.

To run it locally:

```
python3 -m http.server 8080
```

Then open <http://localhost:8080>. On plain `http://`, the service worker and
install prompt only work on `localhost`.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The app |
| `player.js` | The built-in player: direct play or HLS, resume, up next, progress reporting |
| `vendor/hls.light.min.js` | hls.js 1.5.20 (Apache-2.0) |
| `sw.js` | Service worker. Loads app files network-first so updates arrive on the next open. Never caches Plex data. |
| `manifest.webmanifest`, `icons/` | Install metadata and icons (`node tools/make-icons.mjs` regenerates the PNGs) |
| `auth-done.html` | The page Plex sends you back to after sign-in |

## Privacy

- Stored in your browser: your Plex sign-in, the profile you picked, a random
  device ID, your settings, and the last playlist list (so the app opens
  instantly).
- **Settings → Sign out** clears all of it.
- No analytics, no third-party scripts, no server of our own.

Not affiliated with or endorsed by Plex, Inc. "Plex" is a trademark of Plex, Inc.
