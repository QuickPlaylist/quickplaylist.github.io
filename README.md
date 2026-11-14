# Plex Playlists

A tiny installable web app (PWA) that shows the video playlists on your Plex
server. Tap a playlist to see its videos. Tap a video, or **Play all**, to open
it in the Plex app.

- **Always current.** Playlists load live from your server each time you open
  the app or switch back to it, and every minute while it is open. New
  playlists appear on their own.
- **No shared logins.** The code has no credentials in it. Each person signs in
  with their own Plex account through Plex's sign-in page. The token is kept
  only in that browser on that device, and is sent only to plex.tv and to that
  person's own Plex servers. Anyone can use the same copy of the app safely.
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

## How opening in Plex works

Videos open with Plex's app link:

```
plex://play/?metadataKey=%2Flibrary%2Fmetadata%2F<id>&server=<server id>
```

**Play all** uses the same link with `metadataKey=/playlists/<id>`. Plex has
never documented this link format, so a Plex app update could change it. If
links stop opening the app, switch **Settings → When I tap a video** to
*Open Plex in the browser*, which uses `app.plex.tv`.

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
| `sw.js` | Service worker. Loads app files network-first so updates arrive on the next open. Never caches Plex data. |
| `manifest.webmanifest`, `icons/` | Install metadata and icons (`node tools/make-icons.mjs` regenerates the PNGs) |
| `auth-done.html` | The page Plex sends you back to after sign-in |

## Privacy

- Stored in your browser: your Plex token, a random device ID, and the last
  playlist list (so the app opens instantly).
- **Settings → Sign out** clears all of it.
- No analytics, no third-party scripts, no server of our own.

Not affiliated with or endorsed by Plex, Inc. "Plex" is a trademark of Plex, Inc.
