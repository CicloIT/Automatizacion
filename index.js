const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { parseVcf } = require('./parseVcf');
const { MESSAGE, VCF_PATH, IMAGE_PATH, DELAY_MIN_MS, DELAY_MAX_MS, BATCH_SIZE, BATCH_PAUSE_MS, MAX_PER_SESSION } = require('./config');

const PROGRESS_FILE = path.join(__dirname, 'progress.json');

const randomDelay = () => {
    const ms = Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS + 1)) + DELAY_MIN_MS;
    return new Promise(resolve => setTimeout(resolve, ms));
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const buildMessage = (template, name) => {
    const hasName = name && name !== 'Sin nombre';
    if (!hasName) {
        return template.replace(/\{nombre\}\s*/gi, '').replace(/\s{2,}/g, ' ').trim();
    }
    return template.replace(/{nombre}/gi, name.split(' ')[0]);
};

function loadProgress() {
    if (fs.existsSync(PROGRESS_FILE)) {
        return new Set(JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')));
    }
    return new Set();
}

function saveProgress(sent) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify([...sent]), 'utf8');
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', qr => {
    console.log('\nEscaneá este QR con tu WhatsApp (Dispositivos vinculados → Vincular dispositivo):\n');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    console.log('Autenticado. Cargando WhatsApp...');
});

client.on('ready', async () => {
    console.log('WhatsApp listo.\n');

    let media = null;
    if (IMAGE_PATH && fs.existsSync(IMAGE_PATH)) {
        media = MessageMedia.fromFilePath(IMAGE_PATH);
        console.log(`Imagen cargada: ${IMAGE_PATH}`);
    } else if (IMAGE_PATH) {
        console.warn(`Advertencia: imagen no encontrada en ${IMAGE_PATH}. Se enviará solo texto.`);
    }

    let allContacts;
    try {
        allContacts = parseVcf(VCF_PATH);
    } catch (err) {
        console.error(`Error leyendo VCF: ${err.message}`);
        process.exit(1);
    }

    // Filtrar ya enviados
    const alreadySent = loadProgress();
    const pending = allContacts.filter(c => !alreadySent.has(c.number));

    const limit = MAX_PER_SESSION > 0 ? Math.min(MAX_PER_SESSION, pending.length) : pending.length;
    const batch = pending.slice(0, limit);

    console.log(`Contactos únicos en VCF:  ${allContacts.length}`);
    console.log(`Ya enviados (sesiones ant): ${alreadySent.size}`);
    console.log(`Pendientes:               ${pending.length}`);
    console.log(`Enviando esta sesión:      ${limit}`);
    console.log(`Delay: ${DELAY_MIN_MS / 1000}s–${DELAY_MAX_MS / 1000}s | Pausa ${BATCH_PAUSE_MS / 60000}min cada ${BATCH_SIZE} msgs`);
    console.log(`\nMensaje:\n---\n${MESSAGE}\n---\n`);

    if (batch.length === 0) {
        console.log('No hay contactos pendientes. Campaña completada.');
        await client.destroy();
        process.exit(0);
    }

    console.log('Iniciando envío...\n');

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (let i = 0; i < batch.length; i++) {
        const contact = batch[i];

        if (i > 0 && i % BATCH_SIZE === 0) {
            console.log(`\n--- Pausa de ${BATCH_PAUSE_MS / 60000} min (anti-ban) ---\n`);
            await sleep(BATCH_PAUSE_MS);
        }

        let numberId = null;
        try {
            numberId = await client.getNumberId(contact.number);
        } catch {
            numberId = null;
        }

        if (!numberId) {
            console.log(`- ${contact.name} (${contact.number}): sin WhatsApp, omitido`);
            skipped++;
            // Marcar como procesado para no reintentar en futuras sesiones
            alreadySent.add(contact.number);
            saveProgress(alreadySent);
            continue;
        }

        const message = buildMessage(MESSAGE, contact.name);

        try {
            if (media) {
                await client.sendMessage(numberId._serialized, media, { caption: message, sendSeen: false });
            } else {
                await client.sendMessage(numberId._serialized, message, { sendSeen: false });
            }
            console.log(`✓ [${i + 1}/${batch.length}] ${contact.name} (${contact.number})`);
            alreadySent.add(contact.number);
            saveProgress(alreadySent);
            sent++;
        } catch (err) {
            console.error(`✗ ${contact.name} (${contact.number}): ${err.message}`);
            failed++;
        }

        await randomDelay();
    }

    const totalRemaining = pending.length - batch.length;
    console.log(`\n=== Resumen sesión ===`);
    console.log(`Enviados:   ${sent}`);
    console.log(`Sin WA:     ${skipped}`);
    console.log(`Fallidos:   ${failed}`);
    console.log(`Restantes:  ${totalRemaining}`);
    if (totalRemaining > 0) {
        console.log(`\nCorré de nuevo mañana para continuar (${totalRemaining} pendientes).`);
    } else {
        console.log('\nCampaña completada.');
    }

    await client.destroy();
    process.exit(0);
});

client.on('auth_failure', () => {
    console.error('Fallo de autenticacion. Borra .wwebjs_auth y volvé a escanear el QR.');
    process.exit(1);
});

client.on('disconnected', reason => {
    console.error(`Desconectado: ${reason}`);
    process.exit(1);
});

console.log('Iniciando cliente WhatsApp...');
client.initialize();
