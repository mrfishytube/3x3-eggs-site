const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '733831869974-7bk289e7hdhu8uf6sjvcgl3db4h0o3gg.apps.googleusercontent.com';
const ADMIN_EMAIL = 'mr.fish.ytube@gmail.com'.toLowerCase();
const MAX_PLAYERS_PER_ROOM = 7;

// ============================================================
// LOKALE DATABASE VOOR GOOGLE ACCOUNTS & ITEMS
// ============================================================
const DB_FILE = path.join(__dirname, 'accounts.json');
let db = { users: {}, sessions: {} };

if (fs.existsSync(DB_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!db.users) db.users = {};
    if (!db.sessions) db.sessions = {};
  } catch (e) {
    db = { users: {}, sessions: {} };
  }
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(obj));
}

function getAuthUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const uid = db.sessions[token];
  if (!uid || !db.users[uid]) return null;
  return db.users[uid];
}

function isAdmin(user) {
  return Boolean(user && user.email && user.email.toLowerCase() === ADMIN_EMAIL);
}

// ============================================================
// LIVE SITE-EVENTS (GIFTS & ADMIN MELDINGEN)
// ============================================================
const siteEventClients = new Set();

function broadcastSiteEvent(payload) {
  const data = JSON.stringify(payload);
  for (const ws of siteEventClients) {
    if (ws.readyState === 1) {
      ws.send(data);
    }
  }
}

// ============================================================
// CUSTOM MULTIPLAYER KAMERS PER KANAAL (/server1, /server2, /vip)
// ============================================================
const channels = new Map();

function generateCode() {
  const words = ['custom', 'ei', 'zon', 'ster', 'wolk', 'bloem', 'vlam'];
  const word = words[Math.floor(Math.random() * words.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${word}${num}`;
}

function getChannel(channelName) {
  if (!channels.has(channelName)) {
    channels.set(channelName, new Map());
  }
  return channels.get(channelName);
}

function findOrCreatePublicRoom(channelName) {
  const rooms = getChannel(channelName);
  for (const room of rooms.values()) {
    if (!room.isPrivate && room.clients.size < MAX_PLAYERS_PER_ROOM) {
      return room;
    }
  }
  const code = generateCode();
  const room = { code, isPrivate: false, clients: new Map() };
  rooms.set(code, room);
  return room;
}

function createPrivateRoom(channelName) {
  const rooms = getChannel(channelName);
  const code = generateCode();
  const room = { code, isPrivate: true, clients: new Map() };
  rooms.set(code, room);
  return room;
}

function broadcastRoom(room, payload, excludeId = null) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const [id, client] of room.clients.entries()) {
    if (id !== excludeId && client.ws.readyState === 1) {
      client.ws.send(data);
    }
  }
}

// ============================================================
// HTTP SERVER (Website + Google Auth + Admin API)
// ============================================================
const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  // 1. Website serveren
  if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
    const filePath = path.join(__dirname, 'index.html');
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(filePath, 'utf8'));
      return;
    }
  }

  // 2. Server status
  if (req.method === 'GET' && urlPath === '/api/health') {
    const stats = {};
    for (const [ch, rooms] of channels.entries()) {
      let online = 0;
      for (const r of rooms.values()) online += r.clients.size;
      stats[ch] = { rooms: rooms.size, online };
    }
    sendJson(res, 200, {
      ok: true,
      status: 'Custom 3x3 Eggs Server actief',
      usersCount: Object.keys(db.users).length,
      channels: stats
    });
    return;
  }

  // 3. Account aanmaken / inloggen met Google
  if (req.method === 'POST' && urlPath === '/api/auth/google') {
    try {
      const body = await readJsonBody(req);
      const credential = body.credential;
      if (!credential) {
        sendJson(res, 400, { ok: false, error: 'Geen Google token ontvangen' });
        return;
      }

      const verifyUrl = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential);
      const verifyRes = await httpsGetJson(verifyUrl);

      if (verifyRes.status !== 200 || !verifyRes.data || !verifyRes.data.sub) {
        sendJson(res, 401, { ok: false, error: 'Ongeldig Google token' });
        return;
      }

      const payload = verifyRes.data;
      if (GOOGLE_CLIENT_ID && payload.aud !== GOOGLE_CLIENT_ID) {
        sendJson(res, 401, { ok: false, error: 'Google Client ID komt niet overeen' });
        return;
      }

      const uid = payload.sub;
      const email = (payload.email || '').toLowerCase();
      const now = new Date().toISOString();
      const adminFlag = email === ADMIN_EMAIL;

      if (!db.users[uid]) {
        db.users[uid] = {
          id: uid,
          name: payload.name || 'Speler',
          email: payload.email || '',
          picture: payload.picture || '',
          role: adminFlag ? 'admin' : 'player',
          diamonds: 0,
          coins: 0,
          speed: 0,
          items: [],
          createdAt: now,
          lastLogin: now
        };
      } else {
        db.users[uid].name = payload.name || db.users[uid].name;
        db.users[uid].picture = payload.picture || db.users[uid].picture;
        db.users[uid].email = payload.email || db.users[uid].email;
        if (adminFlag) db.users[uid].role = 'admin';
        if (typeof db.users[uid].diamonds !== 'number') db.users[uid].diamonds = 0;
        if (typeof db.users[uid].coins !== 'number') db.users[uid].coins = 0;
        if (typeof db.users[uid].speed !== 'number') db.users[uid].speed = 0;
        if (!Array.isArray(db.users[uid].items)) db.users[uid].items = [];
        db.users[uid].lastLogin = now;
      }

      const sessionToken = crypto.randomBytes(24).toString('hex');
      db.sessions[sessionToken] = uid;
      saveDB();

      sendJson(res, 200, {
        ok: true,
        token: sessionToken,
        user: db.users[uid],
        isAdmin: adminFlag
      });
    } catch (err) {
      console.error('Google Auth fout:', err);
      sendJson(res, 500, { ok: false, error: 'Serverfout bij Google login' });
    }
    return;
  }

  // 4. Huidige gebruiker ophalen
  if (req.method === 'GET' && urlPath === '/api/me') {
    const user = getAuthUser(req);
    if (!user) {
      sendJson(res, 401, { ok: false, error: 'Niet ingelogd' });
      return;
    }
    sendJson(res, 200, { ok: true, user, isAdmin: isAdmin(user) });
    return;
  }

  // 5. ADMIN: Alle spelers ophalen (alleen voor mr.fish.ytube@gmail.com)
  if (req.method === 'GET' && urlPath === '/api/admin/users') {
    const admin = getAuthUser(req);
    if (!isAdmin(admin)) {
      sendJson(res, 403, { ok: false, error: 'Geen admin rechten' });
      return;
    }
    const users = Object.values(db.users).map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      diamonds: u.diamonds || 0,
      coins: u.coins || 0,
      speed: u.speed || 0,
      items: u.items || []
    }));
    sendJson(res, 200, { ok: true, users });
    return;
  }

  // 6. ADMIN: Spullen, valuta of rang geven aan jezelf of anderen
  if (req.method === 'POST' && urlPath === '/api/admin/give') {
    const admin = getAuthUser(req);
    if (!isAdmin(admin)) {
      sendJson(res, 403, { ok: false, error: 'Geen admin rechten' });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const { targetId, diamonds = 0, coins = 0, speed = 0, role = '', item = '' } = body;

      const dAmt = parseInt(diamonds, 10) || 0;
      const cAmt = parseInt(coins, 10) || 0;
      const sAmt = parseInt(speed, 10) || 0;
      const cleanItem = typeof item === 'string' ? item.trim().slice(0, 60) : '';
      const validRoles = ['player', 'vip', 'mod', 'admin'];
      const cleanRole = validRoles.includes(role) ? role : '';

      const targets = targetId === 'ALL'
        ? Object.values(db.users)
        : (db.users[targetId] ? [db.users[targetId]] : []);

      if (targets.length === 0) {
        sendJson(res, 404, { ok: false, error: 'Speler niet gevonden' });
        return;
      }

      const parts = [];
      if (dAmt) parts.push(`${dAmt > 0 ? '+' : ''}${dAmt} 💎`);
      if (cAmt) parts.push(`${cAmt > 0 ? '+' : ''}${cAmt} 🪙`);
      if (sAmt) parts.push(`${sAmt > 0 ? '+' : ''}${sAmt} ⚡`);
      if (cleanItem) parts.push(cleanItem);
      if (cleanRole) parts.push(`Rang: ${cleanRole.toUpperCase()}`);

      for (const u of targets) {
        u.diamonds = Math.max(0, (u.diamonds || 0) + dAmt);
        u.coins = Math.max(0, (u.coins || 0) + cAmt);
        u.speed = Math.max(0, (u.speed || 0) + sAmt);
        if (cleanItem) {
          if (!Array.isArray(u.items)) u.items = [];
          u.items.push(cleanItem);
        }
        if (cleanRole) {
          // Admin-account behoudt altijd admin-rechten
          u.role = (u.email || '').toLowerCase() === ADMIN_EMAIL ? 'admin' : cleanRole;
        }
      }

      saveDB();

      const summary = parts.join(', ') || 'Update';
      broadcastSiteEvent({
        type: 'gift',
        targetId: targetId === 'ALL' ? 'ALL' : targets[0].id,
        from: admin.name,
        summary
      });

      sendJson(res, 200, { ok: true, count: targets.length, summary });
    } catch (err) {
      console.error('Admin give fout:', err);
      sendJson(res, 500, { ok: false, error: 'Serverfout bij geven' });
    }
    return;
  }

  // 7. ADMIN: Live melding sturen naar alle spelers op de site
  if (req.method === 'POST' && urlPath === '/api/admin/announce') {
    const admin = getAuthUser(req);
    if (!isAdmin(admin)) {
      sendJson(res, 403, { ok: false, error: 'Geen admin rechten' });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const text = String(body.text || '').trim().slice(0, 200);
      if (!text) {
        sendJson(res, 400, { ok: false, error: 'Bericht is leeg' });
        return;
      }
      broadcastSiteEvent({ type: 'announcement', from: admin.name, text });
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: 'Fout bij verzenden' });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Niet gevonden' });
});

// ============================================================
// WEBSOCKET SERVER (/site-events + /server1, /server2, /vip)
// ============================================================
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const channelName = (req.url || '/server1').split('?')[0];

  // Apart kanaal voor live website-meldingen en cadeaus
  if (channelName === '/site-events') {
    siteEventClients.add(ws);
    ws.on('close', () => siteEventClients.delete(ws));
    return;
  }

  const playerId = Math.random().toString(36).slice(2, 10);
  let currentRoom = findOrCreatePublicRoom(channelName);
  currentRoom.clients.set(playerId, { ws, state: {} });

  console.log(`[${channelName}] + ${playerId} in kamer ${currentRoom.code} (${currentRoom.clients.size}/${MAX_PLAYERS_PER_ROOM})`);

  ws.on('message', (raw) => {
    const text = raw.toString();
    let msg = null;
    try { msg = JSON.parse(text); } catch (e) {}

    if (msg && (msg.type === 'private' || msg.action === 'private')) {
      currentRoom.clients.delete(playerId);
      currentRoom = createPrivateRoom(channelName);
      currentRoom.clients.set(playerId, { ws, state: {} });
      ws.send(JSON.stringify({ type: 'room', code: currentRoom.code, private: true }));
      return;
    }

    if (msg && (msg.type === 'join' || msg.action === 'join') && msg.code) {
      const rooms = getChannel(channelName);
      const target = rooms.get(String(msg.code).toLowerCase());
      if (target && target.clients.size < MAX_PLAYERS_PER_ROOM) {
        currentRoom.clients.delete(playerId);
        currentRoom = target;
        currentRoom.clients.set(playerId, { ws, state: {} });
        ws.send(JSON.stringify({ type: 'room', code: currentRoom.code }));
      }
      return;
    }

    broadcastRoom(currentRoom, text, playerId);
  });

  ws.on('close', () => {
    currentRoom.clients.delete(playerId);
    console.log(`[${channelName}] - ${playerId} weg uit ${currentRoom.code}`);
    if (currentRoom.clients.size === 0) {
      getChannel(channelName).delete(currentRoom.code);
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Custom 3x3 Eggs server draait op http://localhost:${PORT}`);
  console.log(`👑 Admin account: ${ADMIN_EMAIL}`);
});
