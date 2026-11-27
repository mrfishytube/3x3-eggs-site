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
const TOKEN_SECRET = process.env.SESSION_SECRET || '3x3_eggs_custom_game_secret_2026_v8';

// ============================================================
// BIG-NUMBER HELPERS (ondersteunt enorme getallen zoals 100000000000)
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

// ============================================================
// CUSTOM GAME DATA (custom-game-data.json)
// ============================================================
const DB_FILE = path.join(__dirname, 'custom-game-data.json');
let db = { users: {} };

if (fs.existsSync(DB_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!db.users) db.users = {};
  } catch (e) {
    db = { users: {} };
  }
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('Kon database niet opslaan:', e.message);
  }
}

function defaultGameUser(id, name, email, picture = '', role = 'player', passwordHash = '', verified = true, verifyCode = null) {
  const lower = String(email || '').toLowerCase();
  const isOwner = lower === ADMIN_EMAIL;
  const finalRole = isOwner ? 'admin' : role;
  const now = new Date().toISOString();
  return {
    id,
    name: name || (lower ? lower.split('@')[0] : 'Speler'),
    email: lower,
    passwordHash,
    picture,
    role: finalRole,
    verified: isOwner ? true : verified,
    verifyCode,
    diamonds: isOwner ? '1000' : '0',
    coins: isOwner ? '5000' : '100',
    speed: isOwner ? '50' : '10',
    activeTrail: isOwner ? 'admin_trail' : 'none',
    treadmillLevel: isOwner ? 4 : 1,
    hasAdminTreadmill: isOwner,
    items: isOwner ? ['👑 Admin Trail', '⚡ Speed Trail', '🏃 Admin Treadmill', '🥚 Gouden Ei'] : [],
    pets: isOwner ? [{ name: '🐉 Regenboog Draak', emoji: '🐉', income: '500' }] : [{ name: '🐰 Gewoon Konijn', emoji: '🐰', income: '5' }],
    createdAt: now,
    lastLogin: now
  };
}

function ensureUserFields(u) {
  if (!u) return u;
  if ((u.email || '').toLowerCase() === ADMIN_EMAIL) u.role = 'admin';
  if (!u.role) u.role = 'player';
  u.diamonds = toBig(u.diamonds || '0').toString();
  u.coins = toBig(u.coins || '0').toString();
  u.speed = toBig(u.speed || '10').toString();
  if (!Array.isArray(u.items)) u.items = [];
  if (!Array.isArray(u.pets)) u.pets = [];
  if (!u.activeTrail) u.activeTrail = 'none';
  if (typeof u.treadmillLevel !== 'number') u.treadmillLevel = 1;
  if (typeof u.hasAdminTreadmill !== 'boolean') {
    u.hasAdminTreadmill = u.role === 'admin' || u.items.includes('🏃 Admin Treadmill');
  }
  return u;
}

function publicUser(u) {
  ensureUserFields(u);
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    picture: u.picture || '',
    role: (u.email || '').toLowerCase() === ADMIN_EMAIL ? 'admin' : (u.role || 'player'),
    verified: Boolean(u.verified),
    diamonds: u.diamonds,
    coins: u.coins,
    speed: u.speed,
    activeTrail: u.activeTrail,
    treadmillLevel: u.treadmillLevel,
    hasAdminTreadmill: u.hasAdminTreadmill || u.role === 'admin' || u.items.includes('🏃 Admin Treadmill'),
    items: u.items,
    pets: u.pets
  };
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update('eggs_salt_v8_' + pw).digest('hex');
}

function findUserByEmail(email) {
  const lower = String(email || '').trim().toLowerCase();
  return Object.values(db.users).find((u) => (u.email || '').toLowerCase() === lower) || null;
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
    // Render free tier kan disk resetten -> herstel account automatisch vanuit geldig token!
    user = defaultGameUser(data.id, data.name, data.email, '', data.role || 'player', '', true, null);
    db.users[user.id] = user;
    saveDB();
  }
  return ensureUserFields(user);
}

function isAdmin(user) {
  if (!user) return false;
  return (user.email || '').toLowerCase() === ADMIN_EMAIL || user.role === 'admin';
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
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
  });
}

function sendJson(req, res, status, obj) {
  const headers = (req && req.headers) ? req.headers : {};
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': headers.origin || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(obj));
}

// ============================================================
// LIVE MULTIPLAYER & REAL-TIME ADMIN SYNC (WebSocket)
// ============================================================
const playersOnline = new Map(); // ws -> { id, name, role, x, y, activeTrail, speed, petsCount }

function broadcastAll(payload, excludeWs = null) {
  const data = JSON.stringify(payload);
  for (const ws of playersOnline.keys()) {
    if (ws !== excludeWs && ws.readyState === 1) {
      ws.send(data);
    }
  }
}

function pushUserUpdate(user) {
  const pub = publicUser(user);
  for (const [ws, p] of playersOnline.entries()) {
    if (p.id === user.id && ws.readyState === 1) {
      p.role = pub.role;
      p.activeTrail = pub.activeTrail;
      p.speed = pub.speed;
      p.petsCount = pub.pets.length;
      ws.send(JSON.stringify({ type: 'profile_sync', user: pub }));
    }
  }
  broadcastAll({
    type: 'players_list',
    players: Array.from(playersOnline.values())
  });
}

// ============================================================
// PET CATALOGUS VOOR CUSTOM EIEREN / ADMIN ITEMS
// ============================================================
const PET_MAP = {
  '🥚 Gouden Ei': { name: '🐥 Gouden Kuiken', emoji: '🐥', income: '250' },
  '🐉 Regenboog Draak': { name: '🐉 Regenboog Draak', emoji: '🐉', income: '2500' },
  '🐟 Mega Vis': { name: '🐟 Mega Vis', emoji: '🐟', income: '10000' },
  '👑 VIP Kroon': { name: '🦁 Koningsleeuw', emoji: '🦁', income: '1500' }
};

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
    }

    if (req.method === 'GET' && urlPath === '/api/health') {
      sendJson(req, res, 200, {
        ok: true,
        usersCount: Object.keys(db.users).length,
        onlineCount: playersOnline.size
      });
      return;
    }

    // AUTH: REGISTER
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

      const user = defaultGameUser(
        uid,
        name,
        email,
        '',
        isAdminEmail ? 'admin' : 'player',
        hashPassword(password),
        skipVerify,
        verifyCode
      );
      db.users[uid] = user;
      saveDB();

      if (skipVerify) {
        const token = createToken(user);
        sendJson(req, res, 200, { ok: true, token, user: publicUser(user) });
      } else {
        sendJson(req, res, 200, {
          ok: true,
          needsVerification: true,
          message: `Verificatiecode voor ${email}: ${verifyCode} (voor @ll.flevion.nl is geen code nodig)`
        });
      }
      return;
    }

    // AUTH: VERIFY
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
      const token = createToken(user);
      sendJson(req, res, 200, { ok: true, token, user: publicUser(user) });
      return;
    }

    // AUTH: LOGIN
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
      ensureUserFields(user);
      saveDB();
      const token = createToken(user);
      sendJson(req, res, 200, { ok: true, token, user: publicUser(user) });
      return;
    }

    // AUTH: GOOGLE
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
      if (!user) {
        user = defaultGameUser(payload.sub, payload.name || 'Speler', email, payload.picture || '', email === ADMIN_EMAIL ? 'admin' : 'player', '', true, null);
        db.users[user.id] = user;
      } else {
        user.name = payload.name || user.name;
        user.picture = payload.picture || user.picture;
        user.verified = true;
        user.lastLogin = new Date().toISOString();
        ensureUserFields(user);
      }
      saveDB();
      const token = createToken(user);
      sendJson(req, res, 200, { ok: true, token, user: publicUser(user) });
      return;
    }

    // PROFILE
    if (req.method === 'GET' && urlPath === '/api/me') {
      const user = getAuthUser(req);
      if (!user) {
        sendJson(req, res, 401, { ok: false, error: 'Niet ingelogd.' });
        return;
      }
      sendJson(req, res, 200, { ok: true, user: publicUser(user) });
      return;
    }

    // GAME ACTION: TREADMILL / QUIZ / BUY EGG / EQUIP TRAIL / PASSIVE INCOME
    if (req.method === 'POST' && urlPath === '/api/game/action') {
      const user = getAuthUser(req);
      if (!user) {
        sendJson(req, res, 401, { ok: false, error: 'Niet ingelogd.' });
        return;
      }
      const body = await readJsonBody(req);
      const action = String(body.action || '');

      if (action === 'treadmill') {
        const isAdminTread = Boolean(body.adminTreadmill);
        if (isAdminTread && !isAdmin(user) && !user.hasAdminTreadmill && !user.items.includes('🏃 Admin Treadmill')) {
          sendJson(req, res, 403, { ok: false, error: 'Je hebt de Admin Treadmill nog niet!' });
          return;
        }
        const gainSpeed = isAdminTread ? toBig(body.power || '5000') : toBig(user.treadmillLevel * 5);
        const clampedSpeed = gainSpeed > 10000000n ? 10000000n : (gainSpeed < 1n ? 1n : gainSpeed);
        user.speed = addClampedBig(user.speed, clampedSpeed);
        user.coins = addClampedBig(user.coins, clampedSpeed * 2n);
        saveDB();
        pushUserUpdate(user);
        sendJson(req, res, 200, { ok: true, user: publicUser(user) });
        return;
      }

      if (action === 'quiz_reward') {
        const bonusCoins = 150n + toBig(user.speed);
        user.coins = addClampedBig(user.coins, bonusCoins);
        user.diamonds = addClampedBig(user.diamonds, 5n);
        saveDB();
        pushUserUpdate(user);
        sendJson(req, res, 200, { ok: true, reward: formatBig(bonusCoins), user: publicUser(user) });
        return;
      }

      if (action === 'collect_income') {
        let total = 0n;
        for (const pet of user.pets) {
          total += toBig(pet.income || '5');
        }
        if (total > 0n) {
          user.coins = addClampedBig(user.coins, total);
          saveDB();
        }
        sendJson(req, res, 200, { ok: true, earned: total.toString(), user: publicUser(user) });
        return;
      }

      if (action === 'buy_egg') {
        const tier = String(body.tier || 'basic');
        const catalog = {
          basic: { cost: 100n, pets: [{ name: '🐰 Sneeuw Konijn', emoji: '🐰', income: '15' }, { name: '🐧 IJs Pinguïn', emoji: '🐧', income: '30' }] },
          gold: { cost: 1000n, pets: [{ name: '🦊 Gouden Vos', emoji: '🦊', income: '150' }, { name: '🦉 Magische Uil', emoji: '🦉', income: '300' }] },
          mythic: { cost: 25000n, pets: [{ name: '🐉 Regenboog Draak', emoji: '🐉', income: '2500' }, { name: '🦄 Sterren Eenhoorn', emoji: '🦄', income: '4000' }] }
        };
        const egg = catalog[tier] || catalog.basic;
        if (toBig(user.coins) < egg.cost) {
          sendJson(req, res, 400, { ok: false, error: `Niet genoeg munten! Nodig: ${formatBig(egg.cost)}` });
          return;
        }
        user.coins = addClampedBig(user.coins, -egg.cost);
        const hatched = egg.pets[Math.floor(Math.random() * egg.pets.length)];
        user.pets.push(hatched);
        saveDB();
        pushUserUpdate(user);
        sendJson(req, res, 200, { ok: true, hatched, user: publicUser(user) });
        return;
      }

      if (action === 'set_trail') {
        const trail = String(body.trail || 'none');
        const hasAdmin = isAdmin(user) || user.items.includes('👑 Admin Trail');
        const hasSpeed = isAdmin(user) || user.items.includes('⚡ Speed Trail');
        if (trail === 'admin_trail' && !hasAdmin) {
          sendJson(req, res, 403, { ok: false, error: 'Je hebt geen Admin Trail.' });
          return;
        }
        if (trail === 'speed_trail' && !hasSpeed) {
          sendJson(req, res, 403, { ok: false, error: 'Je hebt geen Speed Trail.' });
          return;
        }
        user.activeTrail = ['none', 'admin_trail', 'speed_trail'].includes(trail) ? trail : 'none';
        saveDB();
        pushUserUpdate(user);
        sendJson(req, res, 200, { ok: true, user: publicUser(user) });
        return;
      }

      sendJson(req, res, 400, { ok: false, error: 'Onbekende actie.' });
      return;
    }

    // ADMIN: USERS LIST
    if (req.method === 'GET' && urlPath === '/api/admin/users') {
      const admin = getAuthUser(req);
      if (!isAdmin(admin)) {
        sendJson(req, res, 403, { ok: false, error: 'Geen admin rechten.' });
        return;
      }
      sendJson(req, res, 200, { ok: true, users: Object.values(db.users).map(publicUser) });
      return;
    }

    // ADMIN: GIVE IN-GAME DATA (Munten, Diamanten, Snelheid, Rang, Admin Treadmill, Trails, Pets)
    if (req.method === 'POST' && urlPath === '/api/admin/give') {
      const admin = getAuthUser(req);
      if (!isAdmin(admin)) {
        sendJson(req, res, 403, { ok: false, error: 'Geen admin rechten.' });
        return;
      }
      const body = await readJsonBody(req);
      const { targetId, diamonds = '0', coins = '0', speed = '0', role = '', item = '' } = body;
      const dBig = toBig(diamonds);
      const cBig = toBig(coins);
      const sBig = toBig(speed);
      const cleanItem = typeof item === 'string' ? item.trim().slice(0, 60) : '';
      const cleanRole = ['player', 'vip', 'mod', 'admin'].includes(role) ? role : '';

      const targets = targetId === 'ALL'
        ? Object.values(db.users)
        : (db.users[targetId] ? [db.users[targetId]] : []);

      if (targets.length === 0) {
        sendJson(req, res, 404, { ok: false, error: 'Speler niet gevonden.' });
        return;
      }

      const parts = [];
      if (dBig !== 0n) parts.push(`${dBig > 0n ? '+' : ''}${formatBig(dBig)} 💎`);
      if (cBig !== 0n) parts.push(`${cBig > 0n ? '+' : ''}${formatBig(cBig)} 🪙`);
      if (sBig !== 0n) parts.push(`${sBig > 0n ? '+' : ''}${formatBig(sBig)} ⚡`);
      if (cleanItem) parts.push(cleanItem);
      if (cleanRole) parts.push(`Rang: ${cleanRole.toUpperCase()}`);

      for (const u of targets) {
        ensureUserFields(u);
        u.diamonds = addClampedBig(u.diamonds, dBig);
        u.coins = addClampedBig(u.coins, cBig);
        u.speed = addClampedBig(u.speed, sBig);

        if (cleanItem) {
          if (!u.items.includes(cleanItem)) u.items.push(cleanItem);
          if (cleanItem === '🏃 Admin Treadmill') {
            u.hasAdminTreadmill = true;
            u.treadmillLevel = Math.max(u.treadmillLevel, 5);
          }
          if (cleanItem === '👑 Admin Trail') u.activeTrail = 'admin_trail';
          if (cleanItem === '⚡ Speed Trail') u.activeTrail = 'speed_trail';
          if (PET_MAP[cleanItem]) {
            u.pets.push({ ...PET_MAP[cleanItem] });
          } else if (!cleanItem.includes('Trail') && !cleanItem.includes('Treadmill')) {
            u.pets.push({ name: cleanItem, emoji: '🥚', income: '500' });
          }
        }

        if (cleanRole) {
          u.role = (u.email || '').toLowerCase() === ADMIN_EMAIL ? 'admin' : cleanRole;
          if (u.role === 'admin') u.hasAdminTreadmill = true;
        }
      }
      saveDB();

      const summary = parts.join(', ') || 'Update';
      for (const u of targets) {
        pushUserUpdate(u);
      }
      broadcastAll({
        type: 'gift',
        targetId: targetId === 'ALL' ? 'ALL' : targets[0].id,
        from: admin.name,
        summary
      });

      sendJson(req, res, 200, { ok: true, count: targets.length, summary, user: publicUser(admin) });
      return;
    }

    // ADMIN: ANNOUNCE
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
      broadcastAll({ type: 'announcement', from: admin.name, text });
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

// ============================================================
// WEBSOCKET MULTIPLAYER SERVER
// ============================================================
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg = null;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    if (msg.type === 'join') {
      const data = verifyToken(msg.token);
      let user = data ? (db.users[data.id] || findUserByEmail(data.email)) : null;
      const pub = user ? publicUser(user) : {
        id: 'guest_' + Math.random().toString(36).slice(2, 7),
        name: msg.name || 'Gast',
        role: 'player',
        activeTrail: 'none',
        speed: '10',
        pets: []
      };
      playersOnline.set(ws, {
        id: pub.id,
        name: pub.name,
        role: pub.role,
        x: typeof msg.x === 'number' ? msg.x : 420,
        y: typeof msg.y === 'number' ? msg.y : 340,
        activeTrail: pub.activeTrail,
        speed: pub.speed,
        petsCount: pub.pets.length
      });
      broadcastAll({ type: 'players_list', players: Array.from(playersOnline.values()) });
      return;
    }

    if (msg.type === 'move') {
      const p = playersOnline.get(ws);
      if (p) {
        p.x = Number(msg.x) || p.x;
        p.y = Number(msg.y) || p.y;
        p.activeTrail = msg.activeTrail || p.activeTrail;
        broadcastAll({ type: 'player_moved', player: p }, ws);
      }
    }
  });

  ws.on('close', () => {
    playersOnline.delete(ws);
    broadcastAll({ type: 'players_list', players: Array.from(playersOnline.values()) });
  });
});

process.on('uncaughtException', (err) => console.error('Uncaught:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled:', reason));

server.listen(PORT, () => {
  console.log(`🚀 Custom 3x3 Eggs Game Server live op poort ${PORT} | Admin: ${ADMIN_EMAIL}`);
});
