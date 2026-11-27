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

function hashPassword(pw) {
  return crypto.createHash('sha256').update('eggs_salt_' + pw).digest('hex');
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

function getAuthUser(req) {
  const headers = (req && req.headers) ? req.headers : {};
  const authHeader = headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const uid = db.sessions[token];
  if (!uid || !db.users[uid]) return null;
  return db.users[uid];
}

function isAdmin(user) {
  if (!user) return false;
  return (user.email || '').toLowerCase() === ADMIN_EMAIL || user.role === 'admin';
}

function createSession(uid) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = uid;
  saveDB();
  return token;
}

const siteEventClients = new Set();
function broadcastSiteEvent(payload) {
  const data = JSON.stringify(payload);
  for (const ws of siteEventClients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

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
      sendJson(req, res, 200, { ok: true, usersCount: Object.keys(db.users).length });
      return;
    }

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
        sendJson(req, res, 409, { ok: false, error: 'Dit e-mailadres bestaat al. Log in!' });
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
        const token = createSession(uid);
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
      const token = createSession(user.id);
      sendJson(req, res, 200, { ok: true, token, user: publicUser(user) });
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

      const token = createSession(user.id);
      sendJson(req, res, 200, { ok: true, token, user: publicUser(user) });
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

      const token = createSession(user.id);
      sendJson(req, res, 200, { ok: true, token, user: publicUser(user) });
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

    if (req.method === 'GET' && urlPath === '/api/admin/users') {
      const admin = getAuthUser(req);
      if (!isAdmin(admin)) {
        sendJson(req, res, 403, { ok: false, error: 'Geen admin rechten.' });
        return;
      }
      sendJson(req, res, 200, { ok: true, users: Object.values(db.users).map(publicUser) });
      return;
    }

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
        sendJson(req, 404, { ok: false, error: 'Speler niet gevonden.' });
        return;
      }

      const parts = [];
      if (dBig !== 0n) parts.push(`${dBig > 0n ? '+' : ''}${formatBig(dBig)} 💎`);
      if (cBig !== 0n) parts.push(`${cBig > 0n ? '+' : ''}${formatBig(cBig)} 🪙`);
      if (sBig !== 0n) parts.push(`${sBig > 0n ? '+' : ''}${formatBig(sBig)} ⚡`);
      if (cleanItem) parts.push(cleanItem);
      if (cleanRole) parts.push(`Rang: ${cleanRole.toUpperCase()}`);

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
      }
      saveDB();

      const summary = parts.join(', ') || 'Update';
      broadcastSiteEvent({
        type: 'gift',
        targetId: targetId === 'ALL' ? 'ALL' : targets[0].id,
        from: admin.name,
        summary
      });

      sendJson(req, res, 200, { ok: true, count: targets.length, summary });
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
        sendJson(req, 400, { ok: false, error: 'Bericht is leeg.' });
        return;
      }
      broadcastSiteEvent({ type: 'announcement', from: admin.name, text });
      sendJson(req, 200, { ok: true });
      return;
    }

    sendJson(req, res, 404, { ok: false, error: 'Niet gevonden' });
  } catch (err) {
    console.error('Server request error:', err);
    try {
      if (res && !res.headersSent) {
        sendJson(req, res, 500, { ok: false, error: 'Interne serverfout' });
      }
    } catch (_) {}
  }
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  const channelName = ((req && req.url) || '').split('?')[0];
  if (channelName === '/site-events') {
    siteEventClients.add(ws);
    ws.on('close', () => siteEventClients.delete(ws));
  }
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

server.listen(PORT, () => {
  console.log(`🚀 Simpele Admin Server draait op poort ${PORT} | Admin: ${ADMIN_EMAIL}`);
});
