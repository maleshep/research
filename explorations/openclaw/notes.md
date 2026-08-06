# Notes — OpenClaw WhatsApp agent setup

## 2026-08-06 — Initial setup and configuration

- Verified Node v24.19.0 (>= 22 required). npm 11.17.0.
- No existing OpenClaw install on this machine (post-reimage clean slate).
- GLM-Vision confirmed running on HPC: job 2964551, node demu4xfat002, port 8116, model `glm-5.2-vision`, 1M context, sglang engine, status `serving`.
- Project layout created at `research/explorations/openclaw/`.
- Research findings: OpenClaw is real, 385k stars, foundation-governed. Native WhatsApp plugin via QR-pair. OpenAI-compatible backend.

### Install
- `curl --ssl-no-revoke -fsSL https://openclaw.ai/install.ps1 | iex` (PowerShell path; the bash installer rejects Windows)
- `NODE_TLS_REJECT_UNAUTHORIZED=0 openclaw plugins install clawhub:@openclaw/whatsapp` — TLS check disabled for corporate proxy self-signed cert.

### WhatsApp QR pairing — Windows workarounds required
- The `openclaw channels login --channel whatsapp` command failed with `Non-Error rejection` because the WhatsApp WebSocket closed immediately.
- Root cause: baileys (the WhatsApp Web library) couldn't fetch the latest WhatsApp Web version through the corporate proxy (self-signed cert), fell back to a stale version, WhatsApp rejected with HTTP 405.
- Fix: prefix any openclaw/baileys command with `NODE_TLS_REJECT_UNAUTHORIZED=0` so version fetch succeeds.
- QR rendering in the terminal is hard to scan — wrote `~/.openclaw/extensions/whatsapp/qr-to-png-live.mjs` to render QR as a PNG at `research/explorations/openclaw/whatsapp-qr.png` and open with Photos.
- First QR scan got "couldn't link the device" (515 stream error). Rewrote the probe to auto-reconnect on 515. Second scan succeeded.

### Plugin peer-link repair
- After installing `qrcode` to render the PNG, the WhatsApp plugin's peer-link audit failed ("missing-openclaw-peer-link").
- Couldn't create a symlink (Windows requires admin/developer mode), used a directory junction instead:
  `powershell New-Item -ItemType Junction -Path '~/.openclaw/extensions/whatsapp/node_modules/openclaw' -Target 'C:\Users\M316235\AppData\Local\Node\node_modules\openclaw'`

### Config
- `~/.openclaw/openclaw.json` (gitignored — contains WhatsApp session reference + ackReaction config).
- A template copy lives at `research/explorations/openclaw/config/openclaw.json` with `{{GLM_VISION_PORT}}` placeholder.
- Key config:
  - `gateway.mode: "local"`
  - `models.providers.hpc-glm.baseUrl: "http://localhost:8116/v1"` (GLM-Vision port — read from HPC fleet state)
  - `agents.defaults.model.primary: "hpc-glm/glm-5.2-vision"`
  - `channels.whatsapp.dmPolicy: "pairing"`, `allowFrom: ["+491784922644"]`
  - `channels.whatsapp.groupPolicy: "allowlist"`, `groups: { "4915218360719-1560169008@g.us": { requireMention: false } }` (the "Notes to Future Aman" group)
  - `channels.whatsapp.ackReaction: { emoji: "🤖", direct: true, group: "always" }` — reacts to every incoming message with 🤖, removes on reply
  - `agents.defaults.memorySearch.enabled: false` — disabled because no embedding model on HPC; can revisit by booting an embedding model if needed

### Doctor findings
- memory-core: loaded, provides `memory_search` and `memory_get` tools. `memory_search` requires an embedding backend (defaults to OpenAI), disabled since no embeddings endpoint available.
- 50 plugins loaded, 0 errors, 18 disabled (mostly other channel/provider plugins we don't use).
- No critical issues.

### Resource usage (passive)
- Disk: 81 MB total in `~/.openclaw/` (extensions 61M, credentials 16M with WhatsApp session + app-state-sync keys, state 3M SQLite). Grows slowly with conversations.
- RAM: ~450 MB working set when idle.

### Running the gateway
- Gateway runs as a background process on the workstation, listening on `127.0.0.1:18789`.
- NOT a Windows service — dies when you log out or reboot. To make always-on: would need a Windows service or scheduled task (not done).
- Required env: `NODE_TLS_REJECT_UNAUTHORIZED=0` (for baileys version fetch through corporate proxy).
- Required precondition: SSH tunnel to GLM-Vision port (run `scripts/tunnel.sh &`).
- Start command: `bash scripts/start.sh` (checks tunnel + config, then `openclaw gateway`).

### Port shuffling (HPC hot-swap)
- GLM-Vision port changes every 3-4 days. When it moves:
  1. `scripts/fleet-port.sh` — get the new port.
  2. Update `~/.openclaw/openclaw.json` `providers.hpc-glm.baseUrl` with the new port.
  3. Restart the gateway: kill the old process, re-run `openclaw gateway`.
  4. Re-open the SSH tunnel: `scripts/tunnel.sh &`.

### GitHub
- Repo renamed from `maleshep/scoop` to `maleshep/research` via GitHub API on 2026-08-06.
- Local remote updated to `https://github.com/maleshep/research.git`.
- Old `maleshep/scoop` URL auto-redirects.
