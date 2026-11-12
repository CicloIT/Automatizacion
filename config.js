const path = require('path');

// Mensaje fijo para todos. Opcional: usá {nombre} si querés personalizar.
// Si el contacto no tiene nombre y usás {nombre}, se omite esa parte.
const MESSAGE = `📡 Instalación de Starlink 
Llevá internet de alta velocidad donde lo necesites. Instalamos equipos Starlink Estándar y Mini X, con asesoramiento para elegir la mejor opción según tu uso.
✅ Instalación profesional
✅ Cobertura en toda la provincia
✅ Respaldo técnico ante cualquier consulta
📲 Consultanos y coordiná tu instalación. + 54 9 358 431 4857`;

const VCF_PATH = path.join(__dirname, 'contacts.vcf');

// Ruta a la imagen local. null = sin imagen.
const IMAGE_PATH = path.join(__dirname, 'image.jpg');

// Delay aleatorio entre mensajes (ms).
const DELAY_MIN_MS = 45000;   // 45 segundos
const DELAY_MAX_MS = 120000;  // 2 minutos

// Cada cuántos mensajes hacer una pausa larga
const BATCH_SIZE = 10;
const BATCH_PAUSE_MS = 20 * 60 * 1000; // 20 minutos

// Máximo de mensajes por ejecución (0 = sin límite)
const MAX_PER_SESSION = 20;

module.exports = { MESSAGE, VCF_PATH, IMAGE_PATH, DELAY_MIN_MS, DELAY_MAX_MS, BATCH_SIZE, BATCH_PAUSE_MS, MAX_PER_SESSION };
