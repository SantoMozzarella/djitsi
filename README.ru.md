# djitsi

<img src="logo.jpg" alt="djitsi" width="280">

Бот заходит в комнату [Jitsi Meet](https://jitsi.org/) как обычный участник и играет YouTube треки в свой микрофон.

English: [README.md](README.md)

## Команды

Пишутся в чат комнаты.

| Команда | Что делает |
| --- | --- |
| `!play <ссылка или запрос>`, `!p` | Добавить трек. Если сейчас тишина, сразу его включить |
| `!start` | Начать играть очередь |
| `!skip`, `!s` | Следующий трек |
| `!pause` | Поставить текущий трек на паузу |
| `!resume` | Продолжить трек с паузы |
| `!stop` | Остановить и очистить очередь |
| `!queue`, `!q` | Что сейчас играет и что дальше |
| `!vol <0-150>` | Громкость |
| `!help` | Список команд |

## Требования

На сервере нужны Docker и Docker Compose. Остальное уже лежит в образе.

| Что внутри | Зачем |
| --- | --- |
| Node.js 20 | сам бот |
| Puppeteer, Chromium, Xvfb | зайти в Jitsi, когда на сервере нет рабочего стола |
| PulseAudio | микрофон, в который уходит музыка |
| ffmpeg, yt-dlp | найти ролик и проиграть звук |
| Xray | отдельный контейнер, если YouTube открывается через свой VLESS |

## Настройка

```bash
cp .env_example .env
```

Дальше правится `.env`. Образ из-за этого пересобирать не нужно.

`ROOM_URL` это ссылка на комнату. Без неё бот не запустится.

`BOT_NAME` это имя в списке участников. Пустая строка даст имя DJitsi.

`USE_PROXY` решает, как бот ходит на YouTube. `off` значит напрямую. `on` значит через прокси.

`YTDLP_PROXY` это адрес этого прокси. Бот смотрит сюда только при `USE_PROXY=on`. Если строку оставить закомментированной, возьмётся `socks5h://xray:1080`, то есть контейнер Xray.

`COMPOSE_PROFILES` читает Docker, не бот. Пусто: запущен только бот. `proxy`: вместе с ботом запускается Xray и берёт ключ из `xray/config.json`.

## Если YouTube заблокирован

Если прокси уже есть, Xray не нужен. В `.env` так:

```
USE_PROXY=on
COMPOSE_PROFILES=
YTDLP_PROXY=socks5://user:pass@host:1080
```

Логин и пароль уберите, если у прокси их нет. В `YTDLP_PROXY` можно поставить такой адрес:

| Тип | Пример |
| --- | --- |
| SOCKS5 | `socks5://user:pass@host:1080` |
| SOCKS5, DNS на стороне прокси | `socks5h://host:1080` |
| SOCKS4 | `socks4://host:1080` |
| SOCKS4a | `socks4a://host:1080` |
| HTTP | `http://host:8080` |
| HTTPS | `https://host:8080` |

Если есть свой VLESS, рядом с ботом поднимается Xray. В `.env` так:

```
USE_PROXY=on
COMPOSE_PROFILES=proxy
YTDLP_PROXY=socks5h://xray:1080
```

Сам ключ пишется в `xray/config.json`, в блок `outbounds`. В репозитории лежит пример под VLESS Reality. Из ссылки `vless://` берутся такие поля:

| Поле | Откуда |
| --- | --- |
| `address` и `port` | хост и порт после `@` |
| `id` | UUID в начале ссылки |
| `flow` | обычно `xtls-rprx-vision` |
| `serverName` | `sni` |
| `publicKey` | `pbk` |
| `shortId` | `sid` |

## Запуск

Образ можно взять готовым с GitHub или собрать самому. Готовый проще: ничего компилировать не нужно, адрес уже записан в `docker-compose.yml`.

Скачать и запустить:

```bash
docker compose pull
docker compose up -d
```

Собрать самому, если готовый образ не подходит:

```bash
docker compose up -d --build
```

Если потом поменяли только `.env` или `xray/config.json`, заново качать и собирать не нужно:

```bash
docker compose up -d
```

Бот в комнате, когда в логе есть строка `Bot joined the room`. Лог: `docker compose logs -f`.
