post_update_hangul() {
    FONT_SRC="$BASEDIR/fonts/NotoSansCJKkr-Regular.otf"
    FONT_DST="/mnt/updated/usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf"
    if [ -f "$FONT_SRC" ]; then
        mkdir -p "$(dirname "$FONT_DST")"
        cp "$FONT_SRC" "$FONT_DST"
        echo "[$(date)] OK: 한글 폰트" >> "$LOG"
    fi

    if [ -f "$BASEDIR/hangul-daemon.service" ]; then
        mkdir -p /mnt/updated/etc/systemd/system/multi-user.target.wants
        cp "$BASEDIR/hangul-daemon.service" /mnt/updated/etc/systemd/system/hangul-daemon.service
        ln -sf /etc/systemd/system/hangul-daemon.service /mnt/updated/etc/systemd/system/multi-user.target.wants/hangul-daemon.service
        echo "[$(date)] OK: hangul-daemon.service" >> "$LOG"
    fi
}
