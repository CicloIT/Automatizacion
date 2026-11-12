const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { loadJson, saveJson, UPLOADS_DIR } = require('./store');
const { normalizeNumber } = require('./contacts');

const TZ = process.env.TZ_CAMPAIGN || 'America/Argentina/Cordoba';

const DEFAULT_SETTINGS = {
    delayMinSec: 45,
    delayMaxSec: 120,
    batchSize: 10,
    batchPauseMin: 20,
    dailyLimit: 50,
    hourStart: 9,
    hourEnd: 20,
    days: [1, 2, 3, 4, 5, 6], // 0=domingo
    countryCode: '54',
    skipHistory: true,
};

const DEFAULT_STATE = {
    name: 'Campaña',
    message: '',
    image: null,
    settings: DEFAULT_SETTINGS,
    contacts: [],
    running: false,
    daily: { date: '', count: 0 },
    sinceBatch: 0,
    source: null,
};

const STATUSES = ['pending', 'sent', 'no_wa', 'failed'];

function nowParts() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    }).formatToParts(new Date());
    const get = t => parts.find(p => p.type === t)?.value;
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
    return {
        date: `${get('year')}-${get('month')}-${get('day')}`,
        hour: Number(get('hour')),
        minute: Number(get('minute')),
        weekday: wd,
    };
}

function titleCase(s) {
    return s.toLowerCase().replace(/(^|\s|-)(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
}

/** Reemplaza {nombre} y spintax {Hola|Buenas|Qué tal}. */
function buildMessage(template, name) {
    let text = template.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, opts) => {
        const list = opts.split('|');
        return list[Math.floor(Math.random() * list.length)];
    });
    const first = (name || '').trim().split(/\s+/)[0] || '';
    const cleanFirst = /\p{L}/u.test(first) ? titleCase(first) : '';
    if (cleanFirst) {
        text = text.replace(/\{nombre\}/gi, cleanFirst);
    } else {
        text = text.replace(/[ \t]*\{nombre\}/gi, '');
    }
    return text.replace(/[ \t]{2,}/g, ' ').trim();
}

function clampInt(v, min, max, def) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
}

class Campaign extends EventEmitter {
    constructor(wa) {
        super();
        this.wa = wa;
        this.state = { ...DEFAULT_STATE, ...loadJson('campaign.json', DEFAULT_STATE) };
        this.state.settings = { ...DEFAULT_SETTINGS, ...this.state.settings };
        this.history = new Set((loadJson('history.json', null) || this._migrateOldProgress())
            .map(n => normalizeNumber(n, this.state.settings.countryCode) || n));
        this.logs = loadJson('log.json', []);
        this.phase = this.state.running ? 'waiting_wa' : 'idle';
        this.phaseText = '';
        this.nextAt = null;
        this.current = null;
        this.consecutiveFails = 0;
        this._loopActive = false;
        this._timer = null;
        this._wake = null;
        this._saveLogTimer = null;

        wa.on('change', s => {
            if (s.status === 'ready' && this.phase === 'waiting_wa') this._interrupt();
            this._emitStatus();
        });
        wa.on('log', (level, msg) => this.log(level, msg));

        if (this.state.running) {
            this.log('info', 'El servidor se reinició con la campaña en curso: se reanuda automáticamente.');
            this._loop();
        }
    }

    // ---------- persistencia ----------

    _migrateOldProgress() {
        const old = path.join(__dirname, '..', 'progress.json');
        let list = [];
        try {
            if (fs.existsSync(old)) list = JSON.parse(fs.readFileSync(old, 'utf8'));
        } catch { /* ignore */ }
        saveJson('history.json', list);
        if (list.length) console.log(`Historial importado desde progress.json: ${list.length} números.`);
        return list;
    }

    save() {
        saveJson('campaign.json', this.state);
    }

    _saveHistory() {
        saveJson('history.json', [...this.history]);
    }

    log(level, msg) {
        const entry = { t: Date.now(), level, msg };
        this.logs.push(entry);
        if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
        this.emit('log', entry);
        clearTimeout(this._saveLogTimer);
        this._saveLogTimer = setTimeout(() => saveJson('log.json', this.logs), 1000);
    }

    // ---------- estado público ----------

    counts() {
        const c = { total: this.state.contacts.length, pending: 0, sent: 0, no_wa: 0, failed: 0 };
        for (const x of this.state.contacts) c[x.status]++;
        return c;
    }

    status() {
        this._rollDay();
        return {
            name: this.state.name,
            running: this.state.running,
            phase: this.phase,
            phaseText: this.phaseText,
            nextAt: this.nextAt,
            current: this.current,
            counts: this.counts(),
            today: this.state.daily.count,
            dailyLimit: this.state.settings.dailyLimit,
            source: this.state.source,
            historySize: this.history.size,
            hasImage: !!this.state.image,
            wa: this.wa.snapshot(),
            tz: TZ,
        };
    }

    campaignData() {
        return {
            name: this.state.name,
            message: this.state.message,
            image: this.state.image ? { originalName: this.state.image.originalName, size: this.state.image.size, v: this.state.image.v } : null,
            settings: this.state.settings,
        };
    }

    _emitStatus() {
        this.emit('status', this.status());
    }

    _setPhase(phase, text = '', nextAt = null) {
        this.phase = phase;
        this.phaseText = text;
        this.nextAt = nextAt;
        this._emitStatus();
    }

    // ---------- edición ----------

    _assertNotRunning(what) {
        if (this.state.running) throw new Error(`Pausá la campaña antes de ${what}`);
    }

    updateCampaign({ name, message }) {
        if (typeof name === 'string') this.state.name = name.slice(0, 120).trim() || 'Campaña';
        if (typeof message === 'string') {
            if (message.length > 4000) throw new Error('El mensaje es demasiado largo (máx. 4000 caracteres)');
            this.state.message = message;
        }
        this.save();
        this._emitStatus();
    }

    setImage(file) {
        this.removeImage(false);
        this.state.image = {
            path: file.path,
            mimetype: file.mimetype,
            originalName: file.originalname,
            size: file.size,
            v: Date.now(),
        };
        this.save();
        this._emitStatus();
    }

    removeImage(save = true) {
        const img = this.state.image;
        if (img && img.path && img.path.startsWith(UPLOADS_DIR)) {
            fs.promises.unlink(img.path).catch(() => {});
        }
        this.state.image = null;
        if (save) { this.save(); this._emitStatus(); }
    }

    updateSettings(input) {
        const s = { ...this.state.settings };
        s.delayMinSec = clampInt(input.delayMinSec, 5, 3600, s.delayMinSec);
        s.delayMaxSec = clampInt(input.delayMaxSec, s.delayMinSec, 7200, s.delayMaxSec);
        s.batchSize = clampInt(input.batchSize, 1, 1000, s.batchSize);
        s.batchPauseMin = clampInt(input.batchPauseMin, 0, 600, s.batchPauseMin);
        s.dailyLimit = clampInt(input.dailyLimit, 1, 5000, s.dailyLimit);
        s.hourStart = clampInt(input.hourStart, 0, 23, s.hourStart);
        s.hourEnd = clampInt(input.hourEnd, 0, 24, s.hourEnd);
        if (Array.isArray(input.days)) {
            s.days = [...new Set(input.days.map(Number).filter(d => d >= 0 && d <= 6))].sort();
        }
        if (input.countryCode !== undefined) {
            const cc = String(input.countryCode).replace(/\D/g, '');
            if (cc) s.countryCode = cc.slice(0, 4);
        }
        if (input.skipHistory !== undefined) s.skipHistory = !!input.skipHistory;
        this.state.settings = s;
        this.save();
        if (['outside_hours', 'daily_limit'].includes(this.phase)) this._interrupt();
        this._emitStatus();
        return s;
    }

    importContacts(list, mode) {
        this._assertNotRunning('cambiar los contactos');
        if (mode === 'replace') {
            this.state.contacts = [];
            this.state.sinceBatch = 0;
        }
        const existing = new Set(this.state.contacts.map(c => c.number));
        let added = 0, inHistory = 0, dup = 0;
        for (const c of list) {
            if (existing.has(c.number)) { dup++; continue; }
            if (this.state.settings.skipHistory && this.history.has(c.number)) { inHistory++; continue; }
            existing.add(c.number);
            this.state.contacts.push({ number: c.number, name: c.name || '', status: 'pending', at: null, error: null });
            added++;
        }
        this.save();
        this.log('info', `Contactos importados: ${added} nuevos${dup ? `, ${dup} ya estaban` : ''}${inHistory ? `, ${inHistory} omitidos por haber recibido campañas anteriores` : ''}.`);
        this._emitStatus();
        return { added, dup, inHistory, total: this.state.contacts.length };
    }

    addContact(rawNumber, name) {
        const number = normalizeNumber(rawNumber, this.state.settings.countryCode);
        if (!number) throw new Error('Número inválido');
        if (this.state.contacts.some(c => c.number === number)) throw new Error('Ese número ya está en la lista');
        this.state.contacts.push({ number, name: (name || '').trim(), status: 'pending', at: null, error: null });
        this.save();
        this._emitStatus();
        return number;
    }

    listContacts({ status, q, page = 1, size = 50 }) {
        let list = this.state.contacts;
        if (status && STATUSES.includes(status)) list = list.filter(c => c.status === status);
        if (q) {
            const needle = String(q).toLowerCase();
            list = list.filter(c => c.number.includes(needle) || (c.name || '').toLowerCase().includes(needle));
        }
        size = clampInt(size, 10, 500, 50);
        const pages = Math.max(1, Math.ceil(list.length / size));
        page = clampInt(page, 1, pages, 1);
        return { total: list.length, page, pages, items: list.slice((page - 1) * size, page * size) };
    }

    removeContact(number) {
        const i = this.state.contacts.findIndex(c => c.number === number);
        if (i === -1) throw new Error('Contacto no encontrado');
        if (this.current && this.current.number === number) throw new Error('Se está enviando a ese contacto ahora');
        this.state.contacts.splice(i, 1);
        this.save();
        this._emitStatus();
    }

    setContactStatus(number, status) {
        if (!STATUSES.includes(status)) throw new Error('Estado inválido');
        const c = this.state.contacts.find(x => x.number === number);
        if (!c) throw new Error('Contacto no encontrado');
        c.status = status;
        if (status === 'pending') { c.at = null; c.error = null; }
        this.save();
        this._emitStatus();
    }

    retryFailed() {
        let n = 0;
        for (const c of this.state.contacts) {
            if (c.status === 'failed') { c.status = 'pending'; c.error = null; n++; }
        }
        this.save();
        this.log('info', `${n} contactos fallidos vuelven a pendientes.`);
        this._emitStatus();
        return n;
    }

    resetProgress() {
        this._assertNotRunning('reiniciar el progreso');
        for (const c of this.state.contacts) { c.status = 'pending'; c.at = null; c.error = null; }
        this.state.sinceBatch = 0;
        this.save();
        this.log('warn', 'Progreso reiniciado: todos los contactos vuelven a pendientes.');
        this._emitStatus();
    }

    clearContacts() {
        this._assertNotRunning('borrar los contactos');
        this.state.contacts = [];
        this.state.sinceBatch = 0;
        this.state.source = null;
        this.save();
        this.log('warn', 'Lista de contactos borrada.');
        this._emitStatus();
    }

    clearHistory() {
        this.history.clear();
        this._saveHistory();
        this.log('warn', 'Historial de números de campañas anteriores borrado.');
        this._emitStatus();
    }

    exportCsv() {
        const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const label = { pending: 'Pendiente', sent: 'Enviado', no_wa: 'Sin WhatsApp', failed: 'Falló' };
        const lines = ['Nombre;Número;Estado;Fecha;Error'];
        for (const c of this.state.contacts) {
            lines.push([c.name, c.number, label[c.status], c.at ? new Date(c.at).toLocaleString('es-AR', { timeZone: TZ }) : '', c.error || ''].map(esc).join(';'));
        }
        return '﻿' + lines.join('\r\n');
    }

    async sendTest(rawNumber) {
        const number = normalizeNumber(rawNumber, this.state.settings.countryCode);
        if (!number) throw new Error('Número inválido');
        if (!this.state.message.trim() && !this.state.image) throw new Error('La campaña no tiene mensaje ni imagen');
        const text = buildMessage(this.state.message, 'Prueba');
        const r = await this.wa.send(number, text, this.state.image);
        if (r === 'no_wa') throw new Error(`El número +${number} no tiene WhatsApp`);
        this.log('ok', `Mensaje de prueba enviado a +${number}`);
        return number;
    }

    // ---------- motor de envío ----------

    start() {
        if (!this.state.message.trim() && !this.state.image) throw new Error('Cargá un mensaje o una imagen antes de iniciar');
        if (!this.state.contacts.some(c => c.status === 'pending')) throw new Error('No hay contactos pendientes');
        if (this.state.running) return;
        this.state.running = true;
        this.consecutiveFails = 0;
        this.save();
        this.log('info', 'Campaña iniciada.');
        this._loop();
    }

    pause(reason) {
        if (!this.state.running) return;
        this.state.running = false;
        this.save();
        this.log('warn', reason || 'Campaña pausada.');
        this._interrupt();
        this._setPhase('paused', reason || 'Pausada');
    }

    _sleep(ms) {
        return new Promise(resolve => {
            this._wake = resolve;
            this._timer = setTimeout(resolve, ms);
        });
    }

    _interrupt() {
        clearTimeout(this._timer);
        if (this._wake) { const w = this._wake; this._wake = null; w(); }
    }

    _rollDay() {
        const { date } = nowParts();
        if (this.state.daily.date !== date) {
            this.state.daily = { date, count: 0 };
            this.save();
        }
    }

    _inWindow() {
        const s = this.state.settings;
        const { hour, weekday } = nowParts();
        if (!s.days.includes(weekday)) return false;
        if (s.hourStart === s.hourEnd) return true;
        if (s.hourStart < s.hourEnd) return hour >= s.hourStart && hour < s.hourEnd;
        return hour >= s.hourStart || hour < s.hourEnd; // horario que cruza medianoche
    }

    _windowText() {
        const s = this.state.settings;
        const names = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
        const days = s.days.length === 7 ? 'todos los días' : s.days.map(d => names[d]).join(', ');
        return `Fuera del horario de envío (${days}, ${s.hourStart}:00 a ${s.hourEnd}:00)`;
    }

    async _loop() {
        if (this._loopActive) return;
        this._loopActive = true;
        try {
            while (this.state.running) {
                const s = this.state.settings;

                if (!this.wa.isReady()) {
                    this._setPhase('waiting_wa', 'Esperando conexión de WhatsApp');
                    await this._sleep(30000);
                    continue;
                }

                this._rollDay();
                if (!this._inWindow()) {
                    this._setPhase('outside_hours', this._windowText());
                    await this._sleep(60000);
                    continue;
                }

                if (this.state.daily.count >= s.dailyLimit) {
                    this._setPhase('daily_limit', `Límite diario alcanzado (${s.dailyLimit}). Continúa mañana.`);
                    await this._sleep(60000);
                    continue;
                }

                const contact = this.state.contacts.find(c => c.status === 'pending');
                if (!contact) {
                    this.state.running = false;
                    this.save();
                    this.log('ok', '🎉 Campaña completada: no quedan contactos pendientes.');
                    this._setPhase('done', 'Campaña completada');
                    break;
                }

                if (this.state.sinceBatch >= s.batchSize && s.batchPauseMin > 0) {
                    const ms = s.batchPauseMin * 60000;
                    this.log('info', `Pausa anti-bloqueo de ${s.batchPauseMin} min (cada ${s.batchSize} mensajes).`);
                    this._setPhase('batch_pause', `Pausa anti-bloqueo de ${s.batchPauseMin} min`, Date.now() + ms);
                    await this._sleep(ms);
                    if (!this.state.running) break;
                    this.state.sinceBatch = 0;
                    this.save();
                    continue;
                }

                await this._sendOne(contact);
                if (!this.state.running) break;

                if (this.consecutiveFails >= 3) {
                    this.pause('Campaña pausada automáticamente: 3 errores seguidos. Revisá la conexión de WhatsApp.');
                    break;
                }

                const delay = (Math.floor(Math.random() * (s.delayMaxSec - s.delayMinSec + 1)) + s.delayMinSec) * 1000;
                this._setPhase('waiting', 'Esperando para el próximo envío', Date.now() + delay);
                await this._sleep(delay);
            }
        } catch (err) {
            this.log('error', `Error inesperado en el motor: ${err.message}`);
            this.state.running = false;
            this.save();
            this._setPhase('paused', 'Detenida por error');
        } finally {
            this._loopActive = false;
            this.current = null;
            if (!this.state.running && !['done', 'paused'].includes(this.phase)) this._setPhase('idle');
        }
    }

    async _sendOne(contact) {
        this.current = { number: contact.number, name: contact.name };
        this._setPhase('sending', `Enviando a ${contact.name || '+' + contact.number}`);
        const text = buildMessage(this.state.message, contact.name);
        const label = `${contact.name || 'Sin nombre'} (+${contact.number})`;
        try {
            const r = await this.wa.send(contact.number, text, this.state.image);
            contact.at = Date.now();
            if (r === 'no_wa') {
                contact.status = 'no_wa';
                this.log('muted', `– ${label}: no tiene WhatsApp, se omite`);
            } else {
                contact.status = 'sent';
                contact.error = null;
                this.state.daily.count++;
                this.state.sinceBatch++;
                this.history.add(contact.number);
                this._saveHistory();
                const c = this.counts();
                this.log('ok', `✓ ${label} — hoy ${this.state.daily.count}/${this.state.settings.dailyLimit}, total ${c.sent}/${c.total}`);
            }
            this.consecutiveFails = 0;
        } catch (err) {
            contact.status = 'failed';
            contact.at = Date.now();
            contact.error = err.message.slice(0, 300);
            this.consecutiveFails++;
            this.log('error', `✗ ${label}: ${err.message}`);
        }
        this.current = null;
        this.save();
        this._emitStatus();
    }
}

module.exports = { Campaign, buildMessage, DEFAULT_SETTINGS };
