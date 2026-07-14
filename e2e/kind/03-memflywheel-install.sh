#!/bin/bash
# s6-overlay cont-init script: install memflywheel plugin into HERMES_HOME.
#
# Runs as root after 01-hermes-setup (which creates $HERMES_HOME and seeds
# config.yaml).  Installs the memflywheel memory-provider plugin and points
# Hermes at the mock LLM service.
set -eu

# Hermes Docker image sets HERMES_HOME=/opt/data.
# MUST export so child processes (Node.js install script) see it.
export HERMES_HOME="${HERMES_HOME:-/opt/data}"

echo "[memflywheel] Installing plugin into ${HERMES_HOME}/plugins/memflywheel ..."

# Pre-seed agent.disabled_toolsets in config.yaml so the install script can
# add 'memory' to the list.  The default template doesn't include this key.
CONFIG="${HERMES_HOME}/config.yaml"
if [ -f "$CONFIG" ] && ! grep -q "disabled_toolsets" "$CONFIG"; then
    # Use a temp file to avoid duplicate 'agent:' keys
    if grep -q "^agent:" "$CONFIG"; then
        # agent: exists — inject disabled_toolsets after it
        sed -i '/^agent:/a\  disabled_toolsets: []' "$CONFIG"
    else
        # No agent: key — prepend
        { echo "agent:"; echo "  disabled_toolsets: []"; cat "$CONFIG"; } > /tmp/cfg.tmp
        mv /tmp/cfg.tmp "$CONFIG"
    fi
    echo "[memflywheel] Added agent.disabled_toolsets to config.yaml"
fi

# Run the install script (installed globally from @iflytekopensource/hermes)
memflywheel-hermes-install || {
    echo "[memflywheel] ERROR: memflywheel-hermes-install failed"
    exit 1
}

# Ensure globally-installed Node modules are resolvable from the plugin dir.
# Node.js ESM import does NOT respect NODE_PATH — we need a real node_modules
# directory/symlink for the plugin to resolve @iflytekopensource/adapters.
PLUGIN_DIR="${HERMES_HOME}/plugins/memflywheel"
if [ -d "$PLUGIN_DIR" ]; then
    ln -sf /usr/local/lib/node_modules "${PLUGIN_DIR}/node_modules" 2>/dev/null || true
fi

# Update the model and memory config in $HERMES_HOME/config.yaml.
# `hermes config set` writes to a different location (.hermes/config.yaml),
# so we modify the YAML directly.
CONFIG="${HERMES_HOME}/config.yaml"
if [ -f "$CONFIG" ]; then
    python3 -c "
import yaml
with open('${CONFIG}') as f:
    cfg = yaml.safe_load(f) or {}
cfg.setdefault('model', {})
cfg['model']['default'] = 'mock-llm'
cfg['model']['provider'] = 'custom'
cfg['model']['base_url'] = 'http://mock-llm.default.svc.cluster.local:8080/v1'
cfg.setdefault('memory', {})
cfg['memory']['provider'] = 'memflywheel'
# Disable Hermes native memory toolset so the memflywheel plugin handles extraction
cfg.setdefault('agent', {})
cfg['agent']['disabled_toolsets'] = ['memory']
with open('${CONFIG}', 'w') as f:
    yaml.dump(cfg, f, default_flow_style=False)
print('[memflywheel] Config updated: model=mock-llm, memory.provider=memflywheel, disabled_toolsets=[memory]')
" || echo "[memflywheel] WARNING: Failed to update config.yaml"
fi

# Ensure the plugin directory is owned by hermes (we're running as root)
chown -R hermes:hermes "${HERMES_HOME}/plugins" 2>/dev/null || true

echo "[memflywheel] Plugin installed and configured successfully"
