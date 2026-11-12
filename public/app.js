'use strict';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

// ---------- utilidades ----------

async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {} };
    if (opts.body instanceof FormData) init.body = opts.body;
    else if (opts.body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(opts.body);
    }
    const r = await fetch(path, init);
    if (r.status === 401) { location.href = '/login.html'; throw new Error('Sesión expirada'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
    return data;
}

function toast(msg, err = false) {
    const el = document.createElement('div');
    el.className = 'toast' + (err ? ' err' : '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), err ? 6000 : 3500);
}

async function action(fn, okMsg) {
    try {
        const r = await fn();
        if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
        return r;
    } catch (e) {
        toast(e.message, true);
    }
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = t => new Date(t).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDate = t => t ? new Date(t).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// Igual que en el servidor (lib/campaign.js)
function buildMessage(template, name, seed) {
    let i = 0;
    let text = template.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, opts) => {
        const list = opts.split('|');
        return list[(seed + i++) % list.length];
    });
    const first = (name || '').trim().split(/\s+/)[0] || '';
    const clean = /\p{L}/u.test(first) ? first.toLowerCase().replace(/(^|-)(\p{L})/gu, (m, s, c) => s + c.toUpperCase()) : '';
    text = clean ? text.replace(/\{nombre\}/gi, clean) : text.replace(/[ \t]*\{nombre\}/gi, '');
    return text.replace(/[ \t]{2,}/g, ' ').trim();
}

// Formato de WhatsApp: *negrita* _cursiva_ ~tachado~ ```mono```
function waFormat(text) {
    return esc(text)
        .replace(/```([\s\S]+?)```/g, '<code>$1</code>')
        .replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=$|[\s.,!?)])/gm, '$1<b>$2</b>')
        .replace(/(^|[\s(])_(?!\s)([^_\n]+?)_(?=$|[\s.,!?)])/gm, '$1<i>$2</i>')
        .replace(/(^|[\s(])~(?!\s)([^~\n]+?)~(?=$|[\s.,!?)])/gm, '$1<s>$2</s>');
}

// ---------- tabs ----------

function showView(name) {
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
    $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
    try { localStorage.setItem('view', name); } catch { /* ignore */ }
    if (name === 'contactos') loadContacts();
}
$$('.tab').forEach(t => t.addEventListener('click', () => showView(t.dataset.view)));

// ---------- estado en vivo ----------

let status = null;
let campaign = null;

const PHASES = {
    idle: ['⏹', 'Detenida', ''],
    paused: ['⏸', 'Pausada', 'warn'],
    sending: ['📤', 'Enviando', 'ok'],
    waiting: ['⏳', 'En curso', 'ok'],
    batch_pause: ['☕', 'Pausa anti-bloqueo', 'info'],
    outside_hours: ['🌙', 'Fuera de horario', 'info'],
    daily_limit: ['📅', 'Límite diario alcanzado', 'info'],
    waiting_wa: ['📵', 'Esperando WhatsApp', 'warn'],
    done: ['✅', 'Campaña completada', 'ok'],
};

function renderStatus(s) {
    status = s;
    const c = s.counts;
    $('#sTotal').textContent = c.total;
    $('#sSent').textContent = c.sent;
    $('#sPending').textContent = c.pending;
    $('#sNoWa').textContent = c.no_wa;
    $('#sFailed').textContent = c.failed;
    const pct = n => c.total ? (n / c.total * 100) : 0;
    $('#pSent').style.width = pct(c.sent) + '%';
    $('#pNoWa').style.width = pct(c.no_wa) + '%';
    $('#pFailed').style.width = pct(c.failed) + '%';
    $('#pctText').textContent = `${Math.round(pct(c.total - c.pending))}% procesado`;
    $('#todayText').textContent = `${s.today} / ${s.dailyLimit}`;
    $('#campName').textContent = s.name;
    document.title = `${s.name} · Campañas WhatsApp`;

    const [icon, title, tone] = PHASES[s.phase] || PHASES.idle;
    $('#phaseIcon').textContent = icon;
    $('#phaseTitle').textContent = title;
    $('#phaseText').textContent = s.phaseText && s.phaseText !== title ? s.phaseText : '';
    const rp = $('#runPill');
    rp.textContent = s.running ? 'En curso' : (s.phase === 'done' ? 'Completada' : 'Detenida');
    rp.className = 'pill ' + (s.running ? 'ok' : '');

    $('#startBtn').disabled = s.running || c.pending === 0;
    $('#pauseBtn').disabled = !s.running;
    $('#retryBtn').disabled = c.failed === 0;
    $('#historySize').textContent = s.historySize;
    $('#tzText').textContent = s.tz;
    $('#sourceInfo').textContent = s.source ? `Última carga: ${s.source.name} (${fmtDate(s.source.at)}) — ${c.total} contactos en la lista.` : 'Todavía no cargaste contactos.';
    renderWa(s.wa);
    tickCountdown();
}

function renderWa(w) {
    const pill = $('#waPill');
    const map = {
        ready: ['ok', 'WhatsApp conectado'],
        qr: ['warn', 'Escanear QR'],
        pairing: ['warn', 'Ingresar código'],
        authenticated: ['info', 'Conectando…'],
        starting: ['info', 'Iniciando…'],
        disconnected: ['err', 'Desconectado'],
        stopped: ['', 'Detenido'],
    };
    const [cls, label] = map[w.status] || ['', w.status];
    pill.className = 'pill ' + cls;
    pill.textContent = label;

    // El formulario de código vive fuera de #waBody para no perder lo escrito cuando el QR se refresca
    $('#pairForm').hidden = w.status === 'ready' || w.status === 'pairing';

    const body = $('#waBody');
    const key = w.status + (w.qr || '') + (w.me?.number || '') + (w.pairing?.code || '');
    if (body.dataset.key === key) return;
    body.dataset.key = key;
    if (w.status === 'pairing' && w.pairing) {
        const pretty = '+' + w.pairing.number;
        body.innerHTML = `<div class="muted small">Código para ${esc(pretty)}</div>
            <div class="pair-code">${esc(w.pairing.code)}</div>
            <ol class="qr-steps">
                <li>En el teléfono: WhatsApp → ⋮ → <b>Dispositivos vinculados</b></li>
                <li><b>Vincular un dispositivo</b> → abajo: <b>Vincular con el número de teléfono</b></li>
                <li>Escribí el código. Vence en unos minutos.</li>
            </ol>
            <button class="btn sm" id="pairCancel">Volver al QR</button>`;
        $('#pairCancel').onclick = () => action(() => api('/api/wa/restart', { method: 'POST' }));
    } else if (w.status === 'ready') {
        body.innerHTML = `<div style="font-size:42px">✅</div>
            <div><b>${esc(w.me?.name || 'Conectado')}</b><div class="muted">+${esc(w.me?.number || '')}</div></div>`;
    } else if (w.status === 'qr' && w.qr) {
        body.innerHTML = `<img src="${w.qr}" alt="Código QR">
            <ol class="qr-steps"><li>Abrí WhatsApp en el teléfono</li><li>Menú ⋮ → <b>Dispositivos vinculados</b></li><li><b>Vincular dispositivo</b> y escaneá este código</li></ol>
            <div class="hint">El QR se renueva solo cada ~20 segundos.</div>`;
    } else if (w.status === 'disconnected') {
        body.innerHTML = `<div style="font-size:42px">⚠️</div><div class="muted">${esc(w.error || 'Desconectado')}<br>Reintentando solo…</div>`;
    } else {
        body.innerHTML = `<div style="font-size:42px">⏳</div><div class="muted">Conectando con WhatsApp…</div>`;
    }
}

$('#pairForm').addEventListener('submit', e => {
    e.preventDefault();
    const btn = $('#pairBtn');
    btn.disabled = true;
    btn.textContent = 'Generando…';
    action(() => api('/api/wa/pair', { method: 'POST', body: { number: $('#pairNumber').value } }),
        r => `Código generado para +${r.number}`)
        .finally(() => { btn.disabled = false; btn.textContent = 'Obtener código'; });
});

function tickCountdown() {
    const el = $('#countdown');
    if (!status?.nextAt || !status.running) { el.textContent = ''; return; }
    const sec = Math.max(0, Math.round((status.nextAt - Date.now()) / 1000));
    const m = Math.floor(sec / 60), s = sec % 60;
    el.textContent = `${m}:${String(s).padStart(2, '0')}`;
}
setInterval(tickCountdown, 1000);

function addLog(e, scroll = true) {
    const box = $('#log');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const div = document.createElement('div');
    div.className = e.level;
    div.innerHTML = `<time>${fmtTime(e.t)}</time>${esc(e.msg)}`;
    box.appendChild(div);
    while (box.children.length > 500) box.firstChild.remove();
    if (scroll && nearBottom) box.scrollTop = box.scrollHeight;
}
$('#clearLogView').onclick = () => { $('#log').innerHTML = ''; };

let refreshContacts = debounce(() => { if ($('#view-contactos').classList.contains('active')) loadContacts(); }, 800);

function connectEvents() {
    const es = new EventSource('/api/events');
    es.addEventListener('status', ev => { renderStatus(JSON.parse(ev.data)); refreshContacts(); });
    es.addEventListener('log', ev => addLog(JSON.parse(ev.data)));
    es.onerror = () => {
        // Si la sesión venció, EventSource no lo informa: verificamos
        fetch('/api/status').then(r => { if (r.status === 401) location.href = '/login.html'; });
    };
}

// ---------- panel: controles ----------

$('#startBtn').onclick = () => action(() => api('/api/start', { method: 'POST' }), 'Campaña iniciada');
$('#pauseBtn').onclick = () => action(() => api('/api/pause', { method: 'POST' }), 'Campaña pausada');
$('#retryBtn').onclick = () => action(() => api('/api/contacts/retry-failed', { method: 'POST' }), r => `${r.count} contactos vuelven a pendientes`);
$('#logoutBtn').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.href = '/login.html'; };

// ---------- mensaje ----------

let seed = 0;
const saveCampaign = debounce(async () => {
    $('#saveState').textContent = 'Guardando…';
    try {
        campaign = { ...campaign, ...(await api('/api/campaign', { method: 'PUT', body: { name: $('#nameInput').value, message: $('#msgInput').value } })) };
        $('#saveState').textContent = '✓ Guardado';
    } catch (e) {
        $('#saveState').textContent = '';
        toast(e.message, true);
    }
}, 700);

function renderPreview() {
    const text = buildMessage($('#msgInput').value, $('#previewName').value, seed);
    const img = campaign?.image ? `<img src="/api/campaign/image?v=${campaign.image.v}" alt="">` : '';
    const now = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    $('#bubble').innerHTML = img + (text ? `<div class="txt">${waFormat(text)}</div>` : '') + `<div class="meta">${now} ✓✓</div>`;
    const len = $('#msgInput').value.length;
    $('#charCount').textContent = ` ${len} caracteres.`;
}

function renderImageArea() {
    const area = $('#imgArea');
    if (campaign?.image) {
        const kb = Math.round(campaign.image.size / 1024);
        area.innerHTML = `<div class="img-preview">
            <img src="/api/campaign/image?v=${campaign.image.v}" alt="">
            <div class="stack" style="min-width:0">
                <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(campaign.image.originalName)} <span class="muted small">(${kb} KB)</span></div>
                <div class="row"><button class="btn sm" id="imgChange">Cambiar</button><button class="btn sm danger" id="imgRemove">Quitar</button></div>
            </div></div>`;
        $('#imgChange').onclick = () => $('#imgFile').click();
        $('#imgRemove').onclick = () => action(async () => {
            campaign = await api('/api/campaign/image', { method: 'DELETE' });
            renderImageArea(); renderPreview();
        }, 'Imagen quitada');
    } else {
        area.innerHTML = `<div class="dropzone" id="imgDrop"><div style="font-size:26px">🖼️</div><b>Arrastrá una imagen o hacé clic</b><div class="small">JPG, PNG o WEBP</div></div>`;
        setupDrop($('#imgDrop'), $('#imgFile'), uploadImage);
    }
}

async function uploadImage(file) {
    const fd = new FormData();
    fd.append('image', file);
    await action(async () => {
        campaign = await api('/api/campaign/image', { method: 'POST', body: fd });
        renderImageArea(); renderPreview();
    }, 'Imagen cargada');
}
$('#imgFile').onchange = e => { if (e.target.files[0]) uploadImage(e.target.files[0]); e.target.value = ''; };

function setupDrop(zone, input, handler) {
    zone.onclick = () => input.click();
    zone.ondragover = e => { e.preventDefault(); zone.classList.add('drag'); };
    zone.ondragleave = () => zone.classList.remove('drag');
    zone.ondrop = e => {
        e.preventDefault();
        zone.classList.remove('drag');
        if (e.dataTransfer.files[0]) handler(e.dataTransfer.files[0]);
    };
}

$('#msgInput').addEventListener('input', () => { renderPreview(); saveCampaign(); });
$('#nameInput').addEventListener('input', saveCampaign);
$('#previewName').addEventListener('input', renderPreview);
$('#reroll').onclick = () => { seed++; renderPreview(); };

function insertAtCursor(before, after = '') {
    const ta = $('#msgInput');
    const { selectionStart: a, selectionEnd: b, value } = ta;
    const sel = value.slice(a, b);
    ta.value = value.slice(0, a) + before + sel + after + value.slice(b);
    ta.focus();
    ta.selectionStart = a + before.length;
    ta.selectionEnd = a + before.length + sel.length;
    ta.dispatchEvent(new Event('input'));
}
$$('[data-wrap]').forEach(b => b.onclick = () => insertAtCursor(b.dataset.wrap, b.dataset.wrap));
$$('[data-insert]').forEach(b => b.onclick = () => insertAtCursor(b.dataset.insert));

$('#testBtn').onclick = () => {
    const n = $('#testNumber').value.trim();
    if (!n) return toast('Ingresá un número', true);
    $('#testBtn').disabled = true;
    action(() => api('/api/test', { method: 'POST', body: { number: n } }), r => `Prueba enviada a +${r.number}`)
        .finally(() => { $('#testBtn').disabled = false; });
};

// ---------- contactos ----------

const STATUS_LABEL = {
    pending: ['', 'Pendiente'], sent: ['ok', 'Enviado'], no_wa: ['', 'Sin WhatsApp'], failed: ['err', 'Falló'],
};
let cFilter = '', cPage = 1, cQuery = '';

async function loadContacts() {
    const q = new URLSearchParams({ status: cFilter, q: cQuery, page: cPage, size: 50 });
    let data;
    try { data = await api('/api/contacts?' + q); } catch (e) { return toast(e.message, true); }
    cPage = data.page;
    $('#tbody').innerHTML = data.items.length ? data.items.map(c => {
        const [cls, label] = STATUS_LABEL[c.status];
        return `<tr>
            <td>${esc(c.name) || '<span class="muted">—</span>'}</td>
            <td>+${esc(c.number)}</td>
            <td><span class="pill ${cls}">${label}</span></td>
            <td class="small muted">${fmtDate(c.at)}</td>
            <td class="err">${esc(c.error || '')}</td>
            <td class="row" style="flex-wrap:nowrap">
                ${c.status !== 'pending' ? `<button class="btn sm" data-requeue="${c.number}" title="Volver a pendiente">↻</button>` : ''}
                <button class="btn sm danger" data-del="${c.number}" title="Quitar de la lista">✕</button>
            </td></tr>`;
    }).join('') : `<tr><td colspan="6" class="muted" style="text-align:center;padding:30px">Sin contactos${cFilter || cQuery ? ' con ese filtro' : '. Cargá un Excel arriba.'}</td></tr>`;
    $('#pageInfo').textContent = `${data.total} contactos · página ${data.page} de ${data.pages}`;
    $('#prevPage').disabled = data.page <= 1;
    $('#nextPage').disabled = data.page >= data.pages;
}

$('#tbody').addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    const rq = e.target.closest('[data-requeue]');
    if (del) action(() => api(`/api/contacts/${del.dataset.del}`, { method: 'DELETE' }).then(loadContacts), 'Contacto quitado');
    if (rq) action(() => api(`/api/contacts/${rq.dataset.requeue}`, { method: 'PATCH', body: { status: 'pending' } }).then(loadContacts), 'Vuelve a pendiente');
});
$('#filters').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    $$('#filters .chip').forEach(c => c.classList.toggle('active', c === chip));
    cFilter = chip.dataset.status;
    cPage = 1;
    loadContacts();
});
$('#search').addEventListener('input', debounce(e => { cQuery = e.target.value.trim(); cPage = 1; loadContacts(); }, 300));
$('#prevPage').onclick = () => { cPage--; loadContacts(); };
$('#nextPage').onclick = () => { cPage++; loadContacts(); };

$('#addBtn').onclick = () => action(async () => {
    const r = await api('/api/contacts', { method: 'POST', body: { number: $('#addNumber').value, name: $('#addName').value } });
    $('#addNumber').value = ''; $('#addName').value = '';
    loadContacts();
    return r;
}, r => `Agregado +${r.number}`);

$('#resetBtn').onclick = () => {
    if (!confirm('¿Volver TODOS los contactos a "pendiente"? Se perderá el registro de a quién ya se envió en esta lista.')) return;
    action(() => api('/api/contacts/reset', { method: 'POST' }).then(loadContacts), 'Progreso reiniciado');
};
$('#clearBtn').onclick = () => {
    if (!confirm('¿Borrar toda la lista de contactos? No se puede deshacer.')) return;
    action(() => api('/api/contacts/clear', { method: 'POST' }).then(loadContacts), 'Lista borrada');
};

// Importación en dos pasos
let imp = null;
async function uploadSheet(file) {
    const fd = new FormData();
    fd.append('file', file);
    const r = await action(() => api('/api/contacts/upload', { method: 'POST', body: fd }));
    if (!r) return;
    imp = r;
    $('#impFile').textContent = r.fileName;
    $('#impRows').textContent = r.rows;
    const opts = r.headers.map((h, i) => `<option value="${i}">${esc(h)}</option>`).join('');
    $('#impPhone').innerHTML = opts;
    $('#impName').innerHTML = '<option value="-1">— Sin nombre —</option>' + opts;
    $('#impPhone').value = String(Math.max(0, r.phoneCol));
    $('#impName').value = String(r.nameCol);
    renderImportSample();
    analyzeImport();
    $('#importDialog').showModal();
}
function renderImportSample() {
    const pc = Number($('#impPhone').value), nc = Number($('#impName').value);
    const hl = i => i === pc ? ' style="background:var(--accent-soft)"' : i === nc ? ' style="background:var(--info-soft)"' : '';
    $('#impSample').innerHTML = `<thead><tr>${imp.headers.map((h, i) => `<th${hl(i)}>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${imp.sample.map(r => `<tr>${imp.headers.map((_, i) => `<td${hl(i)}>${esc(r[i] || '')}</td>`).join('')}</tr>`).join('')}</tbody>`;
}
async function analyzeImport() {
    $('#impResult').innerHTML = '<span class="muted">Analizando…</span>';
    try {
        const a = await api('/api/contacts/analyze', { method: 'POST', body: { token: imp.token, phoneCol: $('#impPhone').value, nameCol: $('#impName').value } });
        $('#impResult').innerHTML = `
            <span class="pill ok">${a.valid} números válidos</span>
            ${a.duplicates ? `<span class="pill">${a.duplicates} repetidos</span>` : ''}
            ${a.invalid ? `<span class="pill err">${a.invalid} inválidos/vacíos</span>` : ''}
            ${a.inHistory ? `<span class="pill info">${a.inHistory} ya recibieron campañas</span>` : ''}
            ${a.sample.length ? `<div class="small muted" style="width:100%">Ej: ${a.sample.map(c => `${esc(c.name || '—')} +${c.number}`).join(' · ')}</div>` : ''}`;
        $('#impConfirm').disabled = a.valid === 0;
    } catch (e) {
        $('#impResult').innerHTML = `<span class="pill err">${esc(e.message)}</span>`;
    }
}
$('#impPhone').onchange = $('#impName').onchange = () => { renderImportSample(); analyzeImport(); };
$('#impCancel').onclick = () => $('#importDialog').close();
$('#impConfirm').onclick = async () => {
    const mode = document.querySelector('input[name=impMode]:checked').value;
    const r = await action(() => api('/api/contacts/import', {
        method: 'POST', body: { token: imp.token, phoneCol: $('#impPhone').value, nameCol: $('#impName').value, mode },
    }));
    if (!r) return;
    $('#importDialog').close();
    toast(`${r.added} contactos importados${r.inHistory ? ` (${r.inHistory} omitidos por historial)` : ''}`);
    cPage = 1;
    loadContacts();
};
setupDrop($('#sheetDrop'), $('#sheetFile'), uploadSheet);
$('#sheetFile').onchange = e => { if (e.target.files[0]) uploadSheet(e.target.files[0]); e.target.value = ''; };

// ---------- ajustes ----------

const DAY_NAMES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
function renderSettings(s) {
    const f = $('#settingsForm');
    for (const k of ['delayMinSec', 'delayMaxSec', 'batchSize', 'batchPauseMin', 'dailyLimit', 'hourStart', 'hourEnd', 'countryCode']) f[k].value = s[k];
    f.skipHistory.checked = s.skipHistory;
    $('#days').innerHTML = [1, 2, 3, 4, 5, 6, 0].map(d =>
        `<label><input type="checkbox" value="${d}" ${s.days.includes(d) ? 'checked' : ''}>${DAY_NAMES[d]}</label>`).join('');
    updateRateHint();
}
function updateRateHint() {
    const f = $('#settingsForm');
    const avg = (Number(f.delayMinSec.value) + Number(f.delayMaxSec.value)) / 2;
    const bs = Number(f.batchSize.value) || 1;
    const perHour = 3600 / (avg + (Number(f.batchPauseMin.value) * 60) / bs);
    $('#rateHint').textContent = `≈ ${Math.round(perHour)} mensajes por hora. Recomendado para números nuevos: no más de 50 por día los primeros días.`;
}
$('#settingsForm').addEventListener('input', updateRateHint);
$('#settingsForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target;
    const body = {};
    for (const k of ['delayMinSec', 'delayMaxSec', 'batchSize', 'batchPauseMin', 'dailyLimit', 'hourStart', 'hourEnd']) body[k] = Number(f[k].value);
    body.countryCode = f.countryCode.value;
    body.skipHistory = f.skipHistory.checked;
    body.days = $$('#days input:checked').map(i => Number(i.value));
    action(async () => {
        const s = await api('/api/settings', { method: 'PUT', body });
        campaign.settings = s;
        renderSettings(s);
        $('#settingsState').textContent = '✓ Guardado';
        setTimeout(() => { $('#settingsState').textContent = ''; }, 2500);
    }, 'Ajustes guardados');
});
$('#clearHistory').onclick = e => {
    e.preventDefault();
    if (!confirm('¿Borrar el historial? Los números que ya recibieron campañas podrán volver a recibir.')) return;
    action(() => api('/api/history/clear', { method: 'POST' }), 'Historial borrado');
};
$('#waRestart').onclick = () => action(() => api('/api/wa/restart', { method: 'POST' }), 'Reiniciando conexión…');
$('#waLogout').onclick = () => {
    if (!confirm('¿Desvincular este teléfono? La campaña se pausará y tendrás que escanear un QR nuevo.')) return;
    action(() => api('/api/wa/logout', { method: 'POST' }), 'Teléfono desvinculado');
};

// ---------- inicio ----------

(async function init() {
    try {
        const [s, c, logs] = await Promise.all([api('/api/status'), api('/api/campaign'), api('/api/logs')]);
        campaign = c;
        renderStatus(s);
        $('#nameInput').value = c.name;
        $('#msgInput').value = c.message;
        renderImageArea();
        renderPreview();
        renderSettings(c.settings);
        logs.forEach(e => addLog(e, false));
        $('#log').scrollTop = $('#log').scrollHeight;
        connectEvents();
        let v = 'panel';
        try { v = localStorage.getItem('view') || 'panel'; } catch { /* ignore */ }
        if ($(`#view-${v}`)) showView(v);
    } catch (e) {
        toast(e.message, true);
    }
})();
