const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Carga .env simple (Node 20 no tiene --env-file-if-exists)
(function loadEnv() {
    const f = path.join(__dirname, '.env');
    if (!fs.existsSync(f)) return;
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
        if (!m || line.trim().startsWith('#')) continue;
        let v = m[2];
        if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
        if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
})();

const express = require('express');
const multer = require('multer');
const { UPLOADS_DIR } = require('./lib/store');
const auth = require('./lib/auth');
const { readRows, analyze, buildContacts, normalizeNumber } = require('./lib/contacts');
const { WhatsApp } = require('./lib/whatsapp');
const { Campaign, buildMessage } = require('./lib/campaign');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

if (!process.env.ADMIN_PASSWORD) {
    process.env.ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url');
    console.warn('\n⚠  No hay ADMIN_PASSWORD en .env. Contraseña temporal para esta ejecución:');
    console.warn(`   ${process.env.ADMIN_PASSWORD}\n   Definila en .env para que sea fija.\n`);
}

const wa = new WhatsApp();
const campaign = new Campaign(wa);

const app = express();
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
});
app.use(express.json({ limit: '1mb' }));

// ---------- login (público) ----------

app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/styles.css', (req, res) => res.sendFile(path.join(__dirname, 'public', 'styles.css')));

app.post('/api/login', (req, res) => {
    if (auth.tooManyAttempts(req)) return res.status(429).json({ error: 'Demasiados intentos. Esperá 15 minutos.' });
    if (!auth.checkPassword(req.body?.password || '')) {
        auth.registerFail(req);
        return res.status(401).json({ error: 'Contraseña incorrecta' });
    }
    auth.clearFails(req);
    auth.setSessionCookie(req, res, auth.makeToken());
    res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
    auth.setSessionCookie(req, res, '');
    res.json({ ok: true });
});

// ---------- todo lo demás requiere sesión ----------

app.use(auth.requireAuth);
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

const wrap = fn => async (req, res) => {
    try {
        const out = await fn(req, res);
        if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// Eventos en vivo (Server-Sent Events)
const clients = new Set();
app.get('/api/events', (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(`event: status\ndata: ${JSON.stringify(campaign.status())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
});
function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
}
let statusTimer = null;
campaign.on('status', s => {
    // agrupa ráfagas de cambios
    if (statusTimer) return;
    statusTimer = setTimeout(() => { statusTimer = null; broadcast('status', campaign.status()); }, 150);
});
campaign.on('log', e => broadcast('log', e));
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000);

// Estado y campaña
app.get('/api/status', wrap(() => campaign.status()));
app.get('/api/logs', wrap(() => campaign.logs));
app.get('/api/campaign', wrap(() => campaign.campaignData()));
app.put('/api/campaign', wrap(req => { campaign.updateCampaign(req.body || {}); return campaign.campaignData(); }));
app.put('/api/settings', wrap(req => campaign.updateSettings(req.body || {})));
app.post('/api/preview', wrap(req => ({ text: buildMessage(String(req.body?.message ?? campaign.state.message), String(req.body?.name ?? 'Juan Pérez')) })));

// Imagen
const imageUpload = multer({
    storage: multer.diskStorage({
        destination: UPLOADS_DIR,
        filename: (req, file, cb) => cb(null, `img-${Date.now()}${path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')}`),
    }),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
        else cb(new Error('Sólo imágenes JPG, PNG o WEBP'));
    },
});
app.post('/api/campaign/image', (req, res) => {
    imageUpload.single('image')(req, res, err => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No se recibió la imagen' });
        campaign.setImage(req.file);
        res.json(campaign.campaignData());
    });
});
app.delete('/api/campaign/image', wrap(() => { campaign.removeImage(); return campaign.campaignData(); }));
app.get('/api/campaign/image', (req, res) => {
    const img = campaign.state.image;
    if (!img || !fs.existsSync(img.path)) return res.status(404).end();
    res.type(img.mimetype).sendFile(img.path);
});

// Contactos: paso 1 subir y analizar, paso 2 confirmar mapeo
const pendingImports = new Map();
const sheetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
app.post('/api/contacts/upload', (req, res) => {
    sheetUpload.single('file')(req, res, async err => {
        try {
            if (err) throw err;
            if (!req.file) throw new Error('No se recibió el archivo');
            const rows = await readRows(req.file.buffer, req.file.originalname);
            if (!rows.length) throw new Error('El archivo está vacío');
            const a = analyze(rows);
            const token = crypto.randomBytes(12).toString('hex');
            pendingImports.set(token, { ...a, fileName: req.file.originalname, at: Date.now() });
            for (const [k, v] of pendingImports) if (Date.now() - v.at > 30 * 60000) pendingImports.delete(k);
            res.json({
                token, fileName: req.file.originalname, headers: a.headers,
                rows: a.body.length, sample: a.body.slice(0, 8),
                phoneCol: a.phoneCol, nameCol: a.nameCol,
            });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });
});
app.post('/api/contacts/analyze', wrap(req => {
    const p = pendingImports.get(req.body?.token);
    if (!p) throw new Error('La carga expiró, subí el archivo de nuevo');
    const phoneCol = Number(req.body.phoneCol), nameCol = Number(req.body.nameCol);
    const r = buildContacts(p.body, phoneCol, nameCol, campaign.state.settings.countryCode);
    const inHistory = r.contacts.filter(c => campaign.history.has(c.number)).length;
    return { valid: r.contacts.length, invalid: r.invalid, duplicates: r.duplicates, inHistory, sample: r.contacts.slice(0, 5) };
}));
app.post('/api/contacts/import', wrap(req => {
    const p = pendingImports.get(req.body?.token);
    if (!p) throw new Error('La carga expiró, subí el archivo de nuevo');
    const phoneCol = Number(req.body.phoneCol), nameCol = Number(req.body.nameCol);
    if (!(phoneCol >= 0)) throw new Error('Elegí la columna del teléfono');
    const { contacts } = buildContacts(p.body, phoneCol, nameCol, campaign.state.settings.countryCode);
    const mode = req.body.mode === 'append' ? 'append' : 'replace';
    const out = campaign.importContacts(contacts, mode);
    campaign.state.source = { name: p.fileName, at: Date.now() };
    campaign.save();
    pendingImports.delete(req.body.token);
    return out;
}));
app.get('/api/contacts', wrap(req => campaign.listContacts(req.query)));
app.post('/api/contacts', wrap(req => ({ number: campaign.addContact(req.body?.number, req.body?.name) })));
app.delete('/api/contacts/:number', wrap(req => campaign.removeContact(req.params.number)));
app.patch('/api/contacts/:number', wrap(req => campaign.setContactStatus(req.params.number, req.body?.status)));
app.post('/api/contacts/retry-failed', wrap(() => ({ count: campaign.retryFailed() })));
app.post('/api/contacts/reset', wrap(() => campaign.resetProgress()));
app.post('/api/contacts/clear', wrap(() => campaign.clearContacts()));
app.post('/api/history/clear', wrap(() => campaign.clearHistory()));
app.get('/api/contacts/export', (req, res) => {
    const name = (campaign.state.name || 'campana').replace(/[^\w-]+/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}-resultados.csv"`);
    res.send(campaign.exportCsv());
});

// Control
app.post('/api/start', wrap(() => campaign.start()));
app.post('/api/pause', wrap(() => campaign.pause()));
app.post('/api/test', wrap(async req => ({ number: await campaign.sendTest(req.body?.number) })));
app.post('/api/wa/logout', wrap(async () => { campaign.pause('Campaña pausada: se desvinculó WhatsApp.'); await wa.logout(); }));
app.post('/api/wa/restart', wrap(async () => { await wa.restart(); }));
app.post('/api/wa/pair', wrap(async req => {
    const number = normalizeNumber(req.body?.number, campaign.state.settings.countryCode);
    if (!number) throw new Error('Número inválido');
    return { code: await wa.requestPairing(number), number };
}));

app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
});

app.listen(PORT, HOST, () => {
    console.log(`Panel disponible en http://${HOST}:${PORT}`);
    if (process.env.WA_DISABLED !== '1') wa.start();
});

async function shutdown() {
    console.log('Cerrando...');
    campaign.save();
    await wa.shutdown();
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
