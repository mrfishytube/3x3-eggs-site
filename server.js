const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '733831869974-7bk289e7hdhu8uf6sjvcgl3db4h0o3gg.apps.googleusercontent.com';
const ADMIN_EMAIL = 'mr.fish.ytube@gmail.com'.toLowerCase();
const AUTO_VERIFY_DOMAIN = '@ll.flevion.nl';
const TOKEN_SECRET = process.env.SESSION_SECRET || '3x3_eggs_3d_custom_secret_2026_v9';
const MAX_PLAYERS_PER_ROOM = 7;

// ============================================================
// BIG-NUMBER HELPERS
// ============================================================
function toBig(val) {
  const cleaned = String(val ?? '0').replace(/[^0-9-]/g, '').trim();
  if (!cleaned || cleaned === '-') return 0n;
  try { return BigInt(cleaned); } catch (e) { return 0n; }
}

function addClampedBig(currentVal, deltaVal) {
  const sum = toBig(currentVal) + toBig(deltaVal);
  return (sum < 0n ? 0n : sum).toString();
}

function formatBig(val) {
  const str = toBig(val).toString();
  const neg = str.startsWith('-');
  const digits = neg ? str.slice(1) : str;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (neg ? '-' : '') + grouped;
}

// Veilige conversie naar JS Number voor de 3D game JSON (die geen BigInt in JSON kan parsen)
function addToGameNumber(currentVal, deltaBig) {
  const curBig = toBig(Math.floor(Number(currentVal) || 0));
  const nextBig = curBig + deltaBig;
  const clamped = nextBig < 0n ? 0n : nextBig;
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(clamped > maxSafe ? maxSafe : clamped);
}

// ============================================================
// DATABASE: ACCOUNTS + CUSTOM 3D GAME PROGRESS DATA
// ============================================================
const DB_FILE = path.join(__dirname, 'custom-3d-data.json');
let db = {
  users: {},
  gameProfiles: {}, // key = 3D game player id -> { id, channel, data, rawBody, updatedAt, adminLockUntil }
  recentLogs: []
};

if (fs.existsSync(DB_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.users = loaded.users || {};
    db.gameProfiles = loaded.gameProfiles || {};
    db.recentLogs = Array.isArray(loaded.recentLogs) ? loaded.recentLogs : [];
  } catch (e) {
    console.error('Kon custom-3d-data.json niet laden:', e.message);
  }
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('Kon database niet opslaan:', e.message);
  }
}

function addLog(msg) {
  const entry = `[${new Date().toLocaleTimeString('nl-NL')}] ${msg}`;
  db.recentLogs.unshift(entry);
  if (db.recentLogs.length > 30) db.recentLogs.length = 30;
  console.log(entry);
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update('eggs_salt_v9_' + pw).digest('hex');
}

function findUserByEmail(email) {
  const lower = String(email || '').trim().toLowerCase();
  return Object.values(db.users).find((u) => (u.email || '').toLowerCase() === lower) || null;
}

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    picture: u.picture || '',
    role: (u.email || '').toLowerCase() === ADMIN_EMAIL ? 'admin' : (u.role || 'player'),
    verified: Boolean(u.verified),
    diamonds: toBig(u.diamonds || '0').toString(),
    coins: toBig(u.coins || '0').toString(),
    speed: toBig(u.speed || '0').toString(),
    items: Array.isArray(u.items) ? u.items : []
  };
}

// ============================================================
// STATELESS HMAC TOKENS (overleven Render herstarts -> geen 'Geen admin rechten' meer)
// ============================================================
function createToken(user) {
  const payload = Buffer.from(JSON.stringify({
    id: user.id,
    email: user.email,
    name: user.name,
    role: (user.email || '').toLowerCase() === ADMIN_EMAIL ? 'admin' : (user.role || 'player'),
    iat: Date.now()
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  if (sig !== expected) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
}

function getAuthUser(req) {
  const headers = (req && req.headers) ? req.headers : {};
  const authHeader = headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const data = verifyToken(token);
  if (!data || !data.id) return null;

  let user = db.users[data.id] || (data.email ? findUserByEmail(data.email) : null);
  if (!user) {
    const email = (data.email || '').toLowerCase();
    user = {
      id: data.id,
      name: data.name || (email ? email.split('@')[0] : 'Speler'),
      email,
      picture: '',
      role: email === ADMIN_EMAIL ? 'admin' : (data.role || 'player'),
      verified: true,
      diamonds: '0',
      coins: '0',
      speed: '0',
      items: [],
      createdAt: new Date().toISOString(),
      lastLogin: new Date().toISOString()
    };
    db.users[user.id] = user;
    saveDB();
  }
  return user;
}

function isAdmin(user) {
  if (!user) return false;
  return (user.email || '').toLowerCase() === ADMIN_EMAIL || user.role === 'admin';
}

// ============================================================
// SLIMME 3D PROGRESS-DATA PATCHER
// Past direct de echte JSON-velden aan die de 3D-game via /progress gebruikt!
// ============================================================
function patchNestedObject(obj, { cBig, dBig, sBig, role, item }) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  let touched = false;

  const coinKeys = ['coins', 'coin', 'money', 'cash', 'gold', 'munten', 'balance'];
  const gemKeys = ['gems', 'gem', 'diamonds', 'diamond', 'diamanten', 'rubies'];
  const speedKeys = ['speed', 'snelheid', 'walkSpeed', 'moveSpeed', 'power', 'strength'];
  const trailArrKeys = ['trails', 'unlockedTrails', 'ownedTrails'];
  const activeTrailKeys = ['equippedTrail', 'activeTrail', 'currentTrail', 'trail'];
  const treadArrKeys = ['treadmills', 'unlockedTreadmills', 'ownedTreadmills'];
  const activeTreadKeys = ['equippedTreadmill', 'activeTreadmill', 'treadmill', 'treadmillLevel'];
  const rankKeys = ['rank', 'role', 'title', 'badge', 'tag'];

  const keys = Object.keys(obj);

  // Munten
  if (cBig !== 0n) {
    let found = false;
    for (const k of keys) {
      if (coinKeys.includes(k.toLowerCase()) && (typeof obj[k] === 'number' || typeof obj[k] === 'string')) {
        obj[k] = addToGameNumber(obj[k], cBig);
        found = true;
        touched = true;
      }
    }
    if (!found && obj._isRootProgress) {
      obj.coins = addToGameNumber(obj.coins || 0, cBig);
      touched = true;
    }
  }

  // Diamanten / Gems
  if (dBig !== 0n) {
    let found = false;
    for (const k of keys) {
      if (gemKeys.includes(k.toLowerCase()) && (typeof obj[k] === 'number' || typeof obj[k] === 'string')) {
        obj[k] = addToGameNumber(obj[k], dBig);
        found = true;
        touched = true;
      }
    }
    if (!found && obj._isRootProgress) {
      obj.gems = addToGameNumber(obj.gems || 0, dBig);
      touched = true;
    }
  }

  // Snelheid
  if (sBig !== 0n) {
    let found = false;
    for (const k of keys) {
      if (speedKeys.includes(k.toLowerCase()) && (typeof obj[k] === 'number' || typeof obj[k] === 'string')) {
        obj[k] = addToGameNumber(obj[k], sBig);
        found = true;
        touched = true;
      }
    }
    if (!found && obj._isRootProgress) {
      obj.speed = addToGameNumber(obj.speed || 0, sBig);
      touched = true;
    }
  }

  // Trails
  if (item && item.toLowerCase().includes('trail')) {
    const trailId = item.toLowerCase().includes('admin') ? 'admin' : 'speed';
    for (const k of keys) {
      if (trailArrKeys.includes(k.toLowerCase()) && Array.isArray(obj[k])) {
        if (!obj[k].includes(trailId)) obj[k].push(trailId);
        if (!obj[k].includes(item)) obj[k].push(item);
        touched = true;
      }
      if (activeTrailKeys.includes(k.toLowerCase())) {
        obj[k] = trailId;
        touched = true;
      }
    }
    if (!touched && obj._isRootProgress) {
      obj.unlockedTrails = Array.isArray(obj.unlockedTrails) ? obj.unlockedTrails : [];
      if (!obj.unlockedTrails.includes(trailId)) obj.unlockedTrails.push(trailId);
      obj.equippedTrail = trailId;
      touched = true;
    }
  }

  // Admin Treadmill
  if (item && item.toLowerCase().includes('treadmill')) {
    for (const k of keys) {
      if (treadArrKeys.includes(k.toLowerCase()) && Array.isArray(obj[k])) {
        if (!obj[k].includes('admin')) obj[k].push('admin');
        if (!obj[k].includes('admin_treadmill')) obj[k].push('admin_treadmill');
        touched = true;
      }
      if (activeTreadKeys.includes(k.toLowerCase())) {
        obj[k] = typeof obj[k] === 'number' ? Math.max(obj[k], 99) : 'admin';
        touched = true;
      }
    }
    if (!touched && obj._isRootProgress) {
      obj.unlockedTreadmills = Array.isArray(obj.unlockedTreadmills) ? obj.unlockedTreadmills : [];
      if (!obj.unlockedTreadmills.includes('admin')) obj.unlockedTreadmills.push('admin');
      obj.equippedTreadmill = 'admin';
      touched = true;
    }
  }

  // Rang / Admin
  if (role) {
    for (const k of keys) {
      if (rankKeys.includes(k.toLowerCase())) {
        obj[k] = role;
        touched = true;
      }
      if (k.toLowerCase() === 'isadmin' || k.toLowerCase() === 'admin') {
        obj[k] = role === 'admin';
        touched = true;
      }
    }
    if (obj._isRootProgress) {
      obj.rank = role;
      obj.isAdmin = role === 'admin';
      touched = true;
    }
  }

  // Loop ook door geneste objecten (bijv. data / progress / state / player / stats)
  for (const k of keys) {
    if (k.startsWith('_')) continue;
    const val = obj[k];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      if (patchNestedObject(val, { cBig, dBig, sBig, role, item })) {
        touched = true;
      }
    }
  }

  return touched;
}

function applyAdminPatchTo3DProfile(profile, patch) {
  if (!profile.data || typeof profile.data !== 'object') {
    profile.data = {};
  }
  const targetObj = (profile.data.progress && typeof profile.data.progress === 'object')
    ? profile.data.progress
    : ((profile.data.data && typeof profile.data.data === 'object') ? profile.data.data : profile.data);

  targetObj._isRootProgress = true;
  patchNestedObject(targetObj, patch);
  delete targetObj._isRootProgress;

  profile.updatedAt = Date.now();
  // Voorkom dat de 3D game vlak voor reload onze admin-edit overschrijft met oude data
  profile.adminLockUntil = Date.now() + 8000;
}

// ============================================================
// HTTP HELPERS + CORS (exact origin + credentials: true voor timestables.com)
// ============================================================
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 3e6) req.destroy();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readRawBody(req);
  if (!raw || !raw.trim()) return {};
  try { return JSON.parse(raw); } catch (e) { return { _raw: raw }; }
}

function setCorsHeaders(req, res) {
  const headers = (req && req.headers) ? req.headers : {};
  const origin = headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', headers['access-control-request-headers'] || 'Content-Type, Authorization, X-Requested-With');
}

function sendJson(req, res, status, obj) {
  setCorsHeaders(req, res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ============================================================
// LIVE SITE EVENTS + MULTIPLAYER ROOMS
// ============================================================
const siteEventClients = new Set();
function broadcastSiteEvent(payload) {
  const data = JSON.stringify(payload);
  for (const ws of siteEventClients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

const channels = new Map();
function generateCode() {
  const words = ['custom', 'ei', 'zon', 'ster', 'wolk', 'bloem', 'vlam'];
  return words[Math.floor(Math.random() * words.length)] + Math.floor(1000 + Math.random() * 9000);
}
function getChannel(name) {
  if (!channels.has(name)) channels.set(name, new Map());
  return channels.get(name);
}
function findOrCreatePublicRoom(ch) {
  const rooms = getChannel(ch);
  for (const r of rooms.values()) {
    if (!r.isPrivate && r.clients.size < MAX_PLAYERS_PER_ROOM) return r;
  }
  const code = generateCode();
  const room = { code, isPrivate: false, clients: new Map() };
  rooms.set(code, room);
  return room;
}
function broadcastRoom(room, payload, excludeId = null) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const [id, client] of room.clients.entries()) {
    if (id !== excludeId && client.ws.readyState === 1) client.ws.send(data);
  }
}

// ============================================================
// HTTP SERVER
// ============================================================
const server = http.createServer(async (req, res) => {
  try {
    if (!req || !res) return;
    const rawUrl = req.url || '/';
    const parsedUrl = new URL(rawUrl, 'http://localhost');
    const urlPath = parsedUrl.pathname;

    if (req.method === 'OPTIONS') {
      setCorsHeaders(req, res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
      const filePath = path.join(__dirname, 'index.html');
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(filePath, 'utf8'));
        return;
      }
    }

    if (req.method === 'GET' && urlPath === '/api/health') {
      sendJson(req, res, 200, {
        ok: true,
        usersCount: Object.keys(db.users).length,
        gameProfilesCount: Object.keys(db.gameProfiles).length
      });
      return;
    }

    // ============================================================
    // 3D GAME CUSTOM DATA ENDPOINTS (/server1/progress, /server1/matchmake/...)
    // ============================================================
    const gameMatch = urlPath.match(/^\/(server\d+|vip)\/(progress|matchmake\/.+)$/);
    if (gameMatch) {
      const chName = '/' + gameMatch[1];
      const subPath = gameMatch[2];

      // 1) 3D GAME SAVE & LOAD PROGRESS
      if (subPath === 'progress') {
        const queryId = parsedUrl.searchParams.get('id') || '';

        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
          const body = await readJsonBody(req);
          const pid = String(queryId || body.id || body.playerId || body.userId || 'default').trim();
          const existing = db.gameProfiles[pid];

          if (existing && existing.adminLockUntil && Date.now() < existing.adminLockUntil) {
            addLog(`3D POST /progress (${pid}) genegeerd tijdens Admin-override`);
            sendJson(req, res, 200, existing.data || { ok: true, id: pid });
            return;
          }

          db.gameProfiles[pid] = {
            id: pid,
            channel: chName,
            data: body,
            updatedAt: Date.now(),
            adminLockUntil: 0
          };
          saveDB();
          addLog(`3D Game progress opgeslagen voor ID: ${pid} (keys: ${Object.keys(body).join(', ')})`);
          broadcastSiteEvent({ type: 'profiles_changed', id: pid });
          sendJson(req, res, 200, { ok: true, id: pid, saved: true });
          return;
        }

        // GET /server1/progress?id=...
        const pid = String(queryId || 'default').trim();
        let existing = db.gameProfiles[pid];
        if (!existing) {
          // Registreer deze 3D speler direct zodat de admin hem ziet in het Admin Panel!
          existing = {
            id: pid,
            channel: chName,
            data: {
              id: pid,
              coins: 0,
              gems: 0,
              speed: 0,
              unlockedTrails: [],
              unlockedTreadmills: []
            },
            updatedAt: Date.now(),
            adminLockUntil: 0,
            isNewPlaceholder: true
          };
          db.gameProfiles[pid] = existing;
          saveDB();
          addLog(`Nieuwe 3D Speler gedetecteerd via GET /progress: ${pid}`);
          broadcastSiteEvent({ type: 'profiles_changed', id: pid });
          // Stuur voor gloednieuwe onbewerkte speler leeg object zodat de 3D game schoon start en zijn echte format terug-POST
          sendJson(req, res, 200, {});
          return;
        }

        addLog(`3D Game laadt custom progress voor ID: ${pid}`);
        // Stuur exact het opgeslagen (en door Admin bewerkte!) object terug
        sendJson(req, res, 200, existing.isNewPlaceholder ? {} : existing.data);
        return;
      }

      // 2) 3D GAME MATCHMAKING (/server1/matchmake/joinOrCreate/egg_room)
      if (subPath.startsWith('matchmake/')) {
        const room = findOrCreatePublicRoom(chName);
        const sessionId = crypto.randomBytes(8).toString('hex');
        const roomName = subPath.split('/').pop() || 'egg_room';
        addLog(`3D Game matchmake (${subPath}) -> kamer ${room.code}`);
        sendJson(req, res, 200, {
          room: {
            clients: room.clients.size,
            createdAt: new Date().toISOString(),
            maxClients: MAX_PLAYERS_PER_ROOM,
            name: roomName,
            processId: 'custom-node',
            roomId: room.code
          },
          sessionId
        });
        return;
      }
    }

    // ============================================================
    // AUTH ENDPOINTS (Custom Email + @ll.flevion.nl skip + Google)
    // ============================================================
    if (req.method === 'POST' && urlPath === '/api/auth/register') {
      const body = await readJsonBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const name = String(body.name || '').trim() || email.split('@')[0];

      if (!email || !email.includes('@')) {
        sendJson(req, res, 400, { ok: false, error: 'Vul een geldig e-mailadres in.' });
        return;
      }
      if (password.length < 4) {
        sendJson(req, res, 400, { ok: false, error: 'Wachtwoord moet minstens 4 tekens zijn.' });
        return;
      }
      if (findUserByEmail(email)) {
        sendJson(req, res, 409, { ok: false, error: 'Dit e-mailadres bestaat al. Klik op Inloggen!' });
        return;
      }

      const isAdminEmail = email === ADMIN_EMAIL;
      const skipVerify = email.endsWith(AUTO_VERIFY_DOMAIN) || isAdminEmail;
      const verifyCode = skipVerify ? null : String(Math.floor(100000 + Math.random() * 900000));
      const uid = 'u_' + crypto.randomBytes(8).toString('hex');
      const now = new Date().toISOString();

      db.users[uid] = {
        id: uid,
        name,
        email,
        passwordHash: hashPassword(password),
        picture: '',
        role: isAdminEmail ? 'admin' : 'player',
        verified: skipVerify,
        verifyCode,
        diamonds: '0',
        coins: '0',
        speed: '0',
        items: [],
        createdAt: now,
        lastLogin: now
      };
      saveDB();

      if (skipVerify) {
        const token = createToken(db.users[uid]);
        sendJson(req, res, 200, { ok: true, token, user: publicUser(db.users[uid]) });
      } else {
        sendJson(req, res, 200, {
          ok: true,
          needsVerification: true,
          message: `Verificatiecode voor ${email}: ${verifyCode} (voor @ll.flevion.nl is geen code nodig)`
        });
      }
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/auth/verify') {
      const body = await readJsonBody(req);
      const user = findUserByEmail(body.email);
      if (!user) {
        sendJson(req, res, 404, { ok: false, error: 'Account niet gevonden.' });
        return;
      }
      if (String(body.code || '').trim() !== String(user.verifyCode)) {
        sendJson(req, res, 400, { ok: false, error: 'Verificatiecode klopt niet.' });
        return;
      }
      user.verified = true;
      user.verifyCode = null;
      saveDB();
      sendJson(req, res, 200, { ok: true, token: createToken(user), user: publicUser(user) });
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/auth/login') {
      const body = await readJsonBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const user = findUserByEmail(email);

      if (!user || user.passwordHash !== hashPassword(password)) {
        sendJson(req, res, 401, { ok: false, error: 'Onjuist e-mailadres of wachtwoord.' });
        return;
      }
      if (!user.verified && !email.endsWith(AUTO_VERIFY_DOMAIN) && email !== ADMIN_EMAIL) {
        sendJson(req, res, 403, {
          ok: false,
          needsVerification: true,
          message: `Account nog niet geverifieerd. Code: ${user.verifyCode}`
        });
        return;
      }
      user.lastLogin = new Date().toISOString();
      if (email === ADMIN_EMAIL) user.role = 'admin';
      saveDB();
      sendJson(req, res, 200, { ok: true, token: createToken(user), user: publicUser(user) });
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/auth/google') {
      const body = await readJsonBody(req);
      if (!body.credential) {
        sendJson(req, res, 400, { ok: false, error: 'Geen Google token ontvangen.' });
        return;
      }
      const verifyRes = await httpsGetJson('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(body.credential));
      if (verifyRes.status !== 200 || !verifyRes.data || !verifyRes.data.sub) {
        sendJson(req, res, 401, { ok: false, error: 'Ongeldig Google token.' });
        return;
      }
      const payload = verifyRes.data;
      if (GOOGLE_CLIENT_ID && payload.aud !== GOOGLE_CLIENT_ID) {
        sendJson(req, res, 401, { ok: false, error: 'Google Client ID komt niet overeen.' });
        return;
      }

      const email = (payload.email || '').toLowerCase();
      let user = findUserByEmail(email) || db.users[payload.sub];
      const now = new Date().toISOString();

      if (!user) {
        user = {
          id: payload.sub,
          name: payload.name || 'Speler',
          email: payload.email || '',
          picture: payload.picture || '',
          role: email === ADMIN_EMAIL ? 'admin' : 'player',
          verified: true,
          diamonds: '0',
          coins: '0',
          speed: '0',
          items: [],
          createdAt: now,
          lastLogin: now
        };
        db.users[user.id] = user;
      } else {
        user.name = payload.name || user.name;
        user.picture = payload.picture || user.picture;
        user.verified = true;
        if (email === ADMIN_EMAIL) user.role = 'admin';
        user.lastLogin = now;
      }
      saveDB();
      sendJson(req, res, 200, { ok: true, token: createToken(user), user: publicUser(user) });
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/me') {
      const user = getAuthUser(req);
      if (!user) {
        sendJson(req, res, 401, { ok: false, error: 'Niet ingelogd.' });
        return;
      }
      sendJson(req, res, 200, { ok: true, user: publicUser(user) });
      return;
    }

    // ============================================================
    // ADMIN ENDPOINTS (beheren ZOWEL website-accounts ALS live 3D game progress!)
    // ============================================================
    if (req.method === 'GET' && urlPath === '/api/admin/state') {
      const admin = getAuthUser(req);
      if (!isAdmin(admin)) {
        sendJson(req, res, 403, { ok: false, error: 'Geen admin rechten.' });
        return;
      }
      sendJson(req, res, 200, {
        ok: true,
        users: Object.values(db.users).map(publicUser),
        gameProfiles: Object.values(db.gameProfiles).map((p) => ({
          id: p.id,
          channel: p.channel,
          updatedAt: p.updatedAt,
          data: p.data
        })),
        logs: db.recentLogs
      });
      return;
    }

    // ADMIN: GEEF MUNTEN / GEMS / SNELHEID / TRAILS / TREADMILL / RANK
    if (req.method === 'POST' && urlPath === '/api/admin/give') {
      const admin = getAuthUser(req);
      if (!isAdmin(admin)) {
        sendJson(req, res, 403, { ok: false, error: 'Geen admin rechten.' });
        return;
      }
      const body = await readJsonBody(req);
      const { targetType = '3D', targetId = 'ALL', diamonds = '0', coins = '0', speed = '0', role = '', item = '' } = body;
      const dBig = toBig(diamonds);
      const cBig = toBig(coins);
      const sBig = toBig(speed);
      const cleanItem = typeof item === 'string' ? item.trim().slice(0, 60) : '';
      const cleanRole = ['player', 'vip', 'mod', 'admin'].includes(role) ? role : '';

      const parts = [];
      if (cBig !== 0n) parts.push(`${cBig > 0n ? '+' : ''}${formatBig(cBig)} 🪙`);
      if (dBig !== 0n) parts.push(`${dBig > 0n ? '+' : ''}${formatBig(dBig)} 💎`);
      if (sBig !== 0n) parts.push(`${sBig > 0n ? '+' : ''}${formatBig(sBig)} ⚡`);
      if (cleanItem) parts.push(cleanItem);
      if (cleanRole) parts.push(`Rang: ${cleanRole.toUpperCase()}`);

      let updated3DCount = 0;
      const patch = { cBig, dBig, sBig, role: cleanRole, item: cleanItem };

      // 1) Pas de echte 3D Game Progress data aan op de custom server!
      if (targetType === '3D' || targetId === 'ALL') {
        const profiles = targetId === 'ALL'
          ? Object.values(db.gameProfiles)
          : (db.gameProfiles[targetId] ? [db.gameProfiles[targetId]] : []);

        for (const prof of profiles) {
          prof.isNewPlaceholder = false;
          applyAdminPatchTo3DProfile(prof, patch);
          updated3DCount++;
        }
      }

      // 2) Pas ook het website-account aan (voor admin badges & overzicht)
      const accTargets = targetId === 'ALL'
        ? Object.values(db.users)
        : (db.users[targetId] ? [db.users[targetId]] : [admin]);

      for (const u of accTargets) {
        u.diamonds = addClampedBig(u.diamonds, dBig);
        u.coins = addClampedBig(u.coins, cBig);
        u.speed = addClampedBig(u.speed, sBig);
        if (cleanItem) {
          if (!Array.isArray(u.items)) u.items = [];
          if (!u.items.includes(cleanItem)) u.items.push(cleanItem);
        }
        if (cleanRole) {
          u.role = (u.email || '').toLowerCase() === ADMIN_EMAIL ? 'admin' : cleanRole;
        }
      }

      saveDB();
      const summary = parts.join(', ') || 'Update';
      addLog(`ADMIN GIVE (${updated3DCount} 3D profielen): ${summary}`);

      broadcastSiteEvent({
        type: 'gift',
        targetId: 'ALL',
        reloadGame: updated3DCount > 0,
        summary
      });

      sendJson(req, res, 200, {
        ok: true,
        updated3DCount,
        summary,
        user: publicUser(admin)
      });
      return;
    }

    // ADMIN: DIRECTE RAW JSON EDITOR VOOR 3D PROGRESS DATA
    if (req.method === 'POST' && urlPath === '/api/admin/save-3d-json') {
      const admin = getAuthUser(req);
      if (!isAdmin(admin)) {
        sendJson(req, res, 403, { ok: false, error: 'Geen admin rechten.' });
        return;
      }
      const body = await readJsonBody(req);
      const pid = String(body.profileId || '').trim();
      if (!pid || !body.data || typeof body.data !== 'object') {
        sendJson(req, res, 400, { ok: false, error: 'Ongeldige 3D JSON data.' });
        return;
      }
      db.gameProfiles[pid] = {
        id: pid,
        channel: (db.gameProfiles[pid] && db.gameProfiles[pid].channel) || '/server1',
        data: body.data,
        updatedAt: Date.now(),
        adminLockUntil: Date.now() + 8000,
        isNewPlaceholder: false
      };
      saveDB();
      addLog(`ADMIN RAW JSON opgeslagen voor 3D speler ${pid}`);
      broadcastSiteEvent({ type: 'gift', targetId: 'ALL', reloadGame: true, summary: `3D Data aangepast (${pid})` });
      sendJson(req, res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/admin/announce') {
      const admin = getAuthUser(req);
      if (!isAdmin(admin)) {
        sendJson(req, res, 403, { ok: false, error: 'Geen admin rechten.' });
        return;
      }
      const body = await readJsonBody(req);
      const text = String(body.text || '').trim().slice(0, 200);
      if (!text) {
        sendJson(req, res, 400, { ok: false, error: 'Bericht is leeg.' });
        return;
      }
      broadcastSiteEvent({ type: 'announcement', from: admin.name, text });
      sendJson(req, res, 200, { ok: true });
      return;
    }

    sendJson(req, res, 404, { ok: false, error: 'Niet gevonden' });
  } catch (err) {
    console.error('Server request error:', err);
    try {
      if (res && !res.headersSent) sendJson(req, res, 500, { ok: false, error: 'Interne serverfout' });
    } catch (_) {}
  }
});

// ============================================================
// WEBSOCKET SERVER
// ============================================================
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  const channelName = ((req && req.url) || '/server1').split('?')[0];
  if (channelName === '/site-events') {
    siteEventClients.add(ws);
    ws.on('close', () => siteEventClients.delete(ws));
    return;
  }

  const baseChannel = '/' + (channelName.split('/')[1] || 'server1');
  const playerId = Math.random().toString(36).slice(2, 10);
  const currentRoom = findOrCreatePublicRoom(baseChannel);
  currentRoom.clients.set(playerId, { ws });

  ws.on('message', (raw) => {
    broadcastRoom(currentRoom, raw, playerId);
  });

  ws.on('close', () => {
    currentRoom.clients.delete(playerId);
    if (currentRoom.clients.size === 0) getChannel(baseChannel).delete(currentRoom.code);
  });
});

process.on('uncaughtException', (err) => console.error('Uncaught:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled:', reason));

server.listen(PORT, () => {
  console.log(`🚀 3D Eggs Custom Data Server live op poort ${PORT} | Admin: ${ADMIN_EMAIL}`);
});
