#!/bin/bash
# Script de inicio nativo para CapCut Desktop
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Ejecutar el binario nativo de Electron directamente sin depender de variables de terminal
exec "$DIR/node_modules/electron/dist/electron" "$DIR" "$@"
