# 📱 BunRadio en Termux (Android)

## Instalación manual

```bash
# Instalar dependencias
pkg install git curl ffmpeg

# Instalar Bun parcheado para Termux
curl -fsSL https://github.com/bd-loser/bun-termux/releases/latest/download/bun_1.3.14-patched_aarch64.deb -o $TMPDIR/bun.deb
dpkg -i $TMPDIR/bun.deb
chmod 755 $PREFIX/lib/bun-termux/bun
hash -r

# Clonar y ejecutar
git clone --depth 1 https://github.com/srsergi0/Buncaster.git ~/bunradio
cd ~/bunradio
bun install
bun run start
```

## Instalación automática

```bash
curl -fsSL https://raw.githubusercontent.com/srsergi0/Buncaster/main/install.sh | bash
source ~/.bashrc
bunradio
```

## Notas

- Puerto HTTP: **8080** (puerto estándar)
- Puerto RTMP: **1935** (funciona sin root)
- Host: **127.0.0.1** (Android bloquea 0.0.0.0)
- Agrega música: `cp /sdcard/Download/*.mp3 ~/musica/`
- OBS en Android: usa `rtmp://127.0.0.1:1935/live/TU_KEY`

## Exponer al público

Para que otros puedan escuchar desde internet, usa **serveo**:

```bash
# Instalar openssh (una sola vez)
pkg install openssh -y

# Exponer BunRadio (URL aleatoria)
ssh -R 80:localhost:8080 serveo.net

# O pedir una URL fija (primera vez autentica con Google/GitHub)
ssh -R miusuario:80:localhost:8080 serveo.net
```

Te da una URL tipo `https://xyz.serveo.net` (o `https://miusuario.serveo.net` si pediste una fija).

**URL fija:** serveo asigna subdominios de forma determinística, así que generalmente te da la misma URL al reconectar. Si pides uno específico con `-R miusuario:80:...`, queda reservado para tu cuenta.

**Para reconexión automática** (si se cae internet):

```bash
pkg install autossh -y
autossh -M 0 -o "ServerAliveInterval 30" -o "ServerAliveCountMax 3" -R miusuario:80:localhost:8080 serveo.net
```

### Para una radio 24/7

Los tunnels son temporales. Para una radio permanente necesitas:

- **VPS** (Hetzner, Oracle Free Tier, etc.) con nginx como reverse proxy
- **Cloudflare Tunnel** con dominio propio (gratis, permanente)
