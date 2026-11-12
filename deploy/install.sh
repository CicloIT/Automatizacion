#!/usr/bin/env bash
# Instala o actualiza el panel de campañas WhatsApp en Ubuntu (22.04 / 24.04)
# y lo publica en internet con HTTPS (Caddy + Let's Encrypt) o con un túnel de Cloudflare.
#
# Uso (desde la carpeta del proyecto copiada al servidor):
#   sudo bash deploy/install.sh                                   # sólo el panel (local)
#   sudo DOMAIN=campanas.cicloit.com bash deploy/install.sh       # panel + HTTPS directo (IP pública)
#   sudo CF_TUNNEL_TOKEN=eyJ... bash deploy/install.sh            # panel + túnel Cloudflare
#   sudo TAILSCALE=1 bash deploy/install.sh                       # panel + Tailscale Funnel
#        (sin abrir puertos ni dominio: https://<TS_HOSTNAME>.<tu-red>.ts.net)
#        TS_HOSTNAME (default campanas), TS_AUTHKEY opcional para no loguearse a mano
#
# Contraseña del panel: se pregunta en la primera instalación (Enter = generar una).
# Para cambiarla después: sudo CHANGE_PASSWORD=1 bash deploy/install.sh
#
# Con DOMAIN: el registro DNS (A) del subdominio tiene que apuntar a la IP pública
# y el router tiene que reenviar los puertos 80 y 443 a este servidor.
#
# Para actualizar: copiar la carpeta nueva y volver a correr el script.
# No pisa data/, .env ni la sesión de WhatsApp (.wwebjs_auth/).
#
# Variables opcionales: APP_DIR (/opt/whatsapp-panel), APP_USER (whatsapp), PORT (3000), NODE_MAJOR (24)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/whatsapp-panel}"
APP_USER="${APP_USER:-whatsapp}"
PORT="${PORT:-3000}"
NODE_MAJOR="${NODE_MAJOR:-24}"
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE=whatsapp-panel
export DEBIAN_FRONTEND=noninteractive

if [ "$(id -u)" -ne 0 ]; then echo "Ejecutar con sudo"; exit 1; fi
if [ ! -f "$SRC_DIR/server.js" ]; then echo "No encuentro server.js en $SRC_DIR"; exit 1; fi

step() { echo; echo "==> $*"; }

# ---------------------------------------------------------------- Node.js
step "Node.js $NODE_MAJOR LTS"
CURRENT_MAJOR=0
command -v node >/dev/null && CURRENT_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$CURRENT_MAJOR" -lt "$NODE_MAJOR" ]; then
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh
    bash /tmp/nodesource_setup.sh
    rm -f /tmp/nodesource_setup.sh
    apt-get install -y nodejs
fi
NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm)"
echo "    node $(node -v) / npm $(npm -v)"

# ---------------------------------------------------------------- Chromium deps
step "Librerías de sistema para Chromium"
apt-get update -y
ASOUND=libasound2
apt-cache show libasound2t64 >/dev/null 2>&1 && ASOUND=libasound2t64
apt-get install -y --no-install-recommends \
    ca-certificates curl rsync fonts-liberation fonts-noto-color-emoji "$ASOUND" \
    libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 xdg-utils

# ---------------------------------------------------------------- Usuario y archivos
step "Usuario de servicio: $APP_USER"
id "$APP_USER" >/dev/null 2>&1 || \
    useradd --system --create-home --home-dir "/home/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"

step "Copiando aplicación a $APP_DIR"
mkdir -p "$APP_DIR"
FIRST_INSTALL=0
[ -f "$APP_DIR/server.js" ] || FIRST_INSTALL=1
if [ "$SRC_DIR" != "$APP_DIR" ]; then
    rsync -a --delete \
        --exclude node_modules --exclude .git --exclude .cache --exclude '*.bak' \
        --exclude graphify-out --exclude .claude --exclude .kombai \
        --exclude data --exclude .env --exclude .wwebjs_auth --exclude .wwebjs_cache \
        "$SRC_DIR/" "$APP_DIR/"
    # Sesión de WhatsApp y datos: sólo si en el destino todavía no existen
    if [ -d "$SRC_DIR/.wwebjs_auth" ] && [ ! -d "$APP_DIR/.wwebjs_auth" ]; then
        cp -a "$SRC_DIR/.wwebjs_auth" "$APP_DIR/"; echo "    Sesión de WhatsApp copiada"
    fi
    if [ -d "$SRC_DIR/data" ] && [ ! -f "$APP_DIR/data/campaign.json" ]; then
        mkdir -p "$APP_DIR/data" && cp -a "$SRC_DIR/data/." "$APP_DIR/data/"; echo "    Datos copiados"
    fi
fi
mkdir -p "$APP_DIR/data"

# Contraseña del panel: se pregunta en la primera instalación (o con CHANGE_PASSWORD=1).
# Enter vacío = se genera una aleatoria.
ask_password() {
    local p1 p2
    while true; do
        read -r -s -p "    Contraseña para entrar al panel (mín. 8, Enter = generar una): " p1 </dev/tty; echo >/dev/tty
        if [ -z "$p1" ]; then
            NEW_PASS="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
            GENERATED_PASS="$NEW_PASS"
            return
        fi
        if [ "${#p1}" -lt 8 ]; then echo "    Muy corta, mínimo 8 caracteres." >/dev/tty; continue; fi
        if [[ "$p1" =~ [[:space:]] ]]; then echo "    Sin espacios, por favor." >/dev/tty; continue; fi
        read -r -s -p "    Repetila: " p2 </dev/tty; echo >/dev/tty
        [ "$p1" = "$p2" ] && { NEW_PASS="$p1"; return; }
        echo "    No coinciden, probá de nuevo." >/dev/tty
    done
}

NEW_PASS="${ADMIN_PASSWORD:-}"
if [ -z "$NEW_PASS" ] && { [ ! -f "$APP_DIR/.env" ] || [ "${CHANGE_PASSWORD:-}" = 1 ]; }; then
    step "Contraseña del panel"
    if [ -r /dev/tty ]; then
        ask_password
    else
        NEW_PASS="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
        GENERATED_PASS="$NEW_PASS"
    fi
fi

if [ ! -f "$APP_DIR/.env" ]; then
    {
        printf 'ADMIN_PASSWORD=%s\n' "$NEW_PASS"
        printf 'PORT=%s\nHOST=127.0.0.1\nTZ_CAMPAIGN=America/Argentina/Cordoba\n' "$PORT"
    } > "$APP_DIR/.env"
elif [ -n "$NEW_PASS" ]; then
    NEW_PASS="$NEW_PASS" awk 'BEGIN{done=0}
        /^ADMIN_PASSWORD=/ { print "ADMIN_PASSWORD=" ENVIRON["NEW_PASS"]; done=1; next }
        { print }
        END { if (!done) print "ADMIN_PASSWORD=" ENVIRON["NEW_PASS"] }' "$APP_DIR/.env" > "$APP_DIR/.env.tmp"
    mv "$APP_DIR/.env.tmp" "$APP_DIR/.env"
    echo "    Contraseña actualizada"
fi
unset NEW_PASS
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/.env"
chmod 700 "$APP_DIR/data"

# ---------------------------------------------------------------- npm
step "Dependencias npm (descarga Chromium la primera vez, tarda unos minutos)"
systemctl stop "$SERVICE" 2>/dev/null || true
sudo -u "$APP_USER" -H env PUPPETEER_CACHE_DIR="$APP_DIR/.cache/puppeteer" \
    bash -c "cd '$APP_DIR' && '$NPM_BIN' ci --omit=dev --no-audit --no-fund"

# ---------------------------------------------------------------- systemd
step "Servicio systemd: $SERVICE"
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=Panel campañas WhatsApp
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PUPPETEER_CACHE_DIR=$APP_DIR/.cache/puppeteer
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=10
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

echo "    Esperando que el panel responda en 127.0.0.1:$PORT..."
OK=0
for _ in $(seq 1 45); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/login.html"; then OK=1; break; fi
    sleep 1
done
if [ "$OK" != 1 ]; then
    echo "    El panel no respondió. Revisá: journalctl -u $SERVICE -n 80 --no-pager"
    exit 1
fi
echo "    Panel OK"

# ---------------------------------------------------------------- HTTPS directo (Caddy)
if [ -n "${DOMAIN:-}" ]; then
    step "Caddy (HTTPS automático) para $DOMAIN"
    if ! command -v caddy >/dev/null; then
        apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gnupg
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
            | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
            > /etc/apt/sources.list.d/caddy-stable.list
        chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
        apt-get update -y
        apt-get install -y caddy
    fi
    [ -f /etc/caddy/Caddyfile ] && [ ! -f /etc/caddy/Caddyfile.orig ] && cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.orig
    cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    encode gzip
    header {
        Strict-Transport-Security "max-age=31536000"
        -Server
    }
    reverse_proxy 127.0.0.1:$PORT {
        # el registro en vivo (Server-Sent Events) necesita enviar sin buffer
        flush_interval -1
    }
}
EOF
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
    systemctl enable caddy >/dev/null
    systemctl reload caddy 2>/dev/null || systemctl restart caddy

    # Firewall: si ufw está activo, abrir 80/443 (no se activa ufw si estaba apagado)
    if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
        ufw allow 80/tcp >/dev/null
        ufw allow 443/tcp >/dev/null
        echo "    ufw: puertos 80 y 443 abiertos"
    fi

    PUBLIC_IP="$(curl -4 -fsS --max-time 5 https://ifconfig.me || echo '?')"
    DNS_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')"
    echo "    IP pública de este server: $PUBLIC_IP"
    echo "    $DOMAIN apunta a:      ${DNS_IP:-(sin registro DNS todavía)}"
    if [ "$PUBLIC_IP" != "${DNS_IP:-}" ]; then
        echo "    ATENCIÓN: el DNS todavía no apunta a este server. Creá el registro A"
        echo "    $DOMAIN -> $PUBLIC_IP. Caddy reintenta solo y saca el certificado cuando apunte."
    fi
fi

# ---------------------------------------------------------------- Tailscale Funnel
if [ -n "${TAILSCALE:-}" ]; then
    TS_HOSTNAME="${TS_HOSTNAME:-campanas}"
    step "Tailscale Funnel ($TS_HOSTNAME)"
    if ! command -v tailscale >/dev/null; then
        curl -fsSL https://tailscale.com/install.sh -o /tmp/tailscale-install.sh
        sh /tmp/tailscale-install.sh
        rm -f /tmp/tailscale-install.sh
    fi
    systemctl enable --now tailscaled >/dev/null
    if ! tailscale status >/dev/null 2>&1; then
        if [ -n "${TS_AUTHKEY:-}" ]; then
            tailscale up --hostname="$TS_HOSTNAME" --authkey="$TS_AUTHKEY"
        else
            echo
            echo "    >>> Abrí el link que aparece abajo en el navegador e iniciá sesión (Google/Microsoft/GitHub)."
            echo "    >>> El script sigue solo cuando termines."
            echo
            tailscale up --hostname="$TS_HOSTNAME"
        fi
    fi
    echo
    echo "    >>> Si aparece un link para habilitar Funnel, abrilo y aceptá. El script sigue solo."
    echo
    tailscale funnel --bg "$PORT"
    TS_URL="https://$(tailscale status --json | "$NODE_BIN" -pe 'JSON.parse(require("fs").readFileSync(0)).Self.DNSName.replace(/\.$/, "")')"
    # Detrás de Funnel la conexión es HTTPS: cookie de sesión con Secure
    grep -q '^COOKIE_SECURE=' "$APP_DIR/.env" || echo 'COOKIE_SECURE=1' >> "$APP_DIR/.env"
    systemctl restart "$SERVICE"

    # Verificar desde internet: desde esta máquina la dirección siempre anda (va por adentro de Tailscale),
    # así que se prueba contra el servidor público de Funnel resolviendo con DNS público.
    TS_HOST="${TS_URL#https://}"
    echo "    Verificando acceso público (hasta 2 minutos)..."
    TS_PUBLIC_OK=0
    for _ in $(seq 1 12); do
        PUB_IP="$(curl -fsS --max-time 5 -H 'accept: application/dns-json' \
            "https://cloudflare-dns.com/dns-query?name=$TS_HOST&type=A" 2>/dev/null \
            | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=(JSON.parse(s).Answer||[]).find(x=>x.type===1);process.stdout.write(a?a.data:"")}catch{}})' || true)"
        if [ -n "$PUB_IP" ] && curl -fsS -o /dev/null --max-time 10 \
            --resolve "$TS_HOST:443:$PUB_IP" "https://$TS_HOST/login.html"; then
            TS_PUBLIC_OK=1; break
        fi
        sleep 10
    done
    if [ "$TS_PUBLIC_OK" = 1 ]; then
        echo "    Acceso público OK"
    else
        echo
        echo "    ATENCIÓN: la dirección no responde desde internet."
        echo "    Falta el permiso de Funnel en la política de Tailscale:"
        echo "      https://login.tailscale.com/admin/acls  → agregar dentro del JSON:"
        echo '        "nodeAttrs": [ { "target": ["autogroup:member"], "attr": ["funnel"] } ],'
        echo "    Guardar, después: sudo tailscale funnel --bg $PORT"
        echo "    y probar desde el celular con datos móviles en unos minutos."
    fi
fi

# ---------------------------------------------------------------- Cloudflare Tunnel
if [ -n "${CF_TUNNEL_TOKEN:-}" ]; then
    step "Cloudflare Tunnel"
    if ! command -v cloudflared >/dev/null; then
        mkdir -p --mode=0755 /usr/share/keyrings
        curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
        echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
            > /etc/apt/sources.list.d/cloudflared.list
        apt-get update -y
        apt-get install -y cloudflared
    fi
    if [ -f /etc/systemd/system/cloudflared.service ]; then
        echo "    cloudflared ya está instalado como servicio, no se toca."
        echo "    Para cambiar de túnel: sudo cloudflared service uninstall y volver a correr este script."
    else
        cloudflared service install "$CF_TUNNEL_TOKEN"
    fi
    systemctl enable --now cloudflared >/dev/null 2>&1 || true
    sleep 3
    systemctl is-active --quiet cloudflared && echo "    Túnel activo" || echo "    Revisá: journalctl -u cloudflared -n 50 --no-pager"
fi

# ---------------------------------------------------------------- resumen
echo
echo "================================ LISTO ================================"
echo " Panel local:  http://127.0.0.1:$PORT   (servicio $SERVICE)"
if [ -n "${GENERATED_PASS:-}" ]; then
    echo " Contraseña:   $GENERATED_PASS"
    echo "               (generada automáticamente, guardada en $APP_DIR/.env — anotala)"
fi
echo " Cambiar contraseña: sudo CHANGE_PASSWORD=1 bash deploy/install.sh (con TAILSCALE=1 si lo usás)"
if [ -n "${TS_URL:-}" ]; then
    echo " Importante:   en https://login.tailscale.com/admin/machines → campanas → ⋮ → Disable key expiry"
fi
echo " Logs:         journalctl -u $SERVICE -f"
echo " Reiniciar:    sudo systemctl restart $SERVICE"
if [ -n "${TS_URL:-}" ]; then
    echo " Público:      $TS_URL"
    echo " Estado:       tailscale funnel status"
elif [ -n "${DOMAIN:-}" ]; then
    echo " Público:      https://$DOMAIN"
    echo " Logs HTTPS:   journalctl -u caddy -f"
elif [ -z "${CF_TUNNEL_TOKEN:-}" ]; then
    echo " Público:      no configurado (volver a correr con DOMAIN=... o CF_TUNNEL_TOKEN=...)"
fi
[ "$FIRST_INSTALL" = 1 ] && echo " Entrá al panel y escaneá el QR si la sesión de WhatsApp no vino copiada."
echo "======================================================================="
