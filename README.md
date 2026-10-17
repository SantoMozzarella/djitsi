# djitsi

<img src="logo.jpg" alt="djitsi" width="280">

The bot joins a [Jitsi Meet](https://jitsi.org/) room like any other participant and plays YouTube tracks into its microphone.

Русский: [README.ru.md](README.ru.md)

## Commands

Type these in the room chat.

| Command | What it does |
| --- | --- |
| `!play <url or search>`, `!p` | Add a track. If nothing is playing, start it now |
| `!start` | Start the queue |
| `!skip`, `!s` | Next track |
| `!pause` | Pause the current track |
| `!resume` | Continue the paused track |
| `!stop` | Stop and clear the queue |
| `!queue`, `!q` | What is playing, and what is next |
| `!vol <0-150>` | Volume |
| `!help` | List of commands |

## Requirements

The server needs Docker and Docker Compose. The rest is already in the image.

| In the image | Why |
| --- | --- |
| Node.js 20 | the bot itself |
| Puppeteer, Chromium, Xvfb | join Jitsi when the server has no desktop |
| PulseAudio | the microphone the music goes into |
| ffmpeg, yt-dlp | find the video and play the audio |
| Xray | a separate container, if YouTube goes through your own VLESS |

## Setup

```bash
cp .env_example .env
```

Then edit `.env`. You do not rebuild the image for that.

`ROOM_URL` is the room link. The bot will not start without it.

`BOT_NAME` is the name in the participant list. An empty value becomes DJitsi.

`USE_PROXY` chooses how the bot opens YouTube. `off` means a direct connection. `on` means a proxy.

`YTDLP_PROXY` is that proxy address. The bot uses it only when `USE_PROXY=on`. Leave the line commented and it falls back to `socks5h://xray:1080`, the Xray container.

`COMPOSE_PROFILES` is for Docker, not for the bot. Empty means only the bot starts. `proxy` means Xray starts with it and reads `xray/config.json`.

## If YouTube is blocked

If you already have a proxy, you do not need Xray. In `.env`:

```
USE_PROXY=on
COMPOSE_PROFILES=
YTDLP_PROXY=socks5://user:pass@host:1080
```

Drop the user and password when the proxy has none. `YTDLP_PROXY` can be any of these:

| Type | Example |
| --- | --- |
| SOCKS5 | `socks5://user:pass@host:1080` |
| SOCKS5, DNS at the proxy | `socks5h://host:1080` |
| SOCKS4 | `socks4://host:1080` |
| SOCKS4a | `socks4a://host:1080` |
| HTTP | `http://host:8080` |
| HTTPS | `https://host:8080` |

With your own VLESS, Xray starts next to the bot. In `.env`:

```
USE_PROXY=on
COMPOSE_PROFILES=proxy
YTDLP_PROXY=socks5h://xray:1080
```

The key itself goes in `xray/config.json`, in the `outbounds` block. The repo includes an example for VLESS Reality. Take these fields from the `vless://` link:

| Field | Where |
| --- | --- |
| `address` and `port` | host and port after `@` |
| `id` | the UUID at the start of the link |
| `flow` | usually `xtls-rprx-vision` |
| `serverName` | `sni` |
| `publicKey` | `pbk` |
| `shortId` | `sid` |

## Run

You can take a ready image from GitHub, or build one yourself. The ready image is easier: nothing to compile, and the address is already in `docker-compose.yml`.

Download and start:

```bash
docker compose pull
docker compose up -d
```

Build it yourself if the ready image is not what you want:

```bash
docker compose up -d --build
```

If you later change only `.env` or `xray/config.json`, do not download or build again:

```bash
docker compose up -d
```

The bot is in the room when the log shows `Bot joined the room`. Log: `docker compose logs -f`.
