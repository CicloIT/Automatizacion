const path = require('path');
const ExcelJS = require('exceljs');

const PHONE_HEADER = /(tel|cel|phone|movil|móvil|m[oó]vil|n[uú]mero|numero|whats|wsp|wpp|contacto)/i;
const NAME_HEADER = /(nombre|name|cliente|razon|razón|apellido)/i;

/**
 * Normaliza un número a formato internacional sólo dígitos (ej: 5493584314857).
 * Devuelve null si no parece un número válido.
 */
function normalizeNumber(raw, countryCode = '54') {
    if (raw === null || raw === undefined) return null;
    let digits = String(raw).replace(/\D/g, '');
    if (!digits) return null;

    if (digits.startsWith('00')) digits = digits.slice(2);

    if (countryCode === '54') {
        // Formato local con 0 y 15: 0358 15 4314857 → 549 358 4314857
        if (digits.startsWith('0')) {
            let local = digits.slice(1);
            if (local.length === 12) {
                for (const areaLen of [2, 3, 4]) {
                    if (local.substr(areaLen, 2) === '15') {
                        local = local.slice(0, areaLen) + local.slice(areaLen + 2);
                        digits = '549' + local;
                        break;
                    }
                }
            }
            if (digits.startsWith('0')) digits = '54' + local;
        } else if (digits.length === 10) {
            // 3584314857 (sin código de país)
            digits = '54' + digits;
        }
    } else if (digits.startsWith('0')) {
        digits = countryCode + digits.slice(1);
    }

    // Móviles argentinos en WhatsApp siempre son 549 + área + número
    if (countryCode === '54' && digits.length === 12 && digits.startsWith('54') && !digits.startsWith('549')) {
        digits = '549' + digits.slice(2);
    }

    if (digits.length < 10 || digits.length > 15) return null;
    return digits;
}

function cellToText(cell) {
    const v = cell.value;
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
    if (typeof v === 'object') {
        if (v.richText) return v.richText.map(r => r.text).join('');
        if (v.text !== undefined) return String(v.text);
        if (v.result !== undefined) return String(v.result);
        if (v instanceof Date) return v.toISOString().slice(0, 10);
    }
    return String(cell.text ?? v);
}

async function parseXlsx(buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets.find(s => s.actualRowCount > 0) || wb.worksheets[0];
    if (!ws) return [];
    const rows = [];
    ws.eachRow({ includeEmpty: false }, row => {
        const arr = [];
        row.eachCell({ includeEmpty: true }, (cell, col) => {
            arr[col - 1] = cellToText(cell).trim();
        });
        for (let i = 0; i < arr.length; i++) if (arr[i] === undefined) arr[i] = '';
        rows.push(arr);
    });
    return rows;
}

function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/)[0] || '';
    const delim = [';', ',', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (ch === '"') inQuotes = false;
            else field += ch;
        } else if (ch === '"') inQuotes = true;
        else if (ch === delim) { row.push(field.trim()); field = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            row.push(field.trim()); field = '';
            if (row.some(f => f)) rows.push(row);
            row = [];
        } else field += ch;
    }
    row.push(field.trim());
    if (row.some(f => f)) rows.push(row);
    return rows;
}

function parseVcfText(text) {
    const rows = [['Nombre', 'Teléfono']];
    const cards = text.split(/END:VCARD/i).filter(c => c.trim());
    for (const card of cards) {
        const nameMatch = card.match(/^FN[;:](.+)$/im);
        let name = nameMatch ? nameMatch[1].trim() : '';
        name = name.replace(/\s*\(\d+\)\s*$/, '').trim();
        for (const tel of card.matchAll(/^TEL[^:]*:(.+)$/gim)) {
            rows.push([name, tel[1].trim()]);
        }
    }
    return rows;
}

/** Lee el archivo subido y devuelve filas (array de arrays de texto). */
async function readRows(buffer, originalName) {
    const ext = path.extname(originalName || '').toLowerCase();
    if (ext === '.xlsx' || ext === '.xlsm') return parseXlsx(buffer);
    if (ext === '.csv' || ext === '.txt') return parseCsv(buffer.toString('utf8'));
    if (ext === '.vcf') return parseVcfText(buffer.toString('utf8'));
    if (ext === '.xls') throw new Error('El formato .xls (Excel 97-2003) no está soportado. Abrilo en Excel y guardalo como .xlsx');
    throw new Error(`Formato no soportado (${ext || 'sin extensión'}). Usá .xlsx, .csv o .vcf`);
}

function looksLikePhone(v) {
    const d = String(v || '').replace(/\D/g, '');
    return d.length >= 8 && d.length <= 15;
}

/** Detecta si la primera fila es encabezado y qué columnas son teléfono / nombre. */
function analyze(rows) {
    const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const first = rows[0] || [];
    const hasHeader = first.some(h => PHONE_HEADER.test(h) || NAME_HEADER.test(h)) && !first.some(looksLikePhone);

    const headers = [];
    for (let i = 0; i < width; i++) {
        headers.push(hasHeader && first[i] ? first[i] : `Columna ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}`);
    }
    const body = hasHeader ? rows.slice(1) : rows;

    let phoneCol = hasHeader ? headers.findIndex(h => PHONE_HEADER.test(h)) : -1;
    if (phoneCol === -1 || !body.slice(0, 50).some(r => looksLikePhone(r[phoneCol]))) {
        // Elegir la columna con más valores que parecen teléfono
        let best = -1, bestScore = 0;
        for (let c = 0; c < width; c++) {
            const score = body.slice(0, 200).filter(r => looksLikePhone(r[c])).length;
            if (score > bestScore) { best = c; bestScore = score; }
        }
        phoneCol = best;
    }

    let nameCol = hasHeader ? headers.findIndex((h, i) => i !== phoneCol && NAME_HEADER.test(h)) : -1;
    if (nameCol === -1) {
        // Primera columna con texto no numérico
        nameCol = headers.findIndex((_, c) => c !== phoneCol &&
            body.slice(0, 50).some(r => r[c] && /[a-záéíóúñ]/i.test(r[c]) && !looksLikePhone(r[c])));
    }

    return { headers, body, phoneCol, nameCol };
}

/** Convierte filas en contactos únicos. */
function buildContacts(body, phoneCol, nameCol, countryCode, existing = new Set()) {
    const seen = new Set(existing);
    const contacts = [];
    let invalid = 0, duplicates = 0;
    for (const r of body) {
        const rawPhone = r[phoneCol];
        if (!rawPhone) { invalid++; continue; }
        const parts = String(rawPhone).split(/[\/|;,]| y | - (?=\+?\d)/).filter(p => p.trim());
        let any = false;
        for (const part of parts) {
            const number = normalizeNumber(part, countryCode);
            if (!number) continue;
            any = true;
            if (seen.has(number)) { duplicates++; continue; }
            seen.add(number);
            const name = nameCol >= 0 ? String(r[nameCol] || '').trim() : '';
            contacts.push({ number, name });
        }
        if (!any) invalid++;
    }
    return { contacts, invalid, duplicates };
}

module.exports = { normalizeNumber, readRows, analyze, buildContacts };
