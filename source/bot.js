'use strict';

const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const puppeteer = require('puppeteer-core');

const execFileAsync = promisify(execFile);

const ROOM_URL = process.env.ROOM_URL;
const BOT_NAME = process.env.BOT_NAME || 'DJitsi';
const USE_PROXY = /^(1|true|yes|on)$/i.test(process.env.USE_PROXY || '');
const YTDLP_PROXY = USE_PROXY ? (process.env.YTDLP_PROXY || '') : '';
const YTDLP_COOKIES = process.env.YTDLP_COOKIES || '';
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium';

const JOIN_TIMEOUT_MS = 120000;
const HEALTH_INTERVAL_MS = 15000;
const YTDLP_TIMEOUT_MS = 90000;

if (!ROOM_URL) {
    console.error('ROOM_URL is required');
    process.exit(1);
}

let page = null;
const queue = [];
let current = null;
let player = null;
let playbackId = 0;
let playerEpoch = 0;
let lock = Promise.resolve();

function withLock(fn) {
    const run = lock.then(fn, fn);
    lock = run.then(() => {}, () => {});
    return run;
}

function log(message) {
    process.stdout.write('[' + new Date().toISOString() + '] ' + message + '\n');
}

function shortError(err) {
    const text = (err && (err.stderr || err.message) ? String(err.stderr || err.message) : String(err))
        .replace(/\s+/g, ' ')
        .trim();
    return text.slice(0, 180) || 'unknown error';
}

function explainDownloadError(err) {
    const text = shortError(err);
    if (/Name or service not known|Temporary failure in name resolution|nodename nor servname/i.test(text)) {
        return 'DNS could not resolve the name. Check that the xray container is running and that address in xray/config.json is the real server host';
    }
    return text;
}

function isUrl(text) {
    return /^https?:\/\//i.test(text);
}

function buildRoomUrl(roomUrl, botName) {
    const safeName = String(botName).replace(/"/g, '');
    const pairs = [
        ['config.prejoinPageEnabled', 'true'],
        ['config.prejoinConfig.enabled', 'true'],
        ['config.startWithVideoMuted', 'true'],
        ['config.startWithAudioMuted', 'false'],
        ['config.disableAP', 'true'],
        ['config.disableAEC', 'true'],
        ['config.disableNS', 'true'],
        ['config.disableAGC', 'true'],
        ['config.disableHPF', 'true'],
        ['config.enableNoAudioDetection', 'false'],
        ['config.enableNoisyMicDetection', 'false'],
        ['config.disableDeepLinking', 'true'],
        // Legacy keys. Current Meet reads stereo and bitrate from audioQuality.
        ['config.stereo', 'true'],
        ['config.opusMaxAverageBitrate', '128000'],
        ['config.audioQuality.stereo', 'true'],
        ['config.audioQuality.opusMaxAverageBitrate', '128000'],
        ['config.audioQuality.opusMaxAverageBitrateStereo', '128000'],
        ['config.p2p.enabled', 'false'],
        ['userInfo.displayName', '"' + safeName + '"'],
    ];
    const extra = pairs
        .map(([key, value]) => key + '=' + encodeURIComponent(value))
        .join('&');
    const parts = roomUrl.split('#');
    const base = parts[0];
    const existingHash = parts.slice(1).join('#');
    return base + '#' + (existingHash ? existingHash + '&' : '') + extra;
}

function roomLabel(roomUrl) {
    try {
        const url = new URL(roomUrl.split('#')[0]);
        return url.origin + url.pathname;
    } catch (e) {
        return '(invalid ROOM_URL)';
    }
}

function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(label)), ms);
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

async function say(text) {
    if (!page) return;
    log('Chat: ' + text);
    try {
        await withTimeout(page.evaluate((message) => {
            const room = window.APP && window.APP.conference && window.APP.conference._room;
            if (room && typeof room.sendTextMessage === 'function') {
                room.sendTextMessage(message);
            }
        }, text), 8000, 'chat did not respond');
    } catch (err) {
        log('Chat was not sent: ' + err.message);
    }
}

function ytdlpArgs(extra) {
    const args = ['--no-playlist', '--no-warnings', '--no-check-certificates'];
    if (YTDLP_PROXY) args.push('--proxy', YTDLP_PROXY);
    if (YTDLP_COOKIES) args.push('--cookies', YTDLP_COOKIES);
    if (extra) args.push.apply(args, extra);
    return args;
}

function isHttpProxy(proxy) {
    return /^https?:\/\//i.test(proxy);
}

function isSocksProxy(proxy) {
    return /^socks(?:4a?|5h?):\/\//i.test(proxy);
}

function pickAudioFormat(info) {
    const formats = Array.isArray(info.formats) ? info.formats : [];
    const audioOnly = formats.filter((format) => {
        if (!format || !format.url) return false;
        const audio = format.acodec && format.acodec !== 'none';
        const video = format.vcodec && format.vcodec !== 'none';
        return audio && !video;
    });
    audioOnly.sort((a, b) => (b.abr || 0) - (a.abr || 0));
    if (audioOnly[0]) return audioOnly[0];

    const withAudio = formats.filter((format) => format && format.url && format.acodec && format.acodec !== 'none');
    withAudio.sort((a, b) => (b.abr || 0) - (a.abr || 0));
    if (withAudio[0]) return withAudio[0];

    if (typeof info.url === 'string' && /^https?:\/\//i.test(info.url)) {
        return { url: info.url, http_headers: info.http_headers || {} };
    }
    return null;
}

async function resolveTrack(query) {
    const target = isUrl(query) ? query : ('ytsearch1:' + query);
    const args = ytdlpArgs(['-f', 'bestaudio/best', '-J', target]);

    const result = await execFileAsync('yt-dlp', args, {
        timeout: YTDLP_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
    });
    let info = JSON.parse(result.stdout);
    if (info && info._type === 'playlist' && Array.isArray(info.entries) && info.entries[0]) {
        info = info.entries[0];
    }
    const title = info.title || query;
    const format = pickAudioFormat(info);
    if (!format) {
        throw new Error('yt-dlp did not return an audio URL');
    }
    return {
        title: title,
        url: format.url,
        headers: format.http_headers || {},
        source: target,
    };
}

function signalChild(child, signal) {
    if (!child) return;
    if (child.exitCode === null) {
        try {
            child.kill(signal);
        } catch (err) {
            log('Could not stop process: ' + err.message);
        }
    }
    if (child.downloader) signalChild(child.downloader, signal);
}

function ffmpegHeaderArgs(headers) {
    const lines = Object.keys(headers || {}).map((key) => key + ': ' + headers[key]);
    if (!lines.length) return [];
    return ['-headers', lines.join('\r\n') + '\r\n'];
}

function wirePlayer(child, track, id) {
    const epoch = ++playerEpoch;
    player = child;
    let stderr = '';
    child.stderr.on('error', () => {});
    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });

    const finish = (notice) => {
        setImmediate(() => {
            let text = null;
            withLock(async () => {
                if (epoch !== playerEpoch || id !== playbackId) return;
                if (player === child) player = null;
                current = null;
                const next = playNext();
                text = [notice, next].filter(Boolean).join('\n');
            }).then(() => {
                if (text) return say(text);
            }).catch((err) => {
                log('Error after track: ' + err.message);
                process.exit(1);
            });
        });
    };

    child.on('close', (code, signal) => {
        const killed = signal === 'SIGTERM' || signal === 'SIGKILL';
        if (!killed && code !== 0) {
            log('ffmpeg exited with code ' + code + ': ' + stderr.trim());
            finish('Playback failed for "' + track.title + '", next track');
            return;
        }
        finish(null);
    });

    child.on('error', (err) => {
        log('Could not start ffmpeg: ' + err.message);
        finish('Could not start playback for "' + track.title + '"');
    });
}

function playerIsRunning() {
    return Boolean(player && player.exitCode === null && player.signalCode === null);
}

function playerEnv() {
    return Object.assign({}, process.env, { PULSE_PROP: 'application.name=music-bot' });
}

function spawnPlayer(track, id) {
    if (isSocksProxy(YTDLP_PROXY)) {
        spawnViaSocks(track, id);
        return;
    }

    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-nostdin',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-rw_timeout', '20000000',
    ];
    if (isHttpProxy(YTDLP_PROXY)) args.push('-http_proxy', YTDLP_PROXY);
    args.push.apply(args, ffmpegHeaderArgs(track.headers));
    args.push('-i', track.url, '-vn', '-ac', '2', '-f', 'pulse', '-name', 'music-bot', 'music');

    const child = spawn('ffmpeg', args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: playerEnv(),
    });
    wirePlayer(child, track, id);
}

function spawnViaSocks(track, id) {
    const downloader = spawn('yt-dlp', ytdlpArgs([
        '--no-progress',
        '--retries', '10',
        '--fragment-retries', '10',
        '--socket-timeout', '20',
        '-f', 'bestaudio/best',
        '-o', '-',
        track.source,
    ]), {
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const child = spawn('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'warning',
        '-nostdin',
        '-i', 'pipe:0',
        '-vn',
        '-ac', '2',
        '-f', 'pulse',
        '-name', 'music-bot',
        'music',
    ], {
        stdio: ['pipe', 'ignore', 'pipe'],
        env: playerEnv(),
    });
    child.downloader = downloader;
    child.stdin.on('error', () => {});
    downloader.stdout.on('error', () => {});
    downloader.stdout.pipe(child.stdin);

    let stderr = '';
    downloader.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    downloader.on('close', (code) => {
        if (child.stdin) child.stdin.end();
        if (code) log('yt-dlp stream exited with code ' + code + ': ' + stderr.trim());
    });
    downloader.on('error', (err) => {
        log('Could not start yt-dlp: ' + err.message);
        if (child.stdin) child.stdin.end();
    });

    wirePlayer(child, track, id);
}

function playNext() {
    if (player && !playerIsRunning()) {
        player = null;
        current = null;
    }
    if (playerIsRunning()) return null;
    current = null;
    const track = queue.shift();
    if (!track) return null;
    current = track;
    spawnPlayer(track, playbackId);
    return 'Playing: ' + track.title;
}

async function handlePlay(query) {
    const text = query.trim();
    if (!text) {
        await say('Usage: !play <url or search>');
        return;
    }
    const id = playbackId;
    let track;
    try {
        track = await resolveTrack(text);
    } catch (err) {
        if (id !== playbackId) return;
        log('Could not load "' + text + '": ' + shortError(err));
        await say('Could not load "' + text + '": ' + explainDownloadError(err));
        let next = null;
        await withLock(async () => {
            if (id !== playbackId || playerIsRunning()) return;
            next = playNext();
        });
        if (next) await say(next);
        return;
    }
    if (id !== playbackId) return;
    let notice = null;
    await withLock(async () => {
        if (id !== playbackId) return;
        if (playerIsRunning()) {
            queue.push(track);
            notice = 'Added to queue: ' + track.title;
            return;
        }
        current = track;
        spawnPlayer(track, playbackId);
        notice = 'Playing: ' + track.title;
    });
    if (notice) await say(notice);
}

function detachPlayer() {
    playerEpoch += 1;
    const child = player;
    player = null;
    current = null;
    signalChild(child, 'SIGKILL');
}

async function handleSkip() {
    let notice = null;
    await withLock(async () => {
        if (!playerIsRunning() && queue.length === 0) {
            notice = 'Queue is empty';
            return;
        }
        detachPlayer();
        const next = playNext();
        notice = next ? ('Skipped\n' + next) : 'Skipped';
    });
    if (notice) await say(notice);
}

async function handleStart() {
    let notice = null;
    await withLock(async () => {
        if (playerIsRunning()) {
            notice = current ? ('Already playing: ' + current.title) : 'Already playing';
            return;
        }
        if (queue.length === 0) {
            notice = 'Queue is empty';
            return;
        }
        const next = playNext();
        notice = next || 'Queue is empty';
    });
    if (notice) await say(notice);
}

async function handleStop() {
    await withLock(async () => {
        playbackId += 1;
        queue.length = 0;
        detachPlayer();
    });
    await say('Stopped, queue cleared');
}

async function handleQueue() {
    const lines = [];
    lines.push(current ? ('Now: ' + current.title) : 'Nothing is playing');
    if (queue.length === 0) {
        lines.push('Queue is empty');
    } else {
        lines.push('Queue:');
        queue.slice(0, 10).forEach((track, index) => {
            lines.push((index + 1) + '. ' + track.title);
        });
        if (queue.length > 10) {
            lines.push('… and ' + (queue.length - 10) + ' more');
        }
    }
    await say(lines.join('\n'));
}

async function handleVol(raw) {
    const value = String(raw || '').trim().replace(/%$/, '');
    if (!/^\d{1,3}$/.test(value)) {
        await say('Usage: !vol <0-150>');
        return;
    }
    const volume = Number(value);
    if (volume > 150) {
        await say('Volume must be from 0 to 150');
        return;
    }
    await execFileAsync('pactl', ['set-sink-volume', 'music', volume + '%']);
    await say('Volume: ' + volume + '%');
}

async function handleHelp() {
    await say([
        'Commands:',
        '!play <url or search> (!p) — add to the queue and start if nothing is playing',
        '!start — start the queue if nothing is playing',
        '!skip (!s) — next track',
        '!stop — stop playback and clear the queue',
        '!queue (!q) — what is playing and the queue',
        '!vol <0-150> — volume',
        '!help — this help',
    ].join('\n'));
}

function handleCommand(text) {
    const match = String(text || '').trim().match(/^!(\S+)(?:\s+([\s\S]+))?$/);
    if (!match) return;
    const command = match[1].toLowerCase();
    const arg = match[2] || '';
    log(('Command: !' + command + ' ' + arg).trim());

    let job = null;
    switch (command) {
        case 'play':
        case 'p':
            job = () => handlePlay(arg);
            break;
        case 'skip':
        case 's':
            job = () => handleSkip();
            break;
        case 'start':
            job = () => handleStart();
            break;
        case 'stop':
            job = () => handleStop();
            break;
        case 'queue':
        case 'q':
            job = () => handleQueue();
            break;
        case 'vol':
        case 'volume':
            job = () => handleVol(arg);
            break;
        case 'help':
            job = () => handleHelp();
            break;
        default:
            return;
    }

    job().catch((err) => {
        log('Command !' + command + ' failed: ' + err.message);
        say('Error: ' + shortError(err)).catch(() => {});
    });
}

async function hookRoom() {
    await page.evaluate(() => {
        const room = window.APP && window.APP.conference && window.APP.conference._room;
        if (!room || room.__musicBotHooked) return false;
        room.__musicBotHooked = true;

        const recent = new Map();
        const onMessage = (id, text, ts, nick) => {
            try {
                if (!text || typeof text !== 'string') return;
                const myId = typeof room.myUserId === 'function' ? room.myUserId() : null;
                if (myId && id === myId) return;
                // The same chat line is delivered twice, often with an empty timestamp.
                // Remember it only briefly, or a later identical !stop is dropped.
                const key = String(id) + '|' + text;
                const now = Date.now();
                const prev = recent.get(key);
                if (prev && now - prev < 1500) return;
                recent.set(key, now);
                if (recent.size > 50) {
                    for (const [saved, at] of recent) {
                        if (now - at > 5000) recent.delete(saved);
                    }
                }
                const send = window.onJitsiChat(JSON.stringify({
                    id: id || '',
                    text: text,
                    nick: nick || '',
                }));
                if (send && typeof send.catch === 'function') send.catch(() => {});
            } catch (err) {
                // Keep the chat listener even if the Node bridge is busy.
            }
        };

        room.on('messageReceived', onMessage);
        room.on('conference.messageReceived', onMessage);

        const onLeft = (reason) => {
            if (window.onBotLeft) window.onBotLeft(String(reason || 'left'));
        };
        room.on('conference.left', onLeft);
        room.on('conference.failed', onLeft);
        return true;
    });
}

async function inRoom() {
    return page.evaluate(() => {
        const room = window.APP && window.APP.conference && window.APP.conference._room;
        return Boolean(room && typeof room.isJoined === 'function' && room.isJoined());
    });
}

async function readMic() {
    return page.evaluate(() => {
        const state = window.APP && window.APP.store && window.APP.store.getState
            ? window.APP.store.getState()
            : {};
        const tracks = state['features/base/tracks'] || [];
        const localAudio = tracks.filter((track) => track.local && track.mediaType === 'audio');
        return {
            mediaMuted: Boolean(state['features/base/media'] && state['features/base/media'].audio && state['features/base/media'].audio.muted),
            trackCount: localAudio.length,
            trackMuted: localAudio.length === 0 || localAudio.every((track) => track.muted),
        };
    });
}

function micIsOff(state) {
    return !state || state.mediaMuted || state.trackMuted;
}

async function listAudioInputs() {
    return page.evaluate(async () => {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices
            .filter((device) => device.kind === 'audioinput')
            .map((device) => device.label || device.deviceId || 'audioinput');
    });
}

async function realClick(description) {
    await page.evaluate(() => {
        const toolbox = document.querySelector('.new-toolbox');
        if (toolbox) toolbox.classList.add('visible');
    });
    await page.mouse.move(320, 240);
    await page.mouse.move(640, 680);
    const target = await page.evaluate((description) => {
        let el = null;
        if (description.testId) {
            el = document.querySelector('[data-testid="' + description.testId + '"]');
        } else {
            const needles = description.labels || [];
            el = Array.from(document.querySelectorAll('[aria-label]')).find((node) => {
                const label = (node.getAttribute('aria-label') || '').toLowerCase();
                return needles.some((needle) => label.includes(needle));
            }) || null;
        }
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = el.getBoundingClientRect();
        return {
            label: el.getAttribute('aria-label') || el.getAttribute('data-testid') || '',
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            w: rect.width,
            h: rect.height,
            disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        };
    }, description);
    if (!target || target.w < 2 || target.h < 2) return null;
    if (target.disabled) return 'disabled:' + target.label;
    await page.mouse.click(target.x, target.y);
    return target.label;
}

async function ensureMicOn(quiet) {
    let state = await readMic();
    if (!micIsOff(state)) {
        if (!quiet) log('Microphone is on: ' + JSON.stringify(state));
        return;
    }
    const inputs = await listAudioInputs();
    log('Chromium audio inputs: ' + (inputs.join(', ') || 'none'));
    const clicked = await realClick({
        // Jitsi button text in English and Russian UI.
        labels: ['unmute', 'включить микрофон', 'включить звук'],
    });
    log('Microphone click: ' + (clicked || 'button not found'));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await page.evaluate(() => {
        const store = window.APP && window.APP.store;
        if (!store) return;
        store.dispatch({
            type: 'SET_AUDIO_MUTED',
            muted: false,
            ensureTrack: true,
        });
        const room = window.APP.conference && window.APP.conference._room;
        const tracks = room && room.getLocalTracks ? room.getLocalTracks() : [];
        tracks.forEach((track) => {
            if (track.getType && track.getType() === 'audio' && track.isMuted && track.isMuted() && track.unmute) {
                track.unmute();
            }
        });
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    state = await readMic();
    log('Microphone now: ' + JSON.stringify(state));
}

function shutdown(code, message) {
    log(message);
    process.exit(code);
}

async function describePage() {
    return page.evaluate(() => {
        const room = window.APP && window.APP.conference && window.APP.conference._room;
        const joined = Boolean(room && typeof room.isJoined === 'function' && room.isJoined());
        const text = ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 240);
        return { joined: joined, href: location.href, text: text };
    });
}

async function fillDisplayName() {
    await page.evaluate((name) => {
        const input = document.querySelector('#premeeting-name-input');
        if (!input) return;
        const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (proto && proto.set) proto.set.call(input, name);
        else input.value = name;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }, BOT_NAME);
}

async function waitUntilJoined() {
    const deadline = Date.now() + JOIN_TIMEOUT_MS;
    let announcedPrejoin = false;
    while (Date.now() < deadline) {
        if (await inRoom()) return;
        const onPrejoin = await page.evaluate(() => Boolean(
            document.querySelector('[data-testid="prejoin.screen"]')
            || document.querySelector('[data-testid="prejoin.joinMeeting"]')
        ));
        if (onPrejoin) {
            if (!announcedPrejoin) {
                log('Prejoin screen: unmuting and joining');
                announcedPrejoin = true;
            }
            await fillDisplayName();
            const mic = await readMic();
            log('Prejoin microphone: ' + JSON.stringify(mic));
            if (micIsOff(mic)) await ensureMicOn(true);
            const join = await realClick({ testId: 'prejoin.joinMeeting' });
            log('Join button: ' + (join || 'not found'));
        } else {
            const state = await describePage();
            log('Waiting to join: ' + (state.text || state.href));
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const state = await describePage();
    throw new Error('Could not join the room. Page: ' + (state.text || state.href));
}

async function main() {
    const target = buildRoomUrl(ROOM_URL, BOT_NAME);
    log('Bot starting');
    log('Room: ' + roomLabel(ROOM_URL));
    log('Name: ' + BOT_NAME);
    log('YouTube proxy: ' + (USE_PROXY ? (YTDLP_PROXY || 'enabled, but the address is empty') : 'off'));
    log('Starting Chromium');

    const browser = await puppeteer.launch({
        executablePath: CHROMIUM_PATH,
        headless: false,
        timeout: 60000,
        ignoreDefaultArgs: ['--mute-audio'],
        defaultViewport: { width: 1280, height: 720 },
        args: [
            '--no-sandbox',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--ozone-platform=x11',
            '--no-first-run',
            '--window-size=1280,720',
        ],
    });

    browser.on('disconnected', () => shutdown(1, 'Browser disconnected'));

    page = await browser.newPage();
    page.on('error', (err) => shutdown(1, 'Page crashed: ' + err.message));
    page.on('close', () => shutdown(1, 'Page closed'));
    page.on('console', (message) => {
        const text = message.text();
        if (message.type() === 'error' || /getUserMedia|NotAllowed|NotFoundError|Overconstrained|gum\.not_found/i.test(text)) {
            log('Browser: ' + text.slice(0, 300));
        }
    });

    await page.exposeFunction('onJitsiChat', (payload) => {
        setImmediate(() => {
            try {
                const message = JSON.parse(payload);
                if (message.nick && message.nick === BOT_NAME) return;
                handleCommand(message.text);
            } catch (err) {
                log('Bad chat message: ' + err.message);
            }
        });
    });

    let left = false;
    await page.exposeFunction('onBotLeft', (reason) => {
        if (left) return;
        left = true;
        shutdown(1, 'Bot left the room (' + reason + ')');
    });

    const origin = new URL(ROOM_URL.split('#')[0]).origin;
    await browser.defaultBrowserContext().overridePermissions(origin, ['microphone', 'camera']);

    log('Opening the room');
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: JOIN_TIMEOUT_MS });
    log('Page opened: ' + page.url());

    await waitUntilJoined();

    await page.evaluate((name) => {
        if (window.APP && window.APP.conference && window.APP.conference.changeLocalDisplayName) {
            window.APP.conference.changeLocalDisplayName(name);
        }
    }, BOT_NAME);

    await hookRoom();
    const applied = await page.evaluate(() => {
        const config = (window.APP && window.APP.store && window.APP.store.getState()['features/base/config']) || {};
        const audio = config.audioQuality || {};
        return {
            prejoin: config.prejoinConfig ? config.prejoinConfig.enabled : null,
            disableAP: config.disableAP,
            disableAEC: config.disableAEC,
            disableNS: config.disableNS,
            disableAGC: config.disableAGC,
            stereo: audio.stereo,
            bitrate: audio.opusMaxAverageBitrate,
            p2p: config.p2p ? config.p2p.enabled : null,
            micMuted: config.startWithAudioMuted,
            cameraMuted: config.startWithVideoMuted,
        };
    });
    log('Room config: ' + JSON.stringify(applied));
    log('Bot joined the room');
    await ensureMicOn(false);

    setInterval(() => {
        inRoom()
            .then(async (joined) => {
                if (!joined) shutdown(1, 'Bot is not in the room');
                await hookRoom();
                await ensureMicOn(true);
            })
            .catch((err) => shutdown(1, 'Room check failed: ' + err.message));
    }, HEALTH_INTERVAL_MS);
}

main().catch((err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
    process.exit(1);
});
