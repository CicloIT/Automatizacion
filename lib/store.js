const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function filePath(name) {
    return path.join(DATA_DIR, name);
}

function loadJson(name, fallback) {
    const file = filePath(name);
    try {
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        console.error(`No se pudo leer ${name}: ${err.message}. Se usa valor por defecto.`);
        try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
    }
    return fallback;
}

// Escritura atómica: escribe a .tmp y renombra, así un corte de luz no deja el JSON roto.
function saveJson(name, data) {
    const file = filePath(name);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
}

module.exports = { DATA_DIR, UPLOADS_DIR, filePath, loadJson, saveJson };
