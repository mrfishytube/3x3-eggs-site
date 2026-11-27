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
const TOKEN_SECRET = process.env.SESSION_SECRET || '3x3_eggs_ttsave_3d_secret_2026_v10';

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

function addToSafeNumber(currentVal, deltaBig) {
  const curBig = toBig(Math.floor(Number(currentVal) || 0));
  const nextBig = curBig + deltaBig;
  const clamped = nextBig < 0n ? 0n : nextBig;
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(clamped > maxSafe ? maxSafe : clamped);
}

// ============================================================
// CUSTOM DATABASE (accounts + echte 3D ttSave voortgang)
// ============================================================
const DB_FILE = path.join(__dirname, 'custom-3d-saves.json');
let db = { users: {}, logs: [] };

if (fs.existsSync(DB_FILE)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.users = parsed.users || {};
    db.logs = Array.isArray(parsed.logs) ? parsed.logs : [];
  } catch (e) {
    db = { users: {}, logs: [] };
  }
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('Kon custom-3d-saves.json niet opslaan:', e.message);
  }
}

function addLog(msg) {
  const line = `[${new Date().toLocaleTimeString('nl-NL')}] ${msg}`;
  db.logs.unshift(line);
  if (db.logs.length > 35) db.logs.length = 35;
  console.log(line);
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update('eggs_salt_v10_' + pw).digest('hex');
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
    items: Array.isArray(u.items) ? u.items : [],
    has3DSave: Boolean(u.ttSaveJson),
    ttSaveUpdatedAt: u.ttSaveUpdatedAt || 0
  };
}

// ============================================================
// STATELESS HMAC TOKENS (overleven Render herstarts!)
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
      ttSaveJson: null,
      ttSaveUpdatedAt: 0,
      adminLockUntil: 0,
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
// PATCHER VOOR ECHTE 3D GAME ttSave STORAGE DATA
// ============================================================
function patchGameJsonRecursive(obj, { cBig, sBig, item }) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  let changed = false;

  const coinNames = ['coins', 'money', 'coin', 'balance', 'cash'];
  const speedNames = ['speed', 'playerSpeed', 'walkSpeed', 'baseSpeed'];
  const trailArrayNames = ['ownedtrails', 'unlockedtrails', 'trails', 'playertrails', 'ownedplayertrails'];
  const activeTrailNames = ['equippedtrail', 'activetrail', 'selectedtrail', 'equippedplayertrail', 'playertrail'];
  const treadmillArrayNames = ['ownedtreadmills', 'unlockedtreadmills', 'treadmills'];
  const activeTreadmillNames = ['equippedtreadmill', 'activetreadmill', 'selectedtreadmill', 'treadmill'];

  for (const key of Object.keys(obj)) {
    const low = key.toLowerCase();
    const val = obj[key];

    if (cBig !== 0n && coinNames.includes(low) && (typeof val === 'number' || typeof val === 'string')) {
      obj[key] = addToSafeNumber(val, cBig);
      changed = true;
    }

    if (sBig !== 0n && speedNames.includes(low) && (typeof val === 'number' || typeof val === 'string')) {
      obj[key] = addToSafeNumber(val, sBig);
      changed = true;
    }

    if (item && item.toLowerCase().includes('trail')) {
      const wantTrails = ['glitch', 'cosmic', 'secret', 'light', 'candy-cane', 'snowflake', 'ice', 'slime', 'water', 'green'];
      if (trailArrayNames.includes(low) && Array.isArray(val)) {
        for (const t of wantTrails) {
          if (!val.includes(t)) val.push(t);
        }
        changed = true;
      }
      if (activeTrailNames.includes(low) && typeof val === 'string') {
        obj[key] = item.toLowerCase().includes('admin') ? 'glitch' : 'cosmic';
        changed = true;
      }
    }

    if (item && item.toLowerCase().includes('treadmill')) {
      const wantTreads = ['basic', 'gold', 'diamond', 'sunken', 'quantum', 'galaxy', 'void', 'celestial', 'christmas', 'playtime', 'admin'];
      if (treadmillArrayNames.includes(low) && Array.isArray(val)) {
        for (const tm of wantTreads) {
          if (!val.includes(tm)) val.push(tm);
        }
        changed = true;
      }
      if (activeTreadmillNames.includes(low)) {
        if (typeof val === 'string') {
          obj[key] = 'celestial';
          changed = true;
        }
      }
    }

    if (val && typeof val === 'object' && !Array.isArray(val)) {
      if (patchGameJsonRecursive(val, { cBig, sBig, item })) changed = true;
    }
  }
  return changed;
}

function patchUserTTSave(user, { cBig, sBig, item }) {
  if (!user.ttSaveJson) return { patched: false, reason: 'Geen 3D save ontvangen van dit account (speel eerst 15 sec terwijl je bent ingelogd).' };
  let bundle = null;
  try {
    bundle = JSON.parse(user.ttSaveJson);
  } catch (e) {
    return { patched: false, reason: '3D save is geen geldige JSON.' };
  }
  if (!bundle || typeof bundle !== 'object' || !bundle.storage || typeof bundle.storage !== 'object') {
    return { patched: false, reason: '3D save is ingepakt (packed) of heeft geen storage-object.' };
  }

  let anyPatched = false;
  // Als de admin alleen een trail/treadmill geeft, tel +1 munt bij zodat de 3D game ziet dat de account-save nieuwer/hoger is
  const effectiveCoins = (cBig === 0n && sBig === 0n && item) ? 1n : cBig;

  for (const [k, rawVal] of Object.entries(bundle.storage)) {
    if (typeof rawVal !== 'string') continue;
    const trimmed = rawVal.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (patchGameJsonRecursive(parsed, { cBig: effectiveCoins, sBig, item })) {
          bundle.storage[k] = JSON.stringify(parsed);
          anyPatched = true;
        }
      } catch (e) {}
    } else if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const lowK = k.toLowerCase();
      if (effectiveCoins !== 0n && (lowK.includes('coin') || lowK.includes('money'))) {
        bundle.storage[k] = String(addToSafeNumber(trimmed, effectiveCoins));
        anyPatched = true;
      }
      if (sBig !== 0n && lowK.includes('speed')) {
        bundle.storage[k] = String(addToSafeNumber(trimmed, sBig));
        anyPatched = true;
      }
    }
  }

  if (anyPatched) {
    bundle.updatedAt = Date.now();
    user.ttSaveJson = JSON.stringify(bundle);
    user.ttSaveUpdatedAt = Date.now();
    user.adminLockUntil = Date.now() + 10000;
  }
  return { patched: anyPatched, reason: anyPatched ? 'OK' : 'Geen bijpassend veld gevonden in storage (gebruik de JSON-editor hieronder om de exacte sleutel te zien).' };
}

// ============================================================
// HTTP HELPERS
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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5e6) req.destroy();
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
  });
}

function sendJson(req, res, status, obj) {
  const headers = (req && req.headers) ? req.headers : {};
  const origin = headers.origin;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(obj));
}

// ============================================================
// LIVE SITE EVENTS (WebSocket)
// ============================================================
const siteEventClients = new Set();
function broadcastSiteEvent(payload) {
  const data = JSON.stringify(payload);
  for (const ws of siteEventClients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

// ============================================================
// HTTP SERVER
// ============================================================
const server = http.createServer(async (req, res) => {
  try {
    if (!req || !res) return;
    const headers = req.headers || {};
    const urlPath = (req.url || '/').split('?')[0];

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': headers.origin || '*',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      });
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
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('index.html ontbreekt in de hoofdmap op GitHub!');
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/health') {
      sendJson(req, res, 200, {
        ok: true,
        version: '10.0.0',
        usersCount: Object.keys(db.users).length
      });
      return;
    }

    // AUTH: REGISTER (geen verificatie voor @ll.flevion.nl & admin)
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
        ttSaveJson: null,
        ttSaveUpdatedAt: 0,
        adminLockUntil: 0,
        createdAt: now,
        lastLogin: now
      };
      saveDB();

      if (skipVerify) {
        addLog(`Nieuw account direct geverifieerd: ${email}`);
        sendJson(req, res, 200, { ok: true, token: createToken(db.users[uid]), user: publicUser(db.users[uid]) });
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
          ttSaveJson: null,
          ttSaveUpdatedAt: 0,
          adminLockUntil: 0,
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
    // ECHTE 3D GAME ttSave BRIDGE ENDPOINTS
    // ============================================================
    if (req.method === 'GET' && urlPath === '/api/ttsave/load') {
      const user = getAuthUser(req);
      if (!user) {
        sendJson(req, res, 401, { ok: false, error: 'Niet ingelogd.' });
        return;
      }
      addLog(`3D Game laadt ttSave voor ${user.email} (${user.ttSaveJson ? user.ttSaveJson.length + ' bytes' : 'leeg'})`);
      sendJson(req, res, 200, { ok: true, payloadJson: user.ttSaveJson || null });
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/ttsave/save') {
      const user = getAuthUser(req);
      if (!user) {
        sendJson(req, res, 401, { ok: false, error: 'Niet ingelogd.' });
        return;
      }
      const body = await readJsonBody(req);
      const payloadJson = typeof body.payloadJson === 'string' ? body.payloadJson : '';
      if (!payloadJson) {
        sendJson(req, res, 400, { ok: false, error: 'Geen payloadJson.' });
        return;
      }
      if (user.adminLockUntil && Date.now() < user.adminLockUntil) {
        addLog(`3D ttSave POST genegeerd tijdens Admin-override voor ${user.email}`);
        sendJson(req, res, 200, { ok: true, skipped: true });
        return;
      }
      user.ttSaveJson = payloadJson;
      user.ttSaveUpdatedAt = Date.now();
      saveDB();
      addLog(`3D Game ttSave opgeslagen voor ${user.email} (${payloadJson.length} bytes)`);
      broadcastSiteEvent({ type: 'ttsave_synced', userId: user.id });
      sendJson(req, res, 200, { ok: true });
      return;
    }

    // ============================================================
    // ADMIN PANEL ENDPOINTS
    // ============================================================
    if (req.method === 'GET' && urlPath === '/api/admin/state') {
      const admin = getAuthUser(req);
      if (!isAdmin(admin)) {
        sendJson(req, res, 403, { ok: false, error: 'Geen admin rechten.' });
        return;
      }
      sendJson(req, res, 200, {
        ok: true,
        users: Object.values(db.users).map((u) => ({
          ...publicUser(u),
          ttSaveJson: u.ttSaveJson || null
        })),
        logs: db.logs
      });
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/admin/give') {
      const admin = getAuthUser(req);
      if (!isAdmin(admin)) {
        sendJson(req, res, 403, { ok: false, error: 'Geen admin rechten.' });
        return;
      }
      const body = await readJsonBody(req);
      const { targetId = 'SELF', diamonds = '0', coins = '0', speed = '0', role = '', item = '' } = body;
      const dBig = toBig(diamonds);
      const cBig = toBig(coins);
      const sBig = toBig(speed);
      const cleanItem = typeof item === 'string' ? item.trim().slice(0, 60) : '';
      const cleanRole = ['player', 'vip', 'mod', 'admin'].includes(role) ? role : '';

      const realTargetId = targetId === 'SELF' ? admin.id : targetId;
      const targets = realTargetId === 'ALL'
        ? Object.values(db.users)
        : (db.users[realTargetId] ? [db.users[realTargetId]] : []);

      if (targets.length === 0) {
        sendJson(req, res, 404, { ok: false, error: 'Speler niet gevonden.' });
        return;
      }

      const parts = [];
      if (cBig !== 0n) parts.push(`${cBig > 0n ? '+' : ''}${formatBig(cBig)} 🪙`);
      if (dBig !== 0n) parts.push(`${dBig > 0n ? '+' : ''}${formatBig(dBig)} 💎`);
      if (sBig !== 0n) parts.push(`${sBig > 0n ? '+' : ''}${formatBig(sBig)} ⚡`);
      if (cleanItem) parts.push(cleanItem);
      if (cleanRole) parts.push(`Rang: ${cleanRole.toUpperCase()}`);

      let patched3D = 0;
      let lastNote = '';

      for (const u of targets) {
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
        if (cBig !== 0n || sBig !== 0n || cleanItem) {
          const resPatch = patchUserTTSave(u, { cBig, sBig, item: cleanItem });
          if (resPatch.patched) patched3D++;
          lastNote = resPatch.reason;
        }
      }

      saveDB();
      const summary = parts.join(', ') || 'Update';
      addLog(`ADMIN GIVE -> ${realTargetId === 'ALL' ? 'IEDEREEN' : targets[0].email}: ${summary} (3D saves aangepast: ${patched3D})`);

      broadcastSiteEvent({
        type: 'admin_update',
        targetId: realTargetId,
        reloadGame: patched3D > 0 || Boolean(cleanRole),
        summary
      });

      sendJson(req, res, 200, {
        ok: true,
        patched3D,
        note: lastNote,
        summary,
        user: publicUser(admin)
      });
      return;
    }

    // ADMIN: DIRECTE 3D ttSave JSON EDITOR
    if (req.method === 'POST' && urlPath === '/api/admin/save-ttsave') {
      const admin = getAuthUser(req);
      if (!isAdmin(admin)) {
        sendJson(req, res, 403, { ok: false, error: 'Geen admin rechten.' });
        return;
      }
      const body = await readJsonBody(req);
      const targetId = body.targetId === 'SELF' ? admin.id : String(body.targetId || '');
      const target = db.users[targetId];
      if (!target) {
        sendJson(req, res, 404, { ok: false, error: 'Speler niet gevonden.' });
        return;
      }
      if (!body.payloadJson || typeof body.payloadJson !== 'string') {
        sendJson(req, res, 400, { ok: false, error: 'Ongeldige JSON.' });
        return;
      }
      try {
        JSON.parse(body.payloadJson);
      } catch (e) {
        sendJson(req, res, 400, { ok: false, error: 'JSON syntax fout.' });
        return;
      }

      target.ttSaveJson = body.payloadJson;
      target.ttSaveUpdatedAt = Date.now();
      target.adminLockUntil = Date.now() + 10000;
      saveDB();
      addLog(`ADMIN JSON opgeslagen voor ${target.email}`);
      broadcastSiteEvent({
        type: 'admin_update',
        targetId: target.id,
        reloadGame: true,
        summary: '3D Save-Data bijgewerkt door Admin!'
      });
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
    console.error('Server error:', err);
    try {
      if (res && !res.headersSent) sendJson(req, res, 500, { ok: false, error: 'Interne serverfout' });
    } catch (_) {}
  }
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  const ch = ((req && req.url) || '').split('?')[0];
  if (ch === '/site-events') {
    siteEventClients.add(ws);
    ws.on('close', () => siteEventClients.delete(ws));
  }
});

process.on('uncaughtException', (err) => console.error('Uncaught:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled:', reason));

server.listen(PORT, () => {
  console.log(`🚀 3D Eggs ttSave & Admin Server v10 live op poort ${PORT} | Admin: ${ADMIN_EMAIL}`);
});
