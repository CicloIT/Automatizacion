const crypto = require('crypto');
const fs = require('fs');
const { filePath } = require('./store');

const COOKIE = 'wa_sid';
const SESSION_DAYS = 7;

// Secreto para firmar cookies; se guarda en data/ para que las sesiones sobrevivan reinicios.
function loadSecret() {
    if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
    const f = filePath('.secret');
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, s, { mode: 0o600 });
    return s;
}

const SECRET = loadSecret();

function sign(value) {
    return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}

function sha(v) {
    return crypto.createHash('sha256').update(String(v)).digest();
}

function checkPassword(input) {
    const expected = process.env.ADMIN_PASSWORD || '';
    if (!expected) return false;
    return crypto.timingSafeEqual(sha(input), sha(expected));
}

function makeToken() {
    const exp = Date.now() + SESSION_DAYS * 86400000;
    // El hash de la contraseña entra en la firma: si se cambia la contraseña, se invalidan las sesiones.
    const payload = `${exp}.${crypto.randomBytes(8).toString('hex')}`;
    return `${payload}.${sign(payload + sha(process.env.ADMIN_PASSWORD || '').toString('hex'))}`;
}

function verifyToken(token) {
    if (!token) return false;
    const i = token.lastIndexOf('.');
    if (i < 0) return false;
    const payload = token.slice(0, i);
    const sig = token.slice(i + 1);
    const expected = sign(payload + sha(process.env.ADMIN_PASSWORD || '').toString('hex'));
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    return Number(payload.split('.')[0]) > Date.now();
}

function readCookie(req, name) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === name) return decodeURIComponent(v.join('='));
    }
    return null;
}

// req.secure / req.ip respetan X-Forwarded-* sólo si vienen del proxy local
// (app.set('trust proxy', 'loopback') en server.js: Caddy o cloudflared).
function isHttps(req) {
    // COOKIE_SECURE=1 cuando el acceso público es siempre HTTPS (Tailscale Funnel)
    return req.secure || process.env.COOKIE_SECURE === '1';
}

function setSessionCookie(req, res, token) {
    const parts = [
        `${COOKIE}=${encodeURIComponent(token)}`,
        'Path=/', 'HttpOnly', 'SameSite=Strict',
        `Max-Age=${token ? SESSION_DAYS * 86400 : 0}`,
    ];
    if (isHttps(req)) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
}

// Límite simple de intentos de login por IP
const attempts = new Map();
function clientIp(req) {
    // No usar encabezados como cf-connecting-ip: con el server expuesto directo se pueden falsificar.
    return req.ip || req.socket.remoteAddress || '?';
}
function tooManyAttempts(req) {
    const ip = clientIp(req);
    const now = Date.now();
    const a = attempts.get(ip);
    if (!a || a.reset < now) return false;
    return a.count >= 5;
}
function registerFail(req) {
    const ip = clientIp(req);
    const now = Date.now();
    const a = attempts.get(ip);
    if (!a || a.reset < now) attempts.set(ip, { count: 1, reset: now + 15 * 60000 });
    else a.count++;
}
function clearFails(req) {
    attempts.delete(clientIp(req));
}

function requireAuth(req, res, next) {
    if (verifyToken(readCookie(req, COOKIE))) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'No autenticado' });
    return res.redirect('/login.html');
}

module.exports = {
    COOKIE, checkPassword, makeToken, verifyToken, readCookie, setSessionCookie,
    tooManyAttempts, registerFail, clearFails, requireAuth,
};
