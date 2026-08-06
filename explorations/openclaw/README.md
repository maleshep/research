# OpenClaw — WhatsApp agent backed by GLM-5.2-Vision on HPC

A self-hosted WhatsApp agent: Aman messages WhatsApp → OpenClaw gateway routes the message → GLM-5.2-Vision on oneHPC generates the response → reply lands back on WhatsApp.

## Architecture

```
WhatsApp (Aman's phone)
    ↕
OpenClaw gateway (local daemon, 127.0.0.1:18789)
    ↕ @openclaw/whatsapp plugin (QR-paired)
    ↕
SSH tunnel: localhost:8116 → demu4xfat002:8116 (oneHPC)
    ↕
GLM-5.2-Vision (sglang, 8× B200, 1M ctx)
```

No Anthropic/OpenAI API calls. All inference on-prem.

## Status (2026-08-06)

- ✅ Gateway running, WhatsApp paired, GLM-Vision replying
- ✅ Responds to DMs from `+491784922644`
- ✅ Responds to ALL messages in the "Notes to Future Aman" group (`4915218360719-1560169008@g.us`)
- ✅ 🤖 ackReaction on every incoming message (removed when agent replies)
- ✅ memory-core plugin loaded (provides `memory_get` for direct lookup)
- ⚠️ `memory_search` (semantic recall) disabled — no embedding model on HPC. Can revisit by booting an embedding model on HPC.
- ⚠️ Gateway is a foreground process — dies on logout/reboot. Not a Windows service yet.

## Files

| Path | Purpose |
|---|---|
| `config/openclaw.json` | Template config (committed; the live copy is at `~/.openclaw/openclaw.json`, gitignored) |
| `scripts/install.sh` | Installs OpenClaw + WhatsApp plugin + creates peer-link junction |
| `scripts/fleet-port.sh` | Reads the current GLM-Vision port from HPC fleet state |
| `scripts/tunnel.sh` | Opens the SSH tunnel to the GLM-Vision port |
| `scripts/start.sh` | Starts the OpenClaw gateway (with TLS workaround) |
| `notes.md` | Running log of decisions, fixes, workarounds |
| `action-items.md` | Pending and completed tasks |

## Setup (first time)

1. Run `scripts/install.sh` — installs OpenClaw and the `@openclaw/whatsapp` plugin.
2. Run `scripts/fleet-port.sh` — prints the current GLM-Vision port.
3. Run `scripts/tunnel.sh &` — opens SSH tunnel to that port.
4. Copy `config/openclaw.json` to `~/.openclaw/openclaw.json` and substitute `{{GLM_VISION_PORT}}` and `{{AMAN_PHONE_E164}}`.
5. `NODE_TLS_REJECT_UNAUTHORIZED=0 openclaw channels login --channel whatsapp` — scan QR from phone (or use `~/.openclaw/extensions/whatsapp/qr-to-png-live.mjs` to render as PNG).
6. `scripts/start.sh` — starts the gateway.
7. Send a test message from your phone.

## Windows-specific workarounds

This setup required three Windows-specific fixes (documented in `notes.md`):

1. **PowerShell installer instead of bash** — `openclaw.ai/install.sh` is macOS/Linux only. Use `openclaw.ai/install.ps1`.
2. **TLS verification disabled** — corporate proxy uses a self-signed cert that breaks baileys' WhatsApp Web version fetch. Set `NODE_TLS_REJECT_UNAUTHORIZED=0` for any openclaw/baileys command.
3. **Peer-link junction instead of symlink** — the WhatsApp plugin's peer-link audit requires a symlink to the global openclaw install, but Windows symlinks need admin/developer mode. Use a directory junction (`New-Item -ItemType Junction`).

## Security notes

- **Only `@openclaw/whatsapp` and `@openclaw/zai-provider` plugins from official sources.** Cisco found a third-party ClawHub skill doing prompt injection + data exfiltration. No community skills.
- China restricted OpenClaw at state agencies (Mar 2026) for "unauthorised data deletion/leaks and excessive energy use." Merck IT security may flag this — be aware.
- Config stores credentials locally at `~/.openclaw/` (gitignored, never committed).

## Port shuffling

GLM-Vision's port changes every 3-4 days (HPC fleet hot-swap). When it moves:
1. `scripts/fleet-port.sh` — get the new port.
2. Update `~/.openclaw/openclaw.json` `providers.hpc-glm.baseUrl` with the new port.
3. Restart the gateway: kill the old process, re-run `scripts/start.sh`.
4. Re-open the SSH tunnel: `scripts/tunnel.sh &`.

## Resource usage

- Disk: 81 MB total in `~/.openclaw/` (extensions 61M, credentials 16M, state 3M SQLite).
- RAM: ~450 MB working set when idle.

## Live runtime location

- Process: `openclaw gateway` (PID varies)
- Port: `127.0.0.1:18789`
- Logs: `C:\Users\M316235\AppData\Local\Temp\openclaw\openclaw-YYYY-MM-DD.log`
- SQLite: `~/.openclaw/state/openclaw.sqlite`
- Not a Windows service — dies on logout/reboot. Future work: set up as scheduled task or service.
