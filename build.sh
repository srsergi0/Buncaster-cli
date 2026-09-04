#!/bin/bash
# =============================================================
# BunRadio - Build para todas las plataformas
# =============================================================
# Uso: ./build.sh
# Output: ./dist/bunradio-{platform}-{arch}
# =============================================================

set -e

echo ""
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║        🔨  B U N R A D I O  B U I L D          ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo ""

# Crear carpeta de output
rm -rf dist
mkdir -p dist

# Detectar si Docker está disponible
USE_DOCKER=false
if command -v docker &> /dev/null; then
    USE_DOCKER=true
fi

# Función para compilar
build_binary() {
    local target=$1
    local output=$2
    local platform=$3
    
    echo "  ▸ Compilando ${platform}..."
    
    if [ "$USE_DOCKER" = true ]; then
        docker run --rm \
            -v "$(pwd):/app" \
            -w /app \
            oven/bun:alpine \
            sh -c "bun install --frozen-lockfile && bun build --compile --target=${target} --outfile=dist/${output} src/cli.ts"
    else
        # Cross-compile desde Bun local (bundler CLI via Inquirer.js)
        bun build --compile --target="${target}" --outfile="dist/${output}" src/cli.ts
    fi
    
    echo "    ✓ dist/${output}"
}

# =============================================================
# 1. LINUX x64 (el más común para servidores)
# =============================================================
build_binary "bun-linux-x64-modern" "bunradio-linux-x64" "Linux x64"

# =============================================================
# 2. LINUX ARM64 (Raspberry Pi, Mac M1+ Linux)
# =============================================================
build_binary "bun-linux-arm64" "bunradio-linux-arm64" "Linux ARM64"

# =============================================================
# 3. WINDOWS x64
# =============================================================
build_binary "bun-windows-x64-modern" "bunradio-windows-x64.exe" "Windows x64"

# =============================================================
# 4. macOS Intel (x64)
# =============================================================
build_binary "bun-darwin-x64" "bunradio-macos-x64" "macOS Intel"

# =============================================================
# 5. macOS Apple Silicon (M1/M2/M3)
# =============================================================
build_binary "bun-darwin-arm64" "bunradio-macos-arm64" "macOS Apple Silicon"

# =============================================================
# Resumen
# =============================================================
echo ""
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║              ✅ BUILD COMPLETADO                ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo ""
echo "  Archivos generados en ./dist/:"
echo ""
ls -lh dist/ | tail -n +2 | awk '{print "    " $9 " (" $5 ")"}'
echo ""
echo "  Tamaño total:"
du -sh dist/ | awk '{print "    " $1}'
echo ""
echo "  Uso:"
echo "    Linux:      ./dist/bunradio-linux-x64"
echo "    Windows:    .\\dist\\bunradio-windows-x64.exe"
echo "    macOS:      ./dist/bunradio-macos-arm64"
echo ""
