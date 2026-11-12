# Panel de campañas WhatsApp

Panel web para enviar campañas masivas (imagen + texto) por WhatsApp, con carga de contactos desde Excel, progreso guardado y controles anti-bloqueo.

## Qué hace

- **Panel**: estado en vivo (enviados, pendientes, sin WhatsApp, fallidos), cuenta regresiva al próximo envío, registro en vivo, iniciar / pausar, exportar resultados a CSV.
- **Conexión WhatsApp**: muestra el QR en la página para vincular el teléfono. La sesión queda guardada en `.wwebjs_auth/`.
- **Mensaje**: texto con `{nombre}`, variaciones al azar `{Hola|Buenas|Qué tal}`, negrita/cursiva de WhatsApp, imagen (JPG/PNG/WEBP), vista previa tipo WhatsApp y envío de prueba. Se guarda solo al escribir.
- **Contactos**: subir `.xlsx`, `.csv` o `.vcf`. Detecta solo las columnas de teléfono y nombre (se pueden corregir antes de importar), normaliza números argentinos (`0358 15 …`, `358…`, `+54 9 …` → `549…`), quita repetidos. Tabla con filtros, búsqueda, quitar o reencolar contactos.
- **Ajustes**: espera entre mensajes, pausa larga cada N mensajes, límite diario, horario y días de envío, no repetir a números de campañas anteriores.
- **Progreso persistente**: se guarda en `data/` después de cada envío. Si el servidor se reinicia con la campaña en curso, retoma sola. Si llega al límite diario o sale del horario, espera y sigue sola al día/horario siguiente.
- **Seguridad**: login con contraseña (cookie firmada, 7 días), límite de 5 intentos fallidos cada 15 min por IP. Se auto-pausa tras 3 errores seguidos.

## Instalación en el servidor (Ubuntu 22.04 / 24.04)

El script `deploy/install.sh` hace todo: instala **Node 24 LTS** (NodeSource, trae npm 11), las librerías que necesita Chromium,
crea el usuario `whatsapp`, copia la app a `/opt/whatsapp-panel`, genera la contraseña, instala dependencias, crea el servicio
systemd `whatsapp-panel` (arranca solo con la máquina y se reinicia si se cae) y lo publica en internet con HTTPS (Tailscale Funnel, subdominio propio o Cloudflare).

### 1. Llevar el proyecto al servidor

Desde esta PC, copiar la carpeta **sin `node_modules/`**. Ejemplo con scp (PowerShell, desde la carpeta del proyecto):

```powershell
scp -r server.js lib public deploy package.json package-lock.json .env.example .gitattributes README.md progress.json usuario@IP-DEL-SERVER:~/whatsapp-panel/
```

Para no volver a escanear el QR, copiar también `.wwebjs_auth` (mueve la sesión ya vinculada: después **no** usar más el panel ni el script viejo en esta PC):

```powershell
scp -r .wwebjs_auth usuario@IP-DEL-SERVER:~/whatsapp-panel/
```

### 2. Instalar y publicar con Tailscale Funnel (recomendado: sin puertos ni dominio)

```bash
cd ~/whatsapp-panel
sudo TAILSCALE=1 bash deploy/install.sh
```

Durante la instalación aparecen 1 o 2 links:
1. **Login de Tailscale**: abrirlo en cualquier navegador e iniciar sesión (Google, Microsoft o GitHub). Cuenta gratis.
2. **Habilitar Funnel** (sólo la primera vez): abrirlo y aceptar.

El script sigue solo y al final muestra la dirección pública fija, tipo `https://campanas.tailXXXX.ts.net`, y la **contraseña** del panel
(guardada en `/opt/whatsapp-panel/.env`). No hace falta abrir puertos en el router ni tener dominio; funciona aunque el campo tenga CGNAT.

Comandos: `tailscale funnel status` (ver dirección), `sudo tailscale funnel --https=443 off` (despublicar).

### Alternativa A: subdominio propio con IP pública (abre puertos)

1. **Router del campo**: reenviar (port forwarding) los puertos **80** y **443** TCP a la IP local del Ubuntu.
   Conviene fijarle IP local al Ubuntu (reserva DHCP en el router).
2. **DNS de cicloit.com** (donde lo administren hoy): crear un registro **A**
   `campanas` → la IP pública del campo (`curl -4 ifconfig.me` en el Ubuntu). No se toca nada más del dominio.
3. Si la IP pública del campo **cambia** cada tanto, avisar: hay que agregar actualización automática del DNS.

#### Instalar con subdominio

```bash
cd ~/whatsapp-panel
sudo DOMAIN=campanas.cicloit.com bash deploy/install.sh
```

Instala Caddy, que saca y renueva solo el certificado HTTPS (Let's Encrypt) y reenvía al panel.
Al final muestra la **contraseña** del panel (queda guardada en `/opt/whatsapp-panel/.env`) y avisa si el DNS todavía no apunta al server.
Entrar a `https://campanas.cicloit.com` y, si no se copió la sesión, escanear el QR.

El panel sigue escuchando sólo en `127.0.0.1:3000`; desde afuera únicamente se llega por Caddy (HTTPS).
Usar una contraseña larga: el login bloquea 15 minutos una IP tras 5 intentos fallidos.

### Alternativa B: Cloudflare Tunnel

Si algún día el campo queda sin IP pública (CGNAT) o se pasa el DNS de cicloit.com a Cloudflare:
crear el túnel en https://one.dash.cloudflare.com → Networks → Tunnels (Public hostname → `http://127.0.0.1:3000`),
copiar el token y correr `sudo CF_TUNNEL_TOKEN='eyJ...' bash deploy/install.sh`. Permite sumar Cloudflare Access delante del login.

### Actualizar a una versión nueva

Copiar los archivos nuevos a `~/whatsapp-panel` y volver a correr `sudo bash deploy/install.sh` (no pisa `data/`, `.env` ni la sesión).

### Comandos útiles

```bash
journalctl -u whatsapp-panel -f        # logs en vivo
sudo systemctl restart whatsapp-panel  # reiniciar
journalctl -u caddy -f                 # HTTPS / certificado
sudo nano /opt/whatsapp-panel/.env     # cambiar contraseña (después reiniciar)
```

## Desarrollo local

```bash
npm install
cp .env.example .env      # y editar ADMIN_PASSWORD
npm start                 # http://127.0.0.1:3000
```

Para probar sin tocar WhatsApp ni los datos reales: `WA_DISABLED=1 DATA_DIR=/tmp/prueba npm start`.

## Datos

Todo queda en `data/` (hacer backup de esta carpeta y de `.wwebjs_auth/`):

| Archivo | Contenido |
|---|---|
| `campaign.json` | mensaje, ajustes, contactos y estado de cada uno |
| `history.json` | números que ya recibieron alguna campaña (se importó `progress.json` viejo) |
| `log.json` | últimas 500 líneas del registro |
| `uploads/` | imagen de la campaña |
| `.secret` | clave para firmar las sesiones |

## Seguridad de dependencias

Node 24 LTS y Express 5. `npm audit` todavía marca avisos en paquetes internos que no tienen arreglo publicado:
`zod` (chromium-bidi de puppeteer), `extract-zip` (descarga de Chrome al instalar), `glob`/`minimatch` (zip de exceljs y RemoteAuth de whatsapp-web.js, que no se usa).
Ninguno procesa datos que lleguen desde la web. `uuid` y `basic-ftp` se fuerzan a versiones parcheadas con `overrides` en `package.json`.

## Script viejo

`npm run cli` sigue ejecutando el `index.js` original por consola. No correr los dos a la vez: comparten la sesión de WhatsApp.
