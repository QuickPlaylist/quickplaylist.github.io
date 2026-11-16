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
  converts it only when it has to. Safari (iPhone, iPad, Mac) plays HLS
  itself, which keeps AirPlay working. Other browsers use the bundled
  [hls.js](https://github.com/video-dev/hls.js) (Apache-2.0, in `vendor/`).
  If one way fails, the app tries the other.
- **Settings → Video quality**:
  - *Automatic* (the default) plays at original quality, except through
    Plex's relay, where it uses 2 Mbps.
  - Pick a lower quality to save mobile data.
- **Repeat:** the repeat button at the top of the player changes the mode
  each time you tap it:
  - *Off* (the default): the player stops after the last video.
  - *Repeat all* (button highlighted): after the last video, the playlist starts again
    from the first. A playlist with one video plays that video again and again.
  - *Repeat one* (button highlighted, with a 1): the same video plays again at once.

  The app remembers your choice on this device. A repeated video always
  starts from the beginning, and each play counts as a watch in Plex.
- **Buttons:** while a video plays, the buttons fade after 3 seconds. Tap the
  screen to show them again. They stay while the video is paused.
- **Full screen on Android:** Chrome shows its own message ("Drag from top
  and ... to exit full screen") for about 3.5 seconds. A web page can't turn
  it off.

### Cast to a TV

The cast button (or the AirPlay button in Safari) appears at the top of the
player when a TV is found on the same Wi-Fi. The TV then plays the video
straight from your Plex server.

- **Safari (iPhone, iPad, Mac):** AirPlay works for all videos.
- **Chrome (Android or computer):** Chromecast and Google TV work only for
  videos that play directly, for example MP4 with H.264 and AAC. Chrome can't
  cast the hls.js stream that Plex sends for other files. For those, use your
  phone's own screen casting, for example *Screen cast* on a Pixel or
  *Smart View* on a Samsung.

Videos always play in this app. It has no option to open the Plex app or
Plex Web: when Plex shows its *Who's watching?* screen, it drops the video
the app asked for.

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
| `player.js` | The built-in player: direct play or HLS, casting and AirPlay, resume, up next, progress reporting |
| `vendor/hls.light.min.js` | hls.js 1.5.20 (Apache-2.0) |
| `sw.js` | Service worker. Loads app files network-first so updates arrive on the next open. Never caches Plex data. |
| `manifest.webmanifest`, `icons/` | Install metadata and icons (`node tools/make-icons.mjs` regenerates the PNGs) |
| `auth-done.html` | The page Plex sends you back to after sign-in |
| `paypal-qr.png` | PayPal donate QR code, shown in **Settings** |

## Report a bug

To report a problem, [file a bug](https://github.com/claytonkimber/plex-playlists/issues/new).
You need a free GitHub account. These open the same form:

- **Settings → Report a bug**
- **Trouble signing in? Report a bug** on the sign-in screen
- **Report a problem** when a video won't play

The app fills in the form with what helps to find the problem. This is the
complete list:

- the screen you were on
- whether you are signed in, and whether the account uses Plex Home
- your settings (*Video quality* and *Repeat*)
- which kinds of server connection are in use: direct, through Plex's relay,
  or not connected yet (not how many servers)
- whether the app is installed and works offline
- your browser and system with their main version numbers (for example
  `Chrome 131 on Android 14`), and your screen size and pixel ratio
- the last loading problem, as a category (for example `HTTP 503`,
  `network error`, or `some servers unreachable`)
- the last playback problem: the error number and the browser's error code
  name (for example `MediaError 3 PIPELINE_ERROR_DECODE`) or Plex's numeric
  decision code, how the video was playing (direct play or HLS), and the
  video's file format (for example `mkv / hevc / eac3 / 1080p`)

It never adds your Plex sign-in, your user, profile or server names, server
addresses or IDs, playlist and video titles, the rest of any error message,
or your browser's full user-agent text. Signing out or switching profile
clears the remembered errors.

The details go to GitHub in the link as soon as the form opens. They become
public only if you submit the issue. You see the whole report first, and you
can change or remove any part of it.

**CAUTION:** Do not attach screenshots that show your server, playlists or
account unless you agree that all persons can see them.

## Support

This app is free and has no ads. To support the app, use one of these:

- [Donate with PayPal or card](https://www.paypal.com/donate/?hosted_button_id=WKTVYE2X9UX4G).
- Scan this QR code with the PayPal app:

<img src="paypal-qr.png" alt="PayPal QR code" width="200">

In the app, **Settings → Support this app** shows the same link and QR code.

## Privacy

- Stored in your browser: your Plex sign-in, the profile you picked, a random
  device ID, your settings, and the last playlist list (so the app opens
  instantly).
- **Settings → Sign out** clears all of it.
- No analytics, no third-party scripts, no server of our own.
- The **Donate** button opens PayPal, which has its own terms. The app sends
  PayPal nothing.
- **Report a bug** opens a GitHub form filled in with the details listed under
  [Report a bug](#report-a-bug). Those details go to GitHub in the link, and
  nothing is posted until you submit it.

Not affiliated with or endorsed by Plex, Inc. "Plex" is a trademark of Plex, Inc.
