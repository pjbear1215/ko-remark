#!/bin/sh
# rekoit-restore: re-apply REKOIT runtime after firmware update / reboot
# /home/root/rekoit/ survives firmware updates; system dirs do not

set -e

mount -o remount,rw / 2>/dev/null || true

BASEDIR="/home/root/rekoit"
STATE_FILE="$BASEDIR/install-state.conf"
FONT_SRC="$BASEDIR/fonts/NotoSansCJKkr-Regular.otf"
FONT_DST="/usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf"
SERVICE_SRC="$BASEDIR/hangul-daemon.service"
LIBEPAPER="/usr/lib/plugins/platforms/libepaper.so"
LIBEPAPER_TMPFS="/dev/shm/hangul-libepaper.so"
LIBEPAPER_BACKUP="$BASEDIR/backup/libepaper.so.original"
LIBEPAPER_NEW_BACKUP="$BASEDIR/backup/libepaper.so.latest"
CHANGED=0

INSTALL_BT=0
INSTALL_HANGUL=0
BLUETOOTH_POWER_ON=0
if [ -f "$STATE_FILE" ]; then
    . "$STATE_FILE"
fi

resolve_libepaper_mount_target() {
    if grep -q " $LIBEPAPER " /proc/mounts 2>/dev/null; then
        printf '%s\n' "$LIBEPAPER"
        return 0
    fi
    if grep -q ' /usr/lib/plugins/platforms ' /proc/mounts 2>/dev/null; then
        printf '%s\n' "/usr/lib/plugins/platforms"
        return 0
    fi
    return 1
}

unmount_libepaper_mounts() {
    while mounted_target="$(resolve_libepaper_mount_target)"; do
        if ! umount "$mounted_target" 2>/dev/null; then
            echo "[RESTORE] failed to unmount existing libepaper mount: $mounted_target" >&2
            return 1
        fi
    done
    return 0
}

ensure_tmpfs_libepaper() {
    src=""
    if [ -f "$LIBEPAPER_BACKUP" ]; then
        src="$LIBEPAPER_BACKUP"
    elif [ -f "$LIBEPAPER" ]; then
        src="$LIBEPAPER"
    fi

    if [ -z "$src" ]; then
        return 0
    fi

    unmount_libepaper_mounts

    rm -f "$LIBEPAPER_TMPFS"
    cp "$src" "$LIBEPAPER_TMPFS"
    if [ ! -f "$LIBEPAPER_TMPFS" ]; then
        echo "[RESTORE] tmpfs source missing after copy: $LIBEPAPER_TMPFS" >&2
        return 1
    fi
    if [ ! -f "$LIBEPAPER" ]; then
        echo "[RESTORE] bind mount target missing: $LIBEPAPER" >&2
        return 1
    fi
    mount -o bind "$LIBEPAPER_TMPFS" "$LIBEPAPER"
    echo "[RESTORE] tmpfs-backed libepaper mounted"
}

if [ -f "$LIBEPAPER" ] && [ -f "$LIBEPAPER_BACKUP" ]; then
    CURRENT_MD5=$(md5sum "$LIBEPAPER" | cut -d' ' -f1)
    BACKUP_MD5=$(md5sum "$LIBEPAPER_BACKUP" | cut -d' ' -f1)
    if [ "$CURRENT_MD5" != "$BACKUP_MD5" ]; then
        # 펌웨어 업데이트 감지됨: 기존 백업을 최신으로 교체
        mv "$LIBEPAPER_BACKUP" "$BASEDIR/backup/libepaper.so.old-$(date +%Y%m%d)" 2>/dev/null || true
        cp "$LIBEPAPER" "$LIBEPAPER_BACKUP"
        echo "[RESTORE] 펌웨어 업데이트 감지: libepaper.so 백업을 최신 버전으로 갱신 완료"
    fi
fi

if [ "$INSTALL_HANGUL" = "1" ]; then
    . "$BASEDIR/restore-hangul.sh"
    restore_hangul_runtime
fi
if [ "$INSTALL_BT" = "1" ]; then
    . "$BASEDIR/restore-bt.sh"
    restore_bt_runtime
fi

if [ "$CHANGED" -eq 1 ]; then
    systemctl daemon-reload
fi

exit 0
