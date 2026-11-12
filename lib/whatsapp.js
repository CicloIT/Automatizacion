const path = require('path');
const EventEmitter = require('events');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const AUTH_DIR = process.env.WWEBJS_AUTH_DIR
    ? path.resolve(process.env.WWEBJS_AUTH_DIR)
    : path.join(__dirname, '..', '.wwebjs_auth');

/**
 * Envuelve whatsapp-web.js. Estados:
 *  starting → qr → authenticated → ready
 *  disconnected (se reintenta solo)
 */
class WhatsApp extends EventEmitter {
    constructor() {
        super();
        this.client = null;
        this.status = 'stopped';
        this.qr = null;          // data URL del QR
        this.me = null;          // { number, name }
        this.lastError = null;
        this._restartTimer = null;
    }

    snapshot() {
        return { status: this.status, qr: this.qr, me: this.me, error: this.lastError };
    }

    _set(status, extra = {}) {
        this.status = status;
        Object.assign(this, extra);
        this.emit('change', this.snapshot());
    }

    isReady() {
        return this.status === 'ready';
    }

    async start() {
        clearTimeout(this._restartTimer);
        if (this.client) return;

        const puppeteer = {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        };
        if (process.env.CHROME_PATH) puppeteer.executablePath = process.env.CHROME_PATH;

        const client = new Client({ authStrategy: new LocalAuth({ dataPath: AUTH_DIR }), puppeteer });
        this.client = client;
        this._set('starting', { qr: null, lastError: null });

        client.on('qr', async qr => {
            try {
                const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 280 });
                this._set('qr', { qr: dataUrl });
            } catch (err) {
                this.emit('log', 'error', `No se pudo generar el QR: ${err.message}`);
            }
        });
        client.on('authenticated', () => this._set('authenticated', { qr: null }));
        client.on('ready', () => {
            const info = client.info || {};
            this._set('ready', {
                qr: null,
                me: { number: info.wid?.user || '', name: info.pushname || '' },
            });
            this.emit('log', 'ok', `WhatsApp conectado como ${info.pushname || ''} (+${info.wid?.user || '?'})`);
        });
        client.on('auth_failure', msg => {
            this.emit('log', 'error', `Fallo de autenticación: ${msg}. Desvinculá y escaneá el QR de nuevo.`);
            this._set('disconnected', { lastError: 'Fallo de autenticación' });
        });
        client.on('disconnected', reason => {
            this.emit('log', 'warn', `WhatsApp desconectado: ${reason}`);
            this._set('disconnected', { me: null, lastError: String(reason) });
            this._scheduleRestart();
        });

        try {
            await client.initialize();
        } catch (err) {
            this.emit('log', 'error', `Error iniciando WhatsApp: ${err.message}`);
            this._set('disconnected', { lastError: err.message });
            this._scheduleRestart();
        }
    }

    _scheduleRestart(ms = 10000) {
        clearTimeout(this._restartTimer);
        this._restartTimer = setTimeout(async () => {
            await this._destroy();
            this.start();
        }, ms);
    }

    async _destroy() {
        const c = this.client;
        this.client = null;
        if (c) {
            try { await c.destroy(); } catch { /* ignore */ }
        }
    }

    /** Desvincula el teléfono y genera un QR nuevo. */
    async logout() {
        if (this.client) {
            try { await this.client.logout(); } catch { /* ignore */ }
        }
        await this._destroy();
        this._set('stopped', { me: null, qr: null });
        this.emit('log', 'warn', 'Sesión de WhatsApp cerrada. Escaneá el QR para vincular otro teléfono.');
        this.start();
    }

    async shutdown() {
        clearTimeout(this._restartTimer);
        await this._destroy();
    }

    /**
     * Envía mensaje. Devuelve 'sent' o 'no_wa'. Lanza error si falla el envío.
     * @param {string} number sólo dígitos
     * @param {string} text
     * @param {{path:string, mimetype:string, originalName:string}|null} image
     */
    async send(number, text, image) {
        if (!this.isReady()) throw new Error('WhatsApp no está conectado');
        const id = await this.client.getNumberId(number);
        if (!id) return 'no_wa';
        if (image) {
            const media = MessageMedia.fromFilePath(image.path);
            if (image.mimetype) media.mimetype = image.mimetype;
            await this.client.sendMessage(id._serialized, media, { caption: text || undefined, sendSeen: false });
        } else {
            await this.client.sendMessage(id._serialized, text, { sendSeen: false });
        }
        return 'sent';
    }
}

module.exports = { WhatsApp };
