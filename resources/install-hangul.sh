install_hangul_font() {
    echo "[3/10] Installing Korean font..."
    if [ -f "$FONT_SRC" ]; then
        mkdir -p "$(dirname "$FONT_DST")"
        cp "$FONT_SRC" "$FONT_DST"
        fc-cache -f 2>/dev/null || true
        echo "  OK: $FONT_DST"
    else
        echo "  SKIP: Font file not found ($FONT_SRC)"
    fi
}

install_hangul_runtime() {
    echo "[7/10] Installing hangul-daemon service..."
    systemctl stop xochitl 2>/dev/null || true
    systemctl stop hangul-daemon.service 2>/dev/null || true
    killall hangul-daemon 2>/dev/null || true
    unmount_libepaper_mounts
    rm -f "$LIBEPAPER_TMPFS"
    sleep 1

    if [ -f "$SERVICE_SRC" ]; then
        cp "$SERVICE_SRC" /etc/systemd/system/hangul-daemon.service
        mkdir -p /etc/systemd/system/multi-user.target.wants
        ln -sf /etc/systemd/system/hangul-daemon.service /etc/systemd/system/multi-user.target.wants/hangul-daemon.service
        systemctl daemon-reload
        systemctl enable hangul-daemon.service 2>/dev/null || true
        echo "  OK: hangul-daemon service installed"
    else
        echo "  SKIP: Service file not found ($SERVICE_SRC)"
    fi
}

backup_and_mount_libepaper() {
    echo "[8/10] Syncing libepaper.so backup..."
    if [ -f "$LIBEPAPER" ]; then
        if [ ! -f "$LIBEPAPER_BACKUP" ]; then
            cp "$LIBEPAPER" "$LIBEPAPER_BACKUP"
            echo "  OK: Initial backup created"
        else
            # 펌웨어 업데이트 감지 (MD5 비교)
            CURRENT_MD5=$(md5sum "$LIBEPAPER" | cut -d' ' -f1)
            BACKUP_MD5=$(md5sum "$LIBEPAPER_BACKUP" | cut -d' ' -f1)
            if [ "$CURRENT_MD5" != "$BACKUP_MD5" ]; then
                mv "$LIBEPAPER_BACKUP" "$BASEDIR/backup/libepaper.so.old-$(date +%Y%m%d)" 2>/dev/null || true
                cp "$LIBEPAPER" "$LIBEPAPER_BACKUP"
                echo "  OK: Backup updated for new firmware"
            else
                echo "  OK: Backup is up-to-date"
            fi
        fi
    fi
    if [ -f "$LIBEPAPER_BACKUP" ] || [ -f "$LIBEPAPER" ]; then
        ensure_tmpfs_libepaper
        echo "  OK: tmpfs-backed libepaper mounted"
    fi
}
