# Enclave Chat

A self-hosted, link-based, end-to-end encrypted, ephemeral chat with image/video sharing.

## How it works

- Open the app → it generates a random room ID and a random AES-256 encryption
  key, and shows you a link like:
  `https://yourapp.com/#roomId.keyBase64`
- Send that link to whoever you want to chat with (text, Signal, email — the
  transport doesn't matter, the link itself is the secret).
- The part after `#` is a **URL fragment**. Browsers never send fragments to
  the server — so **the server never sees the key, and never sees plaintext**.
  It only ever relays and stores ciphertext it can't read.
- Messages are encrypted/decrypted in the browser with WebCrypto (AES-256-GCM)
  before they're sent over the WebSocket relay.
- Images/videos are encrypted client-side before upload, stored as opaque
  encrypted blobs, and decrypted client-side after download.
- Hitting **Delete** wipes the room from the server (messages were never
  stored to begin with — only relayed) and force-closes the chat on both
  ends instantly.
- Rooms also auto-expire after 24 hours of inactivity as a backstop.

## Honest limitations

- **You must host this somewhere** to get a link that works for someone else —
  see deployment below. Running it only on your own laptop means only your
  laptop can serve the link.
- **No persistence, on purpose.** If either of you refreshes the page before
  deleting, that person's message history is gone (the server never stored
  it). Uploaded files persist until the room is deleted or expires.
- **Metadata isn't hidden.** The server can see ciphertext size/timing and
  that two people connected to the same room — it just can't read content.
  For serious threat models (e.g. hiding *that* you're communicating), this
  isn't the right tool.
- **HTTPS is required** in production — browsers only allow the WebCrypto API
  on secure origins (`https://` or `localhost`).
- Whole files are encrypted in memory in the browser before upload, so very
  large videos (multi-GB) may be limited by device memory. 200MB per file is
  enforced server-side by default (`MAX_FILE_BYTES` in `server.js`).

## Run it locally (testing only — link only works on your machine)

```bash
npm install
npm start
# open http://localhost:3000
```

## Deploy it for real (so the link works for anyone, on any phone)

Pick any Node.js host. Two easy options:

### Option A — Railway / Render (free tier, easiest)
1. Push this folder to a new GitHub repo.
2. On [railway.app](https://railway.app) or [render.com](https://render.com),
   create a new "Web Service" from that repo.
3. Build command: `npm install` — Start command: `npm start`.
4. It'll auto-detect the `PORT` env var (already wired up in `server.js`).
5. You'll get a `https://your-app.up.railway.app` URL — that's your base link.

### Option B — Your own VPS
```bash
git clone <your-repo>
cd enclave-chat
npm install
npm install -g pm2
pm2 start server.js --name enclave-chat
```
Put it behind Nginx/Caddy with a free Let's Encrypt certificate so it's
served over `https://` (required for WebCrypto). Caddy makes this a
one-liner:
```
yourdomain.com {
  reverse_proxy localhost:3000
}
```

Once deployed, opening `https://yourdomain.com/` on your phone and creating
a chat gives you a link you can text to anyone — they open it in their
mobile browser, no app install needed.

## File layout

```
server.js        Express + WebSocket relay + encrypted file storage
public/index.html  Single-page UI (share screen + chat screen)
public/app.js       Client logic: WS handling, UI, upload/download
public/crypto.js    WebCrypto helpers (AES-256-GCM)
public/style.css    Mobile-responsive styling
```
