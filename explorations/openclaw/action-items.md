# Action items — OpenClaw WhatsApp agent

## Done (2026-08-06)

- [x] Research OpenClaw — confirmed real, native WhatsApp, OpenAI-compatible backend
- [x] Verify Node 22+ — Node 24.19.0
- [x] Confirm GLM-Vision port from HPC — 8116 on demu4xfat002
- [x] Create project skeleton at `research/explorations/openclaw/`
- [x] Install OpenClaw + WhatsApp plugin (with TLS workaround for corporate proxy)
- [x] Repair peer-link junction (Windows symlink limitation)
- [x] Pair WhatsApp (QR scan, after fixing baileys version fetch)
- [x] Start gateway, verify end-to-end (Aman sent test message, GLM-Vision replied)
- [x] Configure 🤖 ackReaction for DM + groups
- [x] Enable "Notes to Future Aman" group (`4915218360719-1560169008@g.us`) with `requireMention: false`
- [x] Verify memory-core loaded (disabled semantic search since no embeddings on HPC)
- [x] Run openclaw doctor — no critical issues
- [x] Rename GitHub repo `maleshep/scoop` → `maleshep/research`
- [x] Commit + push openclaw exploration files

## Future / optional

- [ ] Make gateway always-on (Windows service or scheduled task) — currently dies on logout/reboot
- [ ] Boot an embedding model on HPC and re-enable `memory_search` for semantic recall
- [x] Add `plugins.allow: ["whatsapp", "memory-core"]` to minimize plugin load (saves ~70 MB, down from 9 plugins to 2)
- [ ] Persist `gateway.auth.token` in config so the runtime token doesn't change on every restart
