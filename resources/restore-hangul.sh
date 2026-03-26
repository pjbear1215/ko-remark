restore_hangul_runtime() {
    ensure_tmpfs_libepaper

    if [ -f "$FONT_SRC" ] && [ ! -f "$FONT_DST" ]; then
        mkdir -p "$(dirname "$FONT_DST")"
        cp "$FONT_SRC" "$FONT_DST"
        CHANGED=1
    fi
    if [ -f "$FONT_DST" ]; then
        fc-cache -f 2>/dev/null || true
    fi

    if [ -f "$SERVICE_SRC" ] && [ ! -f "/etc/systemd/system/hangul-daemon.service" ]; then
        cp "$SERVICE_SRC" /etc/systemd/system/hangul-daemon.service
        systemctl daemon-reload
        systemctl enable hangul-daemon.service 2>/dev/null || true
        systemctl start hangul-daemon.service 2>/dev/null || true
        CHANGED=1
    fi
}
