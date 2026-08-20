// Enclave Chat — ephemeral, end-to-end encrypted, link-based chat relay.
//
// IMPORTANT DESIGN NOTE:
// This server NEVER sees plaintext and NEVER sees the encryption key.
// The key lives only in the URL fragment (after '#'), which browsers
// never transmit over the network. The server only ever handles:
//   - opaque ciphertext blobs (chat messages)
//   - opaque encrypted file bytes (images/videos)
//   - room lifecycle signals (join / delete / room-deleted)
// It is a "blind relay" + temporary encrypted-blob store.

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const UPLOAD_ROOT = path.join(__dirname, 'public', 'uploads');
const ROOM_TTL_MS = 1000 * 60 * 60 * 24; // rooms auto-expire after 24h of inactivity
const MAX_FILE_BYTES = 200 * 1024 * 1024; // 200MB cap per encrypted file

if (!fs.existsSync(UPLOAD_ROOT)) fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// --- In-memory room registry ---------------------------------------------
// rooms: Map<roomId, { sockets: Set<ws>, lastActivity: number, fileIds: Set<string> }>
const rooms = new Map();

function touchRoom(roomId) {
  const room = rooms.get(roomId);
  if (room) room.lastActivity = Date.now();
}

function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = { sockets: new Set(), lastActivity: Date.now(), fileIds: new Set() };
    rooms.set(roomId, room);
  }
  return room;
}

function destroyRoom(roomId, notify = true) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (notify) {
    for (const sock of room.sockets) {
      try {
        sock.send(JSON.stringify({ type: 'room-deleted' }));
        sock.close();
      } catch (_) {}
    }
  }
  rooms.delete(roomId);

  // wipe any uploaded encrypted files for this room
  const dir = path.join(UPLOAD_ROOT, roomId);
  fs.rm(dir, { recursive: true, force: true }, () => {});
}

// Sweep expired/empty rooms periodically
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    if (now - room.lastActivity > ROOM_TTL_MS) {
      destroyRoom(roomId, true);
    }
  }
}, 60 * 1000);

// --- Multer storage: writes encrypted (opaque) bytes to disk -------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const roomId = req.params.roomId;
    const dir = path.join(UPLOAD_ROOT, roomId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, req.params.fileId);
  }
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_BYTES } });

// Upload an encrypted blob (image/video/any file) for a room.
// Body is opaque ciphertext — server has no idea what it is.
app.post('/upload/:roomId/:fileId', (req, res) => {
  const { roomId } = req.params;
  if (!rooms.has(roomId)) return res.status(404).json({ error: 'room not found' });
  upload.single('blob')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const room = rooms.get(roomId);
    room.fileIds.add(req.params.fileId);
    touchRoom(roomId);
    res.json({ ok: true });
  });
});

// Download an encrypted blob. Still opaque ciphertext to anyone without the key.
app.get('/download/:roomId/:fileId', (req, res) => {
  const { roomId, fileId } = req.params;
  const filePath = path.join(UPLOAD_ROOT, roomId, fileId);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

// --- HTTP + WebSocket server ---------------------------------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('room');
  if (!roomId) {
    ws.close(4000, 'missing room');
    return;
  }

  const room = getOrCreateRoom(roomId);
  room.sockets.add(ws);
  touchRoom(roomId);

  // Tell everyone currently in the room how many participants there are
  broadcastPresence(roomId);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }

    touchRoom(roomId);

    if (msg.type === 'delete-room') {
      // Only relay this signal; the sender already wiped their own local UI.
      destroyRoom(roomId, true);
      return;
    }

    // Everything else (type: 'cipher') is opaque ciphertext — just relay
    // it verbatim to every other participant in the room.
    if (msg.type === 'cipher') {
      for (const sock of room.sockets) {
        if (sock !== ws && sock.readyState === WebSocket.OPEN) {
          sock.send(JSON.stringify(msg));
        }
      }
    }
  });

  ws.on('close', () => {
    const r = rooms.get(roomId);
    if (!r) return;
    r.sockets.delete(ws);
    broadcastPresence(roomId);
    // If nobody is left, keep the room (and any uploaded files) alive
    // until ROOM_TTL_MS expires, so a brief disconnect / phone lock
    // doesn't nuke the conversation. It'll be swept later if unused.
  });
});

function broadcastPresence(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const count = room.sockets.size;
  for (const sock of room.sockets) {
    if (sock.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify({ type: 'presence', count }));
    }
  }
}

// Explicit REST endpoint too, in case a client's socket is already gone
// when they hit "delete" (e.g. they background the tab right after).
app.post('/api/rooms/:roomId/delete', (req, res) => {
  destroyRoom(req.params.roomId, true);
  res.json({ ok: true });
});

server.listen(PORT, () => {
  console.log(`Enclave Chat listening on http://localhost:${PORT}`);
});
