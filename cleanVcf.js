const fs = require('fs');
const path = require('path');

const VCF_PATH = path.join(__dirname, 'contacts.vcf');
const OUT_PATH = path.join(__dirname, 'contacts.vcf');
const BAK_PATH = path.join(__dirname, 'contacts.vcf.bak');

function normalizeNumber(raw) {
    let digits = raw.replace(/\D/g, '');
    if (digits.startsWith('0') && digits.length <= 11) {
        digits = '54' + digits.slice(1);
    }
    if (digits.length < 10) return null;
    return digits;
}

const content = fs.readFileSync(VCF_PATH, 'utf8');
const blocks = content.split(/(?=BEGIN:VCARD)/i).filter(b => b.trim().startsWith('BEGIN:VCARD'));

const seen = new Set();
const unique = [];
let dupes = 0;

for (const block of blocks) {
    const telMatches = [...block.matchAll(/^TEL[^:]*:(.+)$/gim)];
    let isDupe = false;

    for (const m of telMatches) {
        const norm = normalizeNumber(m[1].trim());
        if (norm) {
            if (seen.has(norm)) {
                isDupe = true;
                break;
            }
        }
    }

    if (!isDupe) {
        for (const m of telMatches) {
            const norm = normalizeNumber(m[1].trim());
            if (norm) seen.add(norm);
        }
        unique.push(block.trim());
    } else {
        dupes++;
    }
}

fs.copyFileSync(VCF_PATH, BAK_PATH);
fs.writeFileSync(OUT_PATH, unique.join('\n') + '\n', 'utf8');

console.log(`Original:   ${blocks.length} contactos`);
console.log(`Duplicados: ${dupes}`);
console.log(`Resultado:  ${unique.length} contactos únicos`);
console.log(`Backup:     contacts.vcf.bak`);
