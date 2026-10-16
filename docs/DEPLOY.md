# Running Tavern on your Linux PC

This guide gets Tavern running at home and gives you a public `https://` link to send to friends. Nothing is opened on your router: a Cloudflare tunnel carries the traffic out, and the app itself publishes no ports.

## 1. One-time setup

1. **Install Docker** (Docker Engine plus the Compose plugin): <https://docs.docker.com/engine/install/>. Check that it works with `docker compose version`.
2. **Get the code:**
   ```bash
   git clone https://github.com/Cordell29/rpg-app-project.git tavern
   cd tavern
   ```
3. **Create your settings file:**
   ```bash
   cp .env.example .env
   chmod 600 .env
   nano .env        # or any text editor
   ```
   Fill in at least one key:
   - `ANTHROPIC_API_KEY`: from <https://console.anthropic.com>. Claude runs the GM.
   - `GEMINI_API_KEY`: from <https://aistudio.google.com/apikey>. Used for pictures and the AI voice. If you set *only* this key, Gemini also runs the GM (set `LLM_PROVIDER=gemini` to force that).
4. **Set hard spending limits in both billing consoles** (Anthropic → Settings → Limits; Google AI Studio / Cloud billing → Budgets). Tavern's own caps ($5 per room per day, $20 per day for the whole server) are *estimates*; the billing consoles are the real backstop.
5. **Make the data folder** (the app runs as user 1000, not root):
   ```bash
   mkdir -p data && sudo chown 1000:1000 data
   ```

## 2. Start it

```bash
docker compose up -d --build
```

The first build takes a few minutes. After that:

- **Find your public link.** The app has no local port by default, so you use the tunnel address even on the PC itself:
  ```bash
  docker compose logs cloudflared | grep trycloudflare
  ```
  You'll see something like `https://brave-otter-123.trycloudflare.com`. Open it, create a campaign, and share the invite link. Inside a room, the host also sees the current public link at the top of the page.
- **Optional:** put a Discord webhook URL in `SHARE_WEBHOOK_URL` and Tavern posts the new link there each time it changes.

## 3. When the link changes

A Cloudflare **Quick Tunnel** gets a new random address every time it restarts (a reboot, `docker compose restart`, an update). Tavern notices within 30 seconds and shows the new link to the host. Saved seats are tied to the old address, so returning players:

1. open the new link and the invite code (or the new invite link you send them),
2. tap **"Played here before? Get your character back"** and pick their character,
3. the host taps **Let them in** on the request that appears above the story.

The host gets back in with their saved **host link**, with the domain part changed to the new address. The host can also hand out one-time **Rejoin links** from **Backup & seats**.

**Tired of the changing link?** Either:
- **Tailscale Funnel** (free, fixed `https://your-pc.your-tailnet.ts.net` address). Run Funnel on the PC pointing at the app and set `PUBLIC_URL` to that address. You'll need to publish the app's port to localhost for this (add `ports: ["127.0.0.1:3000:3000"]` under `app` in `docker-compose.yml`).
- **Your own domain** with a Cloudflare *named* tunnel. Change the `cloudflared` command in `docker-compose.yml` to `tunnel --no-autoupdate run`, add `TUNNEL_TOKEN=...` to `.env`, and set `PUBLIC_URL=https://your.domain`.

## 4. Day to day

| Task | Command |
|---|---|
| Update to the latest version | `git pull && docker compose up -d --build` |
| Stop | `docker compose down` |
| See what the app is doing | `docker compose logs -f app` |
| Restart (gives a new Quick Tunnel link) | `docker compose restart` |

Database changes ("migrations") run automatically on start. If one ever fails, the app refuses to start rather than damaging your data.

## 5. Your data and backups

Everything lives in the `data/` folder next to `docker-compose.yml`:

- `data/tavern.db`: every campaign (the story, characters, recaps, world notes).
- `data/assets/`: portraits, scene pictures and voice clips.
- `data/backups/`: an automatic copy of the database **every day**, kept for 14 days (`BACKUP_KEEP_DAYS`).

Copy `data/backups` to a second disk or a cloud folder now and then. The host can also download any single campaign from **Backup & seats → Download campaign file**, and restore it on any Tavern server from the home page (**Restore a campaign from a backup file**).

**Restoring the whole server from a nightly backup:** stop it (`docker compose down`), copy the backup over the live file (`cp data/backups/tavern-2026-10-15.db data/tavern.db`, then delete `data/tavern.db-wal` and `data/tavern.db-shm` if they exist), and start it again.

## 6. Limits that protect you

| What | Default | Where to change |
|---|---|---|
| AI spend per room per day | $5 | `SPEND_CAP_ROOM_USD` (new rooms); host: Backup & seats → AI budget |
| AI spend per day, whole server | $20 | `SPEND_CAP_GLOBAL_USD` |
| GM turns per room | 6 a minute | (fixed) |
| Commands per player | 30 a minute | (fixed) |
| New campaigns per IP address | 10 per 10 min | (fixed) |
| Pictures per room | 20 a day | (fixed) |

When a cap is reached the GM **pauses**: players see a message, queued actions wait, and nothing is lost. Caps reset at midnight UTC, or the host raises the room's cap.

## 7. Sharing the PC with a Minecraft server

The app is limited to 1 GB of memory (`mem_limit` in `docker-compose.yml`, plus a 768 MB Node heap). It uses very little CPU: the AI and pictures are generated in the cloud.

## Troubleshooting

- **"Seat not recognised"** after a restart: that's the link change. Use **Played here before?** (players) or the host link (host).
- **No link in the logs:** `docker compose logs cloudflared`. Cloudflare occasionally rate-limits Quick Tunnels; wait a minute and `docker compose restart cloudflared`.
- **Permission denied writing /data:** run `sudo chown -R 1000:1000 data`.
- **The GM says the budget is used up:** see section 6. Check the real spend in your Anthropic/Google consoles.
