# RoomShare

**Share files and text between your devices through a temporary room. No account, no install, no database. Runs on Cloudflare's free plan, always on.**

Open the site, create a room, and open the link on your phone, tablet or another computer. Drop files into one side and type in a shared text box on the other, and both show up everywhere instantly. When the last person leaves, everything is deleted.

## Features

- **Rooms with no sign-up.** Create a room to get a random 8-character ID and an invite link, or join one by typing its ID or pasting its link. Only people who joined can see anything in it.
- **Files.** Drag and drop or pick files (up to 2 GB each with direct uploads to R2, 100 MB otherwise). Everyone in the room can download them. Each file can be deleted on its own, or all at once.
- **A shared Message box.** One text box that everyone in the room edits together, live, with no Send button. Copy all, Paste and Clear all are one tap away. People typing at the same time keep each other's words.
- **Nothing is kept.** Text and the file list live in the room's own Durable Object, and files in an R2 bucket. Once the last person has been gone for 15 seconds the room, its text and its files are deleted.
- **Invite with a QR code.** Share opens a dialog with a QR code and the link. Point a phone camera at it to join, or copy the link.
- **Optional room password.** Choose "Protect with a password" when creating a room. Anyone opening the link is asked for it, a lock icon shows inside the room, and repeated wrong guesses are blocked.
- **Paste images.** Press Ctrl+V with a screenshot or photo copied (or use the Paste button) and it uploads to Files, named by date and time.
- **View files without downloading.** Tap a file (or its eye icon) to open it full-screen: pictures, video and audio play, PDFs read page by page even on phones, and text, code, JSON and CSV files show on the spot. Step through the files with the arrows, and nothing is saved to your device.
- **Installable.** Add it to the home screen of a phone or the desktop and it opens like an app, with its own icon.
- **Link previews.** A room link shared in WhatsApp, Slack or similar shows the RoomShare name and a picture. The preview never reveals anything about the room.
- **Optional bot check.** Free Cloudflare Turnstile can be switched on to stop automated room creation. It is off unless you set its keys.
- **Light and dark themes.** It follows the device setting and can be switched with one button. The choice is remembered.
- **Works on every screen.** Phones and tablets show Files and Message as tabs. Larger screens show them side by side. Buttons are sized for touch, and notches and rounded corners are respected.
- **Fast and always on.** The page is served from Cloudflare's edge and never sleeps. One WebSocket per tab, no front-end library, and the whole page is about 18 KB, cached by the browser after the first visit.

## Quick start

Requires Node.js 22.12 or newer. Everything runs locally, including the Durable Objects and the R2 bucket, so no Cloudflare account is needed to develop or test.

```bash
npm install
npm run dev      # http://localhost:8787
```

`npm run dev` runs `wrangler dev`, which first builds `dist/` from `public/` (see `scripts/build-assets.mjs`). Without R2 keys, uploads go through the Worker, which is how it works locally.

To try it from a phone on the same Wi-Fi, run `npx wrangler dev --ip 0.0.0.0` and open `http://<your-computer's-address>:8787`. Over plain `http://` on a network address the browser may block the Paste button, so use Ctrl+V or a long press instead. It works normally over HTTPS.

```bash
npm test         # 88 tests, about 40 seconds
```

The tests start the Worker locally with Wrangler's test harness (`test/harness.js`), so they cover the real routes, Durable Objects and R2 bucket.

## How it works

```
 Browser -- page, scripts, icons ---------------> Static Assets (free, runs no code)
    |
    +-- /api/rooms, /join, files ---------------> Worker --> Gate (one Durable Object: room count, bytes, rate limits)
    |                                               |
    +-- WebSocket /api/rooms/<id>/ws -------------->+--> Room (one Durable Object per room: members, text, file list)
    |                                               |
    +-- upload: PUT to a signed link -----------> R2 bucket <-- downloads and viewing stream through the Worker
```

- **Joining.** Creating or joining a room gives your browser a cookie scoped to that room. The file, upload and live-update endpoints all check it, and the WebSocket also checks the page's origin.
- **Shared text.** Each change is sent as "replace these characters with this text". The room puts all changes in one order. A change made against an older version is moved past the ones that landed first, so people typing in different places, or both at the end of the text, all keep their words. If two people change the very same characters at the same instant, the one that arrives second is refused and that person's box shows the room's text. The logic is in `public/textsync.js`, which the browser and the room both load so they follow identical rules. `test/textsync.test.js` runs hundreds of random simulated sessions and checks that everyone ends with the same text.
- **Sleeping rooms.** Rooms use the WebSocket Hibernation API: a quiet room is unloaded from memory without dropping anyone, and wakes when someone types. The text is saved at most once a second, so it survives that.
- **Who is online.** The count is people, not tabs. All tabs of one browser share a cookie and count once. Each tab sends "ping" every 15 seconds, which Cloudflare answers without waking the room. A tab that closes is noticed at once, and one that loses signal within about a minute.
- **Files.** The page reserves space, gets a link that is valid for 15 minutes, uploads straight to R2, and then tells the room the upload finished. The room checks the stored size against what was reserved before anyone sees the file. Space for uploads that never finish is given back after 30 minutes. Downloads and viewing stream from R2 through the Worker, which checks the room cookie.

## Project structure

```
roomShare/
├── wrangler.jsonc        Cloudflare setup: Worker, Static Assets, Durable Objects, R2, settings
├── src/
│   ├── worker.js         Routes: rooms, joining, uploads, downloads, viewing, room links
│   ├── room.js           Room Durable Object: members, password, shared text, files, live connections, cleanup
│   ├── gate.js           Gate Durable Object: room count, total bytes, per-address limits
│   └── shared.js         Limits, routes, security policy and helpers used by the Worker, the build and the tests
├── scripts/
│   └── build-assets.mjs  Builds dist/ from public/: fills in the page, writes _headers
├── public/               Everything the browser loads
│   ├── index.html        Home screen and room markup, icons, dialogs, link-preview tags
│   ├── style.css         Light and dark themes, responsive layout
│   ├── app.js            Page logic: rooms, files, shared text, passwords, invite, buttons
│   ├── textsync.js       Merges simultaneous typing (runs in browser and room)
│   ├── theme.js          Light/dark switch, applied before the page paints
│   ├── qr.js             Turns a link into QR code image data
│   ├── filetypes.js      Decides which files can be viewed, and as what (runs in browser and Worker)
│   ├── vendor/qrcode.js  QR encoder by Kazuhiko Arase (MIT), copied from npm
│   ├── vendor/pdfjs/     Mozilla's PDF reader (Apache-2.0), loaded only when a PDF is opened
│   ├── manifest.webmanifest, icon-*.png, apple-touch-icon.png   Installable-app files
│   └── og-image.png      Picture shown in link previews
└── test/
    ├── harness.js            Starts the Worker locally for a test file
    ├── rooms.test.js         Access, files, text, sleeping rooms, online count, cleanup
    ├── protection.test.js    Passwords, lockout, bot check, request bodies, security policy
    ├── timing.test.js        Room cap, silent connections, abandoned uploads, freed space
    ├── direct-upload.test.js Signed R2 upload links and the page's upload permission
    ├── assets.test.js        Manifest, icons, link-preview tags, robots header, 404s
    ├── view.test.js          Viewing files: types, sandboxing, range requests, access
    ├── filetypes.test.js     Which names are viewable, and that nothing runnable gets a runnable type
    ├── qr.test.js            Draws QR codes and decodes them back with a separate reader
    └── textsync.test.js      Merge engine tests and random-typing simulation
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
- Only people inside the room can view a file.

Things to know:

- **Viewing is fetched in pieces.** Videos and PDFs are read with range requests, so only the part you look at is sent, and closing the viewer stops the transfer. R2 charges nothing for data going out, but each piece is one Worker request.
- **No thumbnails in the file list.** They would make every person's browser download every picture each time the room opens.
- The PDF reader is large (about 1.8 MB), so it is only fetched the first time someone opens a PDF. Text inside PDFs cannot be selected yet, because pages are drawn as pictures.

## Configuration

Settings are Worker vars in `wrangler.jsonc` (`"vars"`), and secrets set with `npx wrangler secret put <NAME>`. Everything is optional.

| Name | Kind | Default | Purpose |
| --- | --- | --- | --- |
| `PUBLIC_URL` | var | (none) | The site's address, for link previews. Set it to your `workers.dev` address after the first deploy |
| `R2_ACCOUNT_ID` | var | (none) | Your Cloudflare account ID. With the two R2 secrets, uploads go straight to R2 and files can be 2 GB |
| `R2_BUCKET` | var | `roomshare-files` | The bucket's name, used in upload links |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | secrets | (none) | An R2 API token limited to this bucket, used to sign upload links |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` | var / secret | (none) | Switch on the Cloudflare Turnstile bot check. Both are needed |
| `MAX_FILE_BYTES` | var | 2 GiB | Per-file limit. Without the R2 keys it is capped at 100 MB, the free plan's request size |
| `MAX_ROOM_BYTES` / `MAX_TOTAL_BYTES` | var | 4 GiB / 8 GiB | Per-room and whole-site storage caps. 8 GiB stays inside R2's free 10 GB |
| `MAX_ROOMS` | var | 200 | Rooms that may exist at once |
| `MAX_ROOM_FILES`, `MAX_ROOM_USERS` | var | 500, 500 | Per-room caps |
| `MAX_TEXT_CHARS` | var | 100000 | Length of the shared text |
| `EMPTY_ROOM_GRACE_MS` | var | 15000 | How long an empty room survives, so a page refresh does not delete it |
| `ROOM_ATTEMPTS_PER_MINUTE` | var | 30 | Per address. Counts room creation and failed joins |
| `PASSWORD_FAILURES_PER_MINUTE` | var | 20 | Wrong room passwords allowed per room per minute from everyone together |

The page settings (`PUBLIC_URL`, `TURNSTILE_SITE_KEY`, `R2_ACCOUNT_ID`) are built into `dist/`, so they take effect on the next `wrangler dev` or `wrangler deploy`.

## Deploying for free on Cloudflare

### 1. One-time setup in the Cloudflare dashboard

1. Create a free Cloudflare account. Under **Workers & Pages**, pick your `workers.dev` subdomain.
2. Open **R2** and turn it on. Cloudflare asks for a payment card, but the free tier (10 GB stored, 1 million uploads and 10 million reads a month) is charged nothing.
3. Create a bucket named `roomshare-files`.
4. In the bucket's **Settings**:
   - **CORS policy:** allow the page to upload to it:
     ```json
     [{ "AllowedOrigins": ["https://roomshare.<your-subdomain>.workers.dev"], "AllowedMethods": ["PUT"], "AllowedHeaders": ["content-type"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600 }]
     ```
   - **Object lifecycle rules:** add a rule that deletes objects after 1 day and aborts unfinished uploads after 1 day. Rooms clean up after themselves, so this is only a safety net.
5. In **R2 > Manage API tokens**, create a token with **Object Read & Write** on `roomshare-files` only. Keep its access key ID and secret for the next step.
6. Copy your **Account ID** (on the R2 overview page).

### 2. Deploy

```bash
npx wrangler login
```

Put your account ID in `wrangler.jsonc` as `R2_ACCOUNT_ID`, then add the two secrets. Wrangler asks for each value, so it never appears in your shell history:

```bash
npx wrangler secret put R2_ACCESS_KEY_ID
```

```bash
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

```bash
npm run deploy
```

The site is live at `https://roomshare.<your-subdomain>.workers.dev`. Set that address as `PUBLIC_URL` in `wrangler.jsonc` and deploy again so link previews work. Every later change is one `npm run deploy`.

What the free plan gives, and how RoomShare stays inside it:

| Limit | How RoomShare fits |
| --- | --- |
| Workers: 100,000 requests a day, 10 ms of CPU each | Pages and scripts are Static Assets and do not count. File bytes go straight to R2, and downloads only stream |
| Durable Objects: 100,000 requests and 13,000 GB-s a day | Rooms sleep between messages, and pings are answered without waking them |
| Durable Object storage: 100,000 rows written a day | The shared text is saved at most once a second, not on every keystroke |
| R2: 10 GB stored | `MAX_TOTAL_BYTES` stops new uploads at 8 GiB, and rooms delete their files when they close |

Check the current numbers on Cloudflare's pricing pages, and watch **Workers & Pages > roomshare > Metrics** for the first few days.

### Turning on the bot check (optional)

Without it, anyone can create rooms, limited only by the per-address rate limit and `MAX_ROOMS`. To require a free Cloudflare Turnstile check:

1. In the Cloudflare dashboard open **Turnstile**, choose **Add site**, enter your `workers.dev` hostname, and pick the **Managed** widget.
2. Put the **site key** in `wrangler.jsonc` as `TURNSTILE_SITE_KEY`, add the secret with `npx wrangler secret put TURNSTILE_SECRET`, and deploy.

When it is on, the page loads Cloudflare's script and a small widget appears above the Create button. Each new room needs a fresh pass, and joining an existing room does not. If Cloudflare cannot be reached, new rooms are refused rather than let through. The secret is only ever read by the Worker.

To try it locally without an account, use Cloudflare's published test keys: site key `1x00000000000000000000AA` and secret `1x0000000000000000000000000000000AA` always pass, and the secret `2x0000000000000000000000000000000AA` always fails. Put local secrets in a `.dev.vars` file, which is never committed.

### Link previews and installing

- Previews are built from `PUBLIC_URL`. Chat apps cache a preview for a while, so changes to it can take time to show up.
- Room links ask search engines not to index them.
- "Install" and "Add to Home Screen" need HTTPS, which `workers.dev` provides. Chrome and Edge show an install button on the home screen. On iPhones the button explains Share > Add to Home Screen.

## Security and limits

- **Not end-to-end encrypted.** The room relays the text, and R2 holds the files while a room is open. Cloudflare encrypts them at rest, but the service can read them. Use HTTPS, and do not use it for sensitive material unless you add client-side encryption.
- **Anyone with the room ID can join, unless the room has a password.** IDs have about 40 bits of randomness, and creating rooms or failing to join is rate limited per address. A room password is checked by the room and kept only as a salted scrypt hash. It controls who can enter, and it does not encrypt anything: the server still sees the text and files. The invite link and QR code do not contain the password, so share it separately.
- **Files are always served as downloads,** never displayed by the browser, and the page's content security policy blocks anything but its own scripts and styles.
- **A public anonymous file host can attract misuse.** Files are not scanned. Keep the size limits modest if you open it to everyone.
- **Rooms are temporary on purpose.** A room ends 15 seconds after its last person leaves, and the shared text is limited to 100,000 characters. A deploy does not end open rooms.

## License

MIT. See [LICENSE](LICENSE). The bundled QR encoder in `public/vendor/qrcode.js` is [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase, also MIT. "QR Code" is a registered trademark of Denso Wave Incorporated. The PDF reader in `public/vendor/pdfjs/` is [PDF.js](https://github.com/mozilla/pdf.js) by Mozilla, under the Apache License 2.0 (its text is in that folder).
