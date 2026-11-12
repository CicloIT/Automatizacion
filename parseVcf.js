const fs = require('fs');

function normalizeNumber(raw) {
    // Strip +, spaces, dashes, parens — keep only digits
    let digits = raw.replace(/\D/g, '');

    // Local Argentine format (starts with 0): 03516082345 → 543516082345
    if (digits.startsWith('0') && digits.length <= 11) {
        digits = '54' + digits.slice(1);
    }

    if (digits.length < 10) return null;

    return digits;
}

function parseVcf(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const seen = new Set();
    const contacts = [];

    const cards = content.split(/END:VCARD/i).filter(c => c.trim());

    for (const card of cards) {
        const nameMatch = card.match(/^FN[;:](.+)$/im);
        const telMatches = [...card.matchAll(/^TEL[^:]*:(.+)$/gim)];

        // Limpiar nombre: quitar sufijos de duplicado como "(2)", "(3)", etc.
        let name = nameMatch ? nameMatch[1].trim() : 'Sin nombre';
        name = name.replace(/\s*\(\d+\)\s*$/, '').trim();

        for (const telMatch of telMatches) {
            const normalized = normalizeNumber(telMatch[1].trim());
            if (normalized && !seen.has(normalized)) {
                seen.add(normalized);
                contacts.push({ name, number: normalized });
            }
        }
    }

    return contacts;
}

module.exports = { parseVcf };
