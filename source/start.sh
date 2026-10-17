#!/bin/bash
set -euo pipefail

export HOME="${HOME:-/home/bot}"
export PATH="${HOME}/.local/bin:${PATH}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-bot}"

mkdir -p "${XDG_RUNTIME_DIR}" "${HOME}/.config/pulse"
chmod 700 "${XDG_RUNTIME_DIR}"

# flat-volumes=no so "pactl set-sink-volume music N%" is N% of the scale.
cat > "${HOME}/.config/pulse/daemon.conf" <<'EOF'
exit-idle-time = -1
flat-volumes = no
default-sample-format = s16le
default-sample-rate = 48000
default-sample-channels = 2
EOF

echo "Starting PulseAudio"
# -n: do not load default.pa. The container has no useful udev devices.
pulseaudio --daemonize=yes --exit-idle-time=-1 --log-target=stderr -n \
    --load="module-native-protocol-unix auth-anonymous=1" \
    --load="module-null-sink sink_name=music sink_properties=device.description=music"

for _ in $(seq 1 50); do
    if pactl info >/dev/null 2>&1; then
        break
    fi
    sleep 0.1
done

if ! pactl info >/dev/null 2>&1; then
    echo "PulseAudio did not start" >&2
    exit 1
fi

# Chromium plays remote voices here. The mic does not capture this sink,
# otherwise other participants hear themselves.
pactl load-module module-null-sink sink_name=speakers sink_properties=device.description=speakers
pactl set-default-sink speakers
pactl set-sink-mute speakers 1
pactl set-sink-mute music 0
pactl set-source-mute music.monitor 0
pactl set-sink-volume music 100%

# Chromium hides *.monitor devices. This source copies music.monitor.
pactl load-module module-remap-source \
    master=music.monitor \
    source_name=music_mic \
    channels=2 \
    channel_map=front-left,front-right \
    source_properties="device.description=MusicMic"
pactl set-source-mute music_mic 0
pactl set-default-source music_mic

PULSE_SOCKET="$(pactl info | awk -F': ' '/Server String/{print $2}')"
if [[ -n "${PULSE_SOCKET}" ]]; then
    export PULSE_SERVER="${PULSE_SOCKET}"
fi

# Capture only music_mic. Move every sink input except the music player off music.
(
    while true; do
        pactl list short source-outputs 2>/dev/null | while read -r id _rest; do
            pactl move-source-output "${id}" music_mic >/dev/null 2>&1 || true
        done
        pactl list sink-inputs | awk '
            /^Sink Input #/ {
                if (id != "") route()
                id=$3
                sub("#", "", id)
                name=""
            }
            /application.name = / {
                name=$3
                gsub(/"/, "", name)
            }
            function route() {
                if (name ~ /Chromium|Chrome/) print "speakers", id
                else if (name == "music-bot" || name == "ffmpeg" || name == "Lavf") print "music", id
            }
            END { if (id != "") route() }
        ' | while read -r sink id; do
            pactl move-sink-input "${id}" "${sink}" >/dev/null 2>&1 || true
        done
        sleep 2
    done
) &

if [[ -z "${CHROMIUM_PATH:-}" ]]; then
    if [[ -x /usr/bin/chromium ]]; then
        export CHROMIUM_PATH=/usr/bin/chromium
    elif [[ -x /usr/bin/chromium-browser ]]; then
        export CHROMIUM_PATH=/usr/bin/chromium-browser
    else
        echo "Chromium was not found" >&2
        exit 1
    fi
fi

echo "Updating yt-dlp"
if ! yt-dlp -U; then
    echo "Could not update yt-dlp, keeping the current version" >&2
fi

CHROMIUM_VERSION="$(dpkg-query -W -f='${Version}' chromium 2>/dev/null || true)"
echo "Chromium: ${CHROMIUM_VERSION}"
echo "Puppeteer: puppeteer-core 25.14.0, expects Chrome 155.0.8059.79"
case "${CHROMIUM_VERSION}" in
    155.*) ;;
    *)
        echo "Chromium is not version 155. Puppeteer 25.14.0 may hang on launch." >&2
        ;;
esac

echo "PulseAudio sources:"
pactl list short sources

# Dummy address so Chromium does not autolaunch dbus-daemon and hang.
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/tmp/dbus-none}"

# Do not use xvfb-run here. Its wait blocks on every child, including the
# PulseAudio loop above, so startup never continues.
export DISPLAY="${DISPLAY:-:99}"
DISPLAY_NUM="${DISPLAY#:}"
rm -f "/tmp/.X${DISPLAY_NUM}-lock"
mkdir -p /tmp/.X11-unix
echo "Starting Xvfb on ${DISPLAY}"
Xvfb "${DISPLAY}" -screen 0 1280x720x24 -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
for _ in $(seq 1 50); do
    if [[ -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ]]; then
        break
    fi
    sleep 0.1
done
if [[ ! -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ]]; then
    echo "Xvfb did not start" >&2
    cat /tmp/xvfb.log >&2 || true
    exit 1
fi

cd /app
echo "Starting the bot"
exec node bot.js
