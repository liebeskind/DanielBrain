#!/bin/bash
cat > /etc/systemd/system/ollama.service.d/override.conf << 'CONF'
[Service]
  Environment="OLLAMA_HOST=0.0.0.0"
  Environment="OLLAMA_KEEP_ALIVE=24h"
  Environment="OLLAMA_MAX_LOADED_MODELS=3"
CONF
systemctl daemon-reload
systemctl restart ollama
echo "Done. Ollama restarted with NUM_PARALLEL removed, MAX_LOADED_MODELS=3"
