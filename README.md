# RoomShare

**Share files and text between your devices through a temporary room. No account, no install, no database.**

Open the site, create a room, and open the link on your phone, tablet or another computer. Drop files into one side and type in a shared text box on the other, and both show up everywhere instantly. When the last person leaves, everything is deleted.

## Features

- **Rooms with no sign-up.** Create a room to get a random 8-character ID and an invite link, or join one by typing its ID or pasting its link. Only people who joined can see anything in it.
- **Files.** Drag and drop or pick files (up to 2 GB each by default). Everyone in the room can download them. Each file can be deleted on its own, or all at once.
- **A shared Message box.** One text box that everyone in the room edits together, live, with no Send button. Copy all, Paste and Clear all are one tap away. People typing at the same time keep each other's words.
- **Nothing is kept.** Text lives in server memory and files in a temporary folder. Once the last person has been gone for 15 seconds the room, its text and its files are deleted.
- **Invite with a QR code.** Share opens a dialog with a QR code and the link. Point a phone camera at it to join, or copy the link.
- **Optional room password.** Choose "Protect with a password" when creating a room. Anyone opening the link is asked for it, a lock icon shows inside the room, and repeated wrong guesses are blocked.
- **Paste images.** Press Ctrl+V with a screenshot or photo copied (or use the Paste button) and it uploads to Files, named by date and time.
- **View files without downloading.** Tap a file (or its eye icon) to open it full-screen: pictures, video and audio play, PDFs read page by page even on phones, and text, code, JSON and CSV files show on the spot. Step through the files with the arrows, and nothing is saved to your device.
- **Installable.** Add it to the home screen of a phone or the desktop and it opens like an app, with its own icon.
- **Link previews.** A room link shared in WhatsApp, Slack or similar shows the RoomShare name and a picture. The preview never reveals anything about the room.
- **Optional bot check.** Free Cloudflare Turnstile can be switched on to stop automated room creation. It is off unless you set its keys.
- **Light and dark themes.** It follows the device setting and can be switched with one button. The choice is remembered.
- **Works on every screen.** Phones and tablets show Files and Message as tabs. Larger screens show them side by side. Buttons are sized for touch, and notches and rounded corners are respected.
- **Fast.** Plain Node.js and one WebSocket per tab. The whole page is about 18 KB (about 6 KB gzipped), cached by the browser after the first visit, with no build step and no front-end library.

## Quick start

Requires Node.js 20 or newer. The only dependency is [`ws`](https://github.com/websockets/ws).

```bash
npm install
npm start        # http://localhost:3000
```

To try it from a phone on the same Wi-Fi, open `http://<your-computer's-address>:3000`. Allow Node.js through the firewall if asked. Over plain `http://` on a network address the browser may block the Paste button, so use Ctrl+V or a long press instead. It works normally over HTTPS.

```bash
npm test         # 78 tests, a few seconds
```

## How it works

```
 Browser (page + textsync.js)  <--- one WebSocket per tab --->  server.js
   - shows the room                                               - rooms live in memory
   - sends small text edits                                       - files stream to a temp folder
   - uploads / downloads files over HTTP                          - deletes a room when it empties
```

- **Joining.** Creating or joining a room gives your browser a cookie scoped to that room. The file, upload and live-update endpoints all check it, and the WebSocket also checks the page's origin.
- **Shared text.** Each change is sent as "replace these characters with this text". The server puts all changes in one order. A change made against an older version is moved past the ones that landed first, so people typing in different places, or both at the end of the text, all keep their words. If two people change the very same characters at the same instant, the one that reaches the server second is refused and that person's box shows the server's text. The logic is in `public/textsync.js`, which the browser and the server both load so they follow identical rules. `test/textsync.test.js` runs hundreds of random simulated sessions and checks that everyone ends with the same text.
- **Who is online.** The count is people, not tabs. All tabs of one browser share a cookie and count once. A tab that closes or loses signal is noticed within about 20 seconds.
- **Files.** Uploads and downloads stream straight between the network and disk, so a 2 GB file never sits in memory. Deleting a file also stops any download of it that is in progress.

## Project structure

```
roomShare/
├── server.js             Backend: rooms, WebSocket, file upload and download, cleanup
├── package.json
├── render.yaml           One-click setup for Render (free plan)
├── public/               Everything the browser loads
│   ├── index.html        Home screen and room markup, icons, dialogs, link-preview tags
│   ├── style.css         Light and dark themes, responsive layout
│   ├── app.js            Page logic: rooms, files, shared text, passwords, invite, buttons
│   ├── textsync.js       Merges simultaneous typing (runs in browser and server)
│   ├── theme.js          Light/dark switch, applied before the page paints
│   ├── qr.js             Turns a link into QR code image data
│   ├── filetypes.js      Decides which files can be viewed, and as what (runs in browser and server)
│   ├── vendor/qrcode.js  QR encoder by Kazuhiko Arase (MIT), copied from npm
│   ├── vendor/pdfjs/     Mozilla's PDF reader (Apache-2.0), loaded only when a PDF is opened
│   ├── manifest.webmanifest, icon-*.png, apple-touch-icon.png   Installable-app files
│   └── og-image.png      Picture shown in link previews
└── test/
    ├── rooms.test.js       Server tests: access, files, text, online count, cleanup
    ├── protection.test.js  Passwords, lockout, bot check, room cap, security policy
    ├── assets.test.js      Manifest, icons, link-preview tags, robots header
    ├── view.test.js        Viewing files: types, sandboxing, range requests, access
    ├── filetypes.test.js   Which names are viewable, and that nothing runnable gets a runnable type
    ├── qr.test.js          Draws QR codes and decodes them back with a separate reader
    └── textsync.test.js    Merge engine tests and random-typing simulation
```

## Viewing files

| Kind | Examples | Shown as |
| --- | --- | --- |
| Pictures | png, jpg, gif, webp, avif, bmp, ico, svg | The picture, fitted to the screen. Tap to see it at full size |
| Video | mp4, webm, mov, m4v, ogv | A player with seeking. Whether a file plays depends on the codecs in the person's browser |
| Audio | mp3, wav, m4a, aac, ogg, opus, flac | A player |
| PDF | pdf | Pages drawn one after another. Only pages near the screen are in memory, so long PDFs are safe on phones |
| Text | txt, md, log, json, code (js, py, html, css...) | The text. JSON is indented. HTML is shown as its source, never as a page |
| Tables | csv, tsv | A table of the first 2,000 rows |

Anything else (Word, Excel, PowerPoint, zip, HEIC photos) shows no View button and can only be downloaded. Text files show their first 1 MB.

How it stays safe:

- The file's type comes from a fixed list in `public/filetypes.js`, chosen by the file name. The server never trusts the type an upload claims, and sends `nosniff` so a browser cannot decide a picture is really a web page.
- Nothing that can run code is ever sent as a page. HTML and scripts go out as plain text.
- Opened on its own ("Open in a new tab"), a file is sandboxed: no scripts, and no access to the site or its cookies. A script hidden inside an SVG does nothing. PDFs are the one exception, because browsers refuse to show a PDF inside a sandbox. They still run PDF content in the viewer's own isolated area.
- Only people inside the room can view a file. Deleting a file closes it for anyone watching.

Things to know:

- **Viewing uses bandwidth like downloading does.** On hosts with a monthly allowance (Render's free plan has 5 GB), watching a video counts. Videos and PDFs are fetched in pieces, so only the part you look at is sent, and closing the viewer stops the transfer.
- **No thumbnails in the file list.** They would make every person's browser download every picture each time the room opens.
- The PDF reader is large (about 1.8 MB), so it is only fetched the first time someone opens a PDF. Text inside PDFs cannot be selected yet, because pages are drawn as pictures.

## Configuration

Everything is optional. Set these as environment variables.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where to listen |
| `STORAGE_DIR` | OS temp folder | Parent of the `roomshare-files` folder. Only that subfolder is ever wiped |
| `EMPTY_ROOM_GRACE_MS` | `15000` | How long an empty room survives, so a page refresh does not delete it |
| `MAX_FILE_BYTES` | 2 GiB | Per-file limit |
| `MAX_ROOM_BYTES` / `MAX_TOTAL_BYTES` | 10 GiB / 50 GiB | Per-room and whole-server disk caps |
| `MAX_ROOM_FILES`, `MAX_ROOM_USERS` | 500, 500 | Per-room caps |
| `MAX_TEXT_CHARS` | 100000 | Length of the shared text |
| `MAX_ROOMS` | 500 | Rooms that may exist at once. New rooms are refused beyond this, which protects a small server from a flood |
| `PASSWORD_FAILURES_PER_MINUTE` | 20 | Wrong room passwords allowed per room per minute from everyone together. Past this the room refuses all password attempts for a minute |
| `PUBLIC_URL` | (none) | The site's public address, for link previews. On Render it is filled in automatically from `RENDER_EXTERNAL_URL` |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` | (none) | Switch on the Cloudflare Turnstile bot check. Both are needed |
| `ROOM_ATTEMPTS_PER_MINUTE` | 30 | Per address. Counts room creation and failed joins |
| `TRUST_PROXY` | `0` | How many reverse proxies are in front of the server (`1` on Render or behind nginx, `2` for a CDN plus the host's proxy). The client address is then read from the entry those proxies added to `X-Forwarded-For`, not from what a visitor sends |

## Deploying for free on Render

`render.yaml` describes the service, so Render can set it up from the repository.

1. Put this folder in its own GitHub repository (`.gitignore` already leaves out `node_modules`):
   ```bash
   git init
   git add .
   git commit -m "RoomShare"
   git branch -M main
   git remote add origin https://github.com/<your-name>/roomshare.git
   git pull origin main --allow-unrelated-histories
   git push -u origin main
   ```
   The `git pull` line is needed when you chose a license (or a README) while creating the repository, because GitHub then starts it with a commit of its own. If Git reports a conflict in `README.md`, keep this project's version with `git checkout --ours README.md`, then `git add README.md` and `git commit --no-edit`. Skip the pull line if the repository was created empty.
2. In Render choose **New > Blueprint**, pick the repository, and apply. (Or **New > Web Service** with build command `npm install`, start command `npm start`, instance type Free, and the settings from `render.yaml`.)
3. Open the `https://<name>.onrender.com` link when the deploy finishes. HTTPS and WebSockets work without further setup.

What to expect on the free plan:

- The service sleeps after 15 minutes with no inbound traffic, so the first visit after a quiet period waits for it to wake. Open WebSocket messages count as traffic.
- The disk is temporary and Render can restart the service at any time. Either one ends every open room, which matches the "nothing is kept" design.
- The limits in `render.yaml` (100 MB per file, 500 MB per room, 1 GB in total) suit a small free disk. Raise them on a larger plan.
- Everyone in a room connects to this one server, so people far from its region see each other's changes a round trip later, roughly 100 to 300 ms between continents. Pick the region closest to most of your users.

### Turning on the bot check (optional)

Without it, anyone can create rooms, limited only by the per-address rate limit and `MAX_ROOMS`. To require a free Cloudflare Turnstile check:

1. In the Cloudflare dashboard open **Turnstile**, choose **Add site**, enter your site's hostname (for example `roomshare.onrender.com`), and pick the **Managed** widget.
2. Copy the **site key** and the **secret key** it gives you.
3. Add them in Render under Environment as `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET`, and save.

When it is on, the page loads Cloudflare's script and a small widget appears above the Create button. Each new room needs a fresh pass, and joining an existing room does not. If Cloudflare cannot be reached, new rooms are refused rather than let through. The secret is only ever read by the server.

To try it locally without an account, use Cloudflare's published test keys: site key `1x00000000000000000000AA` and secret `1x0000000000000000000000000000000AA` always pass, and the secret `2x0000000000000000000000000000000AA` always fails.

### Link previews and installing

- Previews are built from the site's public address. Render provides it automatically, and elsewhere you set `PUBLIC_URL`. Chat apps cache a preview for a while, so changes to it can take time to show up.
- Room links ask search engines not to index them.
- "Install" and "Add to Home Screen" need HTTPS, which Render provides. Chrome and Edge show an install button on the home screen. On iPhones the button explains Share > Add to Home Screen.

### Other hosts

Anything that runs `npm start` behind HTTPS will do, as long as it is a single instance. An Oracle Cloud Always Free VM stays on all the time, but you run the server yourself.

- Put it behind HTTPS (Caddy, nginx or a platform load balancer). Browsers only allow clipboard access on HTTPS, and room IDs travel in URLs.
- In nginx, enable WebSocket upgrade headers, raise `client_max_body_size` above your file limit, set `proxy_request_buffering off` so uploads stream, and set `proxy_read_timeout` above the 10-second heartbeat.
- Set `TRUST_PROXY` to the number of proxies in front of the server, or every visitor will share the proxy's address for rate limiting.
- Run **one instance**. Rooms live in that process's memory and disk, so a second instance would not see them. To scale out, route by room ID at the load balancer instead of adding a shared database.
- Give the server enough disk for `MAX_TOTAL_BYTES`.

## Security and limits

- **Not end-to-end encrypted.** The server relays the text and holds files unencrypted on its disk while a room is open. Use HTTPS, and do not use it for sensitive material unless you add client-side encryption.
- **Anyone with the room ID can join, unless the room has a password.** IDs have about 40 bits of randomness, and creating rooms or failing to join is rate limited per address. A room password is checked on the server and kept only as a salted hash. It controls who can enter, and it does not encrypt anything: the server still sees the text and files. The invite link and QR code do not contain the password, so share it separately.
- **Files are always served as downloads,** never displayed by the browser, and the page's content security policy blocks anything but its own scripts and styles.
- **A public anonymous file host can attract misuse.** Files are not scanned. Keep the size limits modest if you open it to everyone.
- **Rooms are temporary on purpose.** A server restart ends every room, and the shared text is limited to 100,000 characters.

## License

MIT. See [LICENSE](LICENSE). The bundled QR encoder in `public/vendor/qrcode.js` is [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase, also MIT. "QR Code" is a registered trademark of Denso Wave Incorporated. The PDF reader in `public/vendor/pdfjs/` is [PDF.js](https://github.com/mozilla/pdf.js) by Mozilla, under the Apache License 2.0 (its text is in that folder).
