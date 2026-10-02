# OpenCode Remote Access (Web UI + Tailscale)

This PC is configured to run OpenCode as a remote web server so you can
control this project from another device.

## What was set up

- `opencode.json` — `server.port: 4096`, `server.hostname: 0.0.0.0`
- `scripts/start-opencode-remote.ps1` — secure launcher (requires password)
- `scripts/start-opencode-remote.cmd` — double-click launcher
- `scripts/setup-opencode-firewall.ps1` — Windows Firewall rule (admin)
- OpenCode v1.18.31 installed globally via npm

## 1. Install Tailscale (once per device)

1. On this PC: https://tailscale.com/download → install → Sign in → note the
   Tailscale IP (`tailscale ip -4`, looks like `100.x.y.z`).
2. On the remote device (phone/laptop): install Tailscale, sign in to the
   same account.

Tailscale is preferred over router port-forwarding — no ports exposed to the
internet, traffic is WireGuard-encrypted.

## 2. Open firewall (admin, once)

LAN access needs TCP 4096 allowed on Private networks:

```powershell
# Run PowerShell as Administrator
powershell -ExecutionPolicy Bypass -File scripts\setup-opencode-firewall.ps1
```

Tailscale-only users: still recommended, rule is Private+Domain only (not Public).

## 3. Start the server

```powershell
# Option A: double-click
scripts\start-opencode-remote.cmd

# Option B: terminal
powershell -ExecutionPolicy Bypass -File scripts\start-opencode-remote.ps1
```

The script will prompt for `OPENCODE_SERVER_PASSWORD` if not set (min 12 chars).
To persist it for your user account (so you aren't prompted each time):

```powershell
[Environment]::SetEnvironmentVariable("OPENCODE_SERVER_PASSWORD","<strong-unique-password>","User")
# restart terminal afterwards
```

Optional username (default `opencode`):

```powershell
[Environment]::SetEnvironmentVariable("OPENCODE_SERVER_USERNAME","opencode","User")
```

## 4. Connect remotely

- Tailscale: `http://<tailscale-ip>:4096` (e.g. `http://100.64.10.5:4096`)
- LAN: `http://192.168.1.179:4096`
- This PC: `http://127.0.0.1:4096`

Login with user `opencode` + your `OPENCODE_SERVER_PASSWORD`.

Health check (no auth needed):

```
GET http://<host>:4096/global/health
→ {"healthy":true,"version":"..."}
```

## 5. Attach TUI (optional)

Use terminal + web at the same time, sharing sessions:

```powershell
& "$env:APPDATA\npm\opencode.cmd" attach http://127.0.0.1:4096
```

## Security notes

- NEVER run `--hostname 0.0.0.0` without `OPENCODE_SERVER_PASSWORD`.
  The launcher enforces this.
- Do NOT port-forward 4096 on your router unless you know what you're doing.
  Use Tailscale instead.
- Keep Windows network profile on Private, not Public.
- To stop: Ctrl+C in the server window.
- To revoke access: change the password + `tailscale logout` or remove device
  from Tailscale admin console.

## CLI reference

```powershell
# default local-only web UI
opencode web

# remote (what the scripts do)
$env:OPENCODE_SERVER_PASSWORD="secret"
opencode web --port 4096 --hostname 0.0.0.0

# headless API only (no web UI)
$env:OPENCODE_SERVER_PASSWORD="secret"
opencode serve --port 4096 --hostname 0.0.0.0
```
