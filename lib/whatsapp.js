const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const QRCode = require('qrcode');
const pino = require('pino');
const { DATA_DIR } = require('./store');

// Sesión de WhatsApp (credenciales de Baileys). Va dentro de data/ para que entre en los backups.
const AUTH_DIR = process.env.WA_AUTH_DIR
    ? path.resolve(process.env.WA_AUTH_DIR)
    : path.join(DATA_DIR, 'wa-session');

const PAIRING_TTL_MS = 3 * 60 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Conexión a WhatsApp con Baileys (sin navegador).
 * Estados: stopped → starting → qr | pairing → ready ; disconnected (reintenta solo)
 * Eventos: 'change' (snapshot), 'log' (level, msg)
 */
class WhatsApp extends EventEmitter {
    constructor() {
        super();
        this.sock = null;
        this.status = 'stopped';
        this.qr = null;            // data URL del QR
        this.me = null;            // { number, name }
        this.lastError = null;
        this.pairing = null;       // { code, number, expiresAt }
        this._pendingPairing = null;
        this._baileys = null;
        this._starting = false;
        this._stopping = false;
        this._retries = 0;
        this._restartTimer = null;
        this.logger = pino({ level: process.env.WA_LOG_LEVEL || 'silent' });
    }

    snapshot() {
        return { status: this.status, qr: this.qr, me: this.me, error: this.lastError, pairing: this.pairing };
    }

    _set(status, extra = {}) {
        this.status = status;
        Object.assign(this, extra);
        this.emit('change', this.snapshot());
    }

    isReady() {
        return this.status === 'ready' && !!this.sock;
    }

    async _lib() {
        // Baileys 7 es ESM: se carga con import() dinámico desde CommonJS
        if (!this._baileys) this._baileys = await import('baileys');
        return this._baileys;
    }

    async start() {
        clearTimeout(this._restartTimer);
        if (this.sock || this._starting) return;
        this._starting = true;
        this._stopping = false;
        try {
            const B = await this._lib();
            fs.mkdirSync(AUTH_DIR, { recursive: true });
            const { state, saveCreds } = await B.useMultiFileAuthState(AUTH_DIR);

            let version;
            try { ({ version } = await B.fetchLatestBaileysVersion()); } catch { /* usa la versión por defecto */ }

            if (this.status !== 'qr' && this.status !== 'pairing') this._set('starting', { qr: null, lastError: null });

            const sock = B.default({
                auth: state,
                version,
                logger: this.logger,
                browser: B.Browsers.ubuntu('Chrome'),
                markOnlineOnConnect: false,
                syncFullHistory: false,
                generateHighQualityLinkPreview: false,
            });
            this.sock = sock;

            sock.ev.on('creds.update', saveCreds);
            sock.ev.on('connection.update', update => this._onUpdate(sock, update, B));
        } catch (err) {
            this.emit('log', 'error', `Error iniciando WhatsApp: ${err.message}`);
            this._set('disconnected', { lastError: err.message });
            this._scheduleRestart(15000);
        } finally {
            this._starting = false;
        }
    }

    async _onUpdate(sock, { connection, lastDisconnect, qr }, B) {
        if (sock !== this.sock) return; // evento de un socket viejo

        if (qr) {
            if (this._pendingPairing && !sock.authState.creds.registered) {
                const number = this._pendingPairing;
                this._pendingPairing = null;
                try {
                    const raw = await sock.requestPairingCode(number);
                    const code = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
                    this._set('pairing', { qr: null, pairing: { code, number, expiresAt: Date.now() + PAIRING_TTL_MS } });
                    this.emit('log', 'info', `Código de vinculación para +${number}: ${code}`);
                    this.emit('pairing', code);
                } catch (err) {
                    this.emit('log', 'error', `No se pudo generar el código: ${err.message}`);
                    this.emit('pairing-error', err);
                }
                return;
            }
            if (this.status === 'pairing' && this.pairing && this.pairing.expiresAt > Date.now()) return; // no tapar el código
            try {
                const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 280 });
                this._set('qr', { qr: dataUrl, pairing: null });
            } catch (err) {
                this.emit('log', 'error', `No se pudo generar el QR: ${err.message}`);
            }
        }

        if (connection === 'open') {
            this._retries = 0;
            const id = sock.user?.id || '';
            const number = id.split(':')[0].split('@')[0];
            this._set('ready', { qr: null, pairing: null, lastError: null, me: { number, name: sock.user?.name || sock.user?.notify || '' } });
            this.emit('log', 'ok', `WhatsApp conectado como ${this.me.name || ''} (+${number})`);
        }

        if (connection === 'close') {
            this.sock = null;
            if (this._stopping) return;
            const code = lastDisconnect?.error?.output?.statusCode;
            const R = B.DisconnectReason;

            if (code === R.loggedOut) {
                this.emit('log', 'warn', 'La sesión se cerró desde el teléfono. Vinculá de nuevo con QR o código.');
                this._wipeAuth();
                this._set('disconnected', { me: null, qr: null, pairing: null, lastError: 'Sesión cerrada' });
                this._scheduleRestart(2000);
            } else if (code === R.restartRequired) {
                // normal justo después de vincular: reconectar ya
                this._scheduleRestart(0);
            } else if (code === R.forbidden) {
                this.emit('log', 'error', 'WhatsApp rechazó la conexión (403). El número puede estar restringido o bloqueado.');
                this._set('disconnected', { me: null, lastError: 'Número restringido por WhatsApp (403)' });
                this._scheduleRestart(10 * 60000);
            } else if (code === R.connectionReplaced) {
                this.emit('log', 'warn', 'Otra conexión reemplazó a esta sesión (¿el panel corriendo en otra máquina?). Reintento en 1 min.');
                this._set('disconnected', { lastError: 'Sesión abierta en otro lugar' });
                this._scheduleRestart(60000);
            } else {
                const registered = sock.authState?.creds?.registered;
                if (!registered && this.status === 'pairing') {
                    this.emit('log', 'warn', 'El código de vinculación venció. Pedí uno nuevo.');
                    this.pairing = null;
                }
                const wait = Math.min(60000, 3000 * 2 ** Math.min(this._retries++, 5));
                if (registered) {
                    this.emit('log', 'warn', `Conexión perdida (${code || lastDisconnect?.error?.message || 'sin detalle'}). Reconectando…`);
                    this._set('disconnected', { lastError: 'Reconectando…' });
                }
                this._scheduleRestart(registered ? wait : 1000);
            }
        }
    }

    _scheduleRestart(ms) {
        clearTimeout(this._restartTimer);
        this._restartTimer = setTimeout(() => this.start(), ms);
    }

    async _close() {
        clearTimeout(this._restartTimer);
        const s = this.sock;
        this.sock = null;
        if (s) {
            this._stopping = true;
            try { s.end(undefined); } catch { /* ignore */ }
            await sleep(300);
            this._stopping = false;
        }
    }

    _wipeAuth() {
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    /** Genera un código de 8 caracteres para vincular desde el teléfono sin escanear QR. */
    async requestPairing(number) {
        if (this.isReady()) throw new Error('WhatsApp ya está conectado');
        const digits = String(number || '').replace(/\D/g, '');
        if (digits.length < 10 || digits.length > 15) throw new Error('Número inválido');

        await this._close();
        this._wipeAuth();
        this._pendingPairing = digits;
        this._set('starting', { qr: null, pairing: null, me: null, lastError: null });

        const result = new Promise((resolve, reject) => {
            const timer = setTimeout(() => { cleanup(); reject(new Error('WhatsApp no respondió a tiempo, probá de nuevo')); }, 30000);
            const ok = code => { cleanup(); resolve(code); };
            const fail = err => { cleanup(); reject(err); };
            const cleanup = () => { clearTimeout(timer); this.off('pairing', ok); this.off('pairing-error', fail); };
            this.on('pairing', ok);
            this.on('pairing-error', fail);
        });
        this.start();
        return result;
    }

    /** Desvincula el teléfono y muestra un QR nuevo. */
    async logout() {
        const s = this.sock;
        if (s) {
            this._stopping = true;
            try { await s.logout(); } catch { /* ignore */ }
        }
        await this._close();
        this._wipeAuth();
        this._set('stopped', { me: null, qr: null, pairing: null });
        this.emit('log', 'warn', 'Sesión de WhatsApp cerrada. Vinculá de nuevo con QR o código.');
        this.start();
    }

    async restart() {
        await this._close();
        this._pendingPairing = null;
        this.start();
    }

    async shutdown() {
        await this._close();
    }

    /**
     * Envía mensaje. Devuelve 'sent' o 'no_wa'. Lanza error si falla el envío.
     * @param {string} number sólo dígitos
     * @param {string} text
     * @param {{path:string, mimetype:string}|null} image
     */
    async send(number, text, image) {
        if (!this.isReady()) throw new Error('WhatsApp no está conectado');
        const sock = this.sock;
        const [res] = (await sock.onWhatsApp(number)) || [];
        if (!res || !res.exists) return 'no_wa';
        const jid = res.jid;

        // "escribiendo…" unos segundos: se parece más a una persona (anti-bloqueo)
        try {
            await sock.sendPresenceUpdate('composing', jid);
            await sleep(1500 + Math.random() * 2500);
            await sock.sendPresenceUpdate('paused', jid);
        } catch { /* no es crítico */ }

        if (image) {
            await sock.sendMessage(jid, {
                image: fs.readFileSync(image.path),
                mimetype: image.mimetype || 'image/jpeg',
                caption: text || undefined,
            });
        } else {
            await sock.sendMessage(jid, { text });
        }
        return 'sent';
    }
}

module.exports = { WhatsApp, AUTH_DIR };
