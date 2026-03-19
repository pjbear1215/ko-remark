#!/bin/sh
# reMarkable Korean (Hangul) Input Installer
# Handles: Type Folio / BT keyboard hangul + font + persistence
# Survives reboots (base filesystem writes) and firmware updates (files in /home)
# Usage: bash /home/root/bt-keyboard/install.sh

set -e

BASEDIR="/home/root/bt-keyboard"
STATE_FILE="$BASEDIR/install-state.conf"
FONT_SRC="$BASEDIR/fonts/NotoSansCJKkr-Regular.otf"
FONT_DST="/usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf"
SERVICE_SRC="$BASEDIR/hangul-daemon.service"
HOOK_SRC="$BASEDIR/hangul_hook.so"
KBDS_SRC="$BASEDIR/kbds"
KBDS_DST="/home/root/.kbds"
LIBEPAPER="/usr/lib/plugins/platforms/libepaper.so"
LIBEPAPER_TMPFS="/dev/shm/hangul-libepaper.so"
LIBEPAPER_BACKUP="$BASEDIR/backup/libepaper.so.original"
BT_BACKUP="$BASEDIR/bt-pairing"
BT_SRC="/var/lib/bluetooth"
HOOK_DROPIN_DIR="/usr/lib/systemd/system/xochitl.service.d"
HOOK_DROPIN="$HOOK_DROPIN_DIR/zz-hangul-hook.conf"
XOCHITL="/usr/bin/xochitl"
XOCHITL_ORIGINAL="$BASEDIR/backup/xochitl.original"
XOCHITL_PATCHED="$BASEDIR/backup/xochitl.patched"

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
            echo "failed to unmount existing libepaper mount: $mounted_target" >&2
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
        echo "tmpfs source missing after copy: $LIBEPAPER_TMPFS" >&2
        return 1
    fi
    if [ ! -f "$LIBEPAPER" ]; then
        echo "bind mount target missing: $LIBEPAPER" >&2
        return 1
    fi
    mount -o bind "$LIBEPAPER_TMPFS" "$LIBEPAPER"
}

echo "=========================================="
echo " reMarkable Korean Input Installer v2.4"
echo "=========================================="
echo ""

# 설치 모드: env 우선, 없으면 마지막 설치 상태 유지
STATE_KEYPAD=0
STATE_BT=0
STATE_LOCALES=""
if [ -f "$STATE_FILE" ]; then
    . "$STATE_FILE"
    STATE_KEYPAD=${INSTALL_KEYPAD:-0}
    STATE_BT=${INSTALL_BT:-0}
    STATE_LOCALES=${KEYBOARD_LOCALES:-}
fi
INSTALL_KEYPAD=0
INSTALL_BT=${INSTALL_BT:-$STATE_BT}
KEYBOARD_LOCALES=""
printf 'INSTALL_KEYPAD=%s\nINSTALL_BT=%s\nKEYBOARD_LOCALES=%s\n' "$INSTALL_KEYPAD" "$INSTALL_BT" "$KEYBOARD_LOCALES" > "$STATE_FILE"
echo "  Mode: keypad=removed, bt=$INSTALL_BT"
echo ""

# 1. Prepare filesystem
echo "[1/10] Preparing filesystem..."
mount -o remount,rw / 2>/dev/null || true
echo "  OK: Active rootfs mounted rw"

echo "[1.5/9] SKIP: on-screen keyboard support removed"

# 2. btnxpuart module auto-load
echo "[2/10] Setting up btnxpuart module..."
mkdir -p /etc/modules-load.d
echo "btnxpuart" > /etc/modules-load.d/btnxpuart.conf
modprobe btnxpuart 2>/dev/null || true
echo "  OK: btnxpuart.conf written"

# 3. Korean font
echo "[3/10] Installing Korean font..."
if [ -f "$FONT_SRC" ]; then
    mkdir -p "$(dirname "$FONT_DST")"
    cp "$FONT_SRC" "$FONT_DST"
    fc-cache -f 2>/dev/null || true
    echo "  OK: $FONT_DST"
else
    echo "  SKIP: Font file not found ($FONT_SRC)"
fi

echo "[4/10] SKIP: on-screen keyboard layouts removed"

echo "[5/10] SKIP: on-screen keyboard hook removed"

# 6. Bluetooth pairing backup/restore
echo "[6/10] Handling Bluetooth pairing..."
if [ -d "$BT_SRC" ] && ls "$BT_SRC"/*/cache 2>/dev/null | head -n 1 >/dev/null 2>&1; then
    mkdir -p "$BT_BACKUP"
    cp -a "$BT_SRC"/ "$BT_BACKUP/bluetooth_backup/" 2>/dev/null || true
    echo "  OK: Current pairing backed up"
elif [ -d "$BT_BACKUP/bluetooth_backup" ]; then
    cp -a "$BT_BACKUP/bluetooth_backup/"* "$BT_SRC/" 2>/dev/null || true
    systemctl restart bluetooth 2>/dev/null || true
    echo "  OK: Pairing restored from backup"
else
    echo "  SKIP: No pairing info (manual pairing needed)"
fi

# 7. hangul-daemon systemd service (BT keyboard) — bt only
if [ "$INSTALL_BT" = "1" ]; then
    echo "[7/10] Installing hangul-daemon service..."
    systemctl stop xochitl 2>/dev/null || true
    systemctl stop hangul-daemon.service 2>/dev/null || true
    killall hangul-daemon 2>/dev/null || true
    # Reset any existing libepaper tmpfs mount before reinstalling.
    unmount_libepaper_mounts
    rm -f "$LIBEPAPER_TMPFS"
    sleep 1

    if [ -f "$SERVICE_SRC" ]; then
        cp "$SERVICE_SRC" /etc/systemd/system/hangul-daemon.service
        mkdir -p /etc/systemd/system/multi-user.target.wants
        ln -sf /etc/systemd/system/hangul-daemon.service /etc/systemd/system/multi-user.target.wants/hangul-daemon.service

        # Fix bluetooth.service boot race: comment out ConditionPathIsDirectory
        # so bluetooth starts even if /sys/class/bluetooth isn't ready yet
        sed -i 's|^ConditionPathIsDirectory=/sys/class/bluetooth|#ConditionPathIsDirectory=/sys/class/bluetooth|' /usr/lib/systemd/system/bluetooth.service 2>/dev/null || true

        # Disable BLE Privacy — NXP chip rejects RPA, breaking LE scan
        if [ -f /etc/bluetooth/main.conf ] && ! grep -q '^Privacy' /etc/bluetooth/main.conf; then
            sed -i '/^\[General\]/a Privacy = off' /etc/bluetooth/main.conf
        fi

        systemctl daemon-reload
        systemctl enable hangul-daemon.service 2>/dev/null || true
        echo "  OK: hangul-daemon service installed"
        echo "  OK: bluetooth boot-race fix installed"
        echo "  OK: BLE privacy disabled (NXP compatibility)"
    else
        echo "  SKIP: Service file not found ($SERVICE_SRC)"
    fi
else
    echo "[7/10] SKIP: hangul-daemon (bt not selected)"
fi

# 8. libepaper.so backup
echo "[8/10] Backing up libepaper.so..."
if [ -f "$LIBEPAPER" ]; then
    if [ ! -f "$LIBEPAPER_BACKUP" ]; then
        cp "$LIBEPAPER" "$LIBEPAPER_BACKUP"
        echo "  OK: Initial backup created"
    else
        echo "  OK: Backup already exists"
    fi
fi
if [ "$INSTALL_BT" = "1" ] && [ -f "$LIBEPAPER_BACKUP" -o -f "$LIBEPAPER" ]; then
    ensure_tmpfs_libepaper
    echo "  OK: tmpfs-backed libepaper mounted"
fi

# 9. SWUpdate post-update hook (펌웨어 업데이트 후 한글 자동 복구)
echo "[9/10] Installing SWUpdate post-update hook..."
cat > "$BASEDIR/post-update.sh" << 'POSTUPDATE_EOF'
#!/bin/sh
# hangul-post-update: 펌웨어 업데이트 직후 (재부팅 전) 한글 파일 자동 주입
# SWUpdate -p 옵션으로 호출됨

LOG="/home/root/bt-keyboard/post-update.log"
echo "[$(date)] post-update.sh 시작" >> "$LOG"

BASEDIR="/home/root/bt-keyboard"
STATE_FILE="$BASEDIR/install-state.conf"
HOOK_DROPIN_DIR="/mnt/updated/usr/lib/systemd/system/xochitl.service.d"
HOOK_DROPIN="$HOOK_DROPIN_DIR/zz-hangul-hook.conf"

INSTALL_KEYPAD=0
INSTALL_BT=0
if [ -f "$STATE_FILE" ]; then
    . "$STATE_FILE"
fi

# 방금 업데이트된 파티션 감지 (= 현재 비활성 파티션)
CURRENT=$(mount | grep " / " | head -n 1 | awk '{print $1}')
case "$CURRENT" in
    /dev/mmcblk0p2) UPDATED=/dev/mmcblk0p3 ;;
    /dev/mmcblk0p3) UPDATED=/dev/mmcblk0p2 ;;
    *) echo "[$(date)] 파티션 감지 실패: $CURRENT" >> "$LOG"; exit 0 ;;
esac

echo "[$(date)] 업데이트된 파티션: $UPDATED" >> "$LOG"

mkdir -p /mnt/updated
umount /mnt/updated 2>/dev/null || true
mount -o rw "$UPDATED" /mnt/updated 2>/dev/null || mount "$UPDATED" /mnt/updated 2>/dev/null || true
mount -o remount,rw /mnt/updated 2>/dev/null || true
if [ ! -d /mnt/updated/etc ]; then
    echo "[$(date)] 마운트 실패" >> "$LOG"
    exit 0
fi
if mount | grep " /mnt/updated " | grep -q "(ro,"; then
    echo "[$(date)] 업데이트 파티션이 읽기 전용으로 마운트됨" >> "$LOG"
    umount /mnt/updated 2>/dev/null || true
    exit 0
fi

# 1. xochitl 바이너리 패치
XOCHITL="/mnt/updated/usr/bin/xochitl"
if [ "$INSTALL_KEYPAD" = "1" ] && [ -f "$XOCHITL" ] && strings "$XOCHITL" 2>/dev/null | grep -q ":/misc/keyboards/"; then
    cp "$XOCHITL" "$BASEDIR/backup/xochitl.original"
    md5sum "$XOCHITL" | cut -d" " -f1 > "$BASEDIR/backup/xochitl.original.md5"
    mkdir -p /mnt/updated/opt/bt-keyboard
    cp "$XOCHITL" /mnt/updated/opt/bt-keyboard/xochitl.original

    OFFSET1=$(strings -t d "$XOCHITL" | grep ":/misc/keyboards/" | head -n 1 | awk '{print $1}')
    if [ -n "$OFFSET1" ]; then
        printf "/home/root/.kbds/" | dd of="$XOCHITL" bs=1 seek="$OFFSET1" conv=notrunc 2>/dev/null
        echo "[$(date)] OK: xochitl 키보드 경로 패치 (offset=$OFFSET1)" >> "$LOG"
    fi

    OFFSET2=$(strings -t d "$XOCHITL" | grep "no_SV" | head -n 1 | awk '{print $1}')
    if [ -n "$OFFSET2" ]; then
        printf "ko_KR" | dd of="$XOCHITL" bs=1 seek="$OFFSET2" conv=notrunc 2>/dev/null
        SOFFSET=$(strings -t d "$XOCHITL" | grep "Swedish" | head -n 1 | awk '{print $1}')
        if [ -n "$SOFFSET" ]; then
            printf "Korean\0" | dd of="$XOCHITL" bs=1 seek="$SOFFSET" conv=notrunc 2>/dev/null
        fi
        echo "[$(date)] OK: xochitl 로케일 패치 (ko_KR/Korean)" >> "$LOG"
    fi

    cp "$XOCHITL" "$BASEDIR/backup/xochitl.patched"
    md5sum "$XOCHITL" | cut -d" " -f1 > "$BASEDIR/backup/xochitl.patched.md5"
else
    echo "[$(date)] SKIP: xochitl 이미 패치됨 또는 없음" >> "$LOG"
fi

# 2. 한글 폰트
FONT_SRC="$BASEDIR/fonts/NotoSansCJKkr-Regular.otf"
FONT_DST="/mnt/updated/usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf"
if [ -f "$FONT_SRC" ]; then
    mkdir -p "$(dirname "$FONT_DST")"
    cp "$FONT_SRC" "$FONT_DST"
    echo "[$(date)] OK: 한글 폰트" >> "$LOG"
fi

# 3. hangul_hook.so
if [ "$INSTALL_KEYPAD" = "1" ] && [ -f "$BASEDIR/hangul_hook.so" ]; then
    mkdir -p /mnt/updated/opt/bt-keyboard
    cp "$BASEDIR/hangul_hook.so" /mnt/updated/opt/bt-keyboard/hangul_hook.so
    echo "[$(date)] OK: hangul_hook.so" >> "$LOG"
fi

# 4. LD_PRELOAD
if [ "$INSTALL_KEYPAD" = "1" ]; then
mkdir -p "$HOOK_DROPIN_DIR"
cat > "$HOOK_DROPIN" << 'ZZHOOK_EOF'
[Service]
Environment=LD_PRELOAD=/opt/bt-keyboard/hangul_hook.so
ZZHOOK_EOF
echo "[$(date)] OK: LD_PRELOAD 설정" >> "$LOG"
fi

# 5. btnxpuart
if [ "$INSTALL_BT" = "1" ]; then
    mkdir -p /mnt/updated/etc/modules-load.d
    echo "btnxpuart" > /mnt/updated/etc/modules-load.d/btnxpuart.conf
fi

# 6. hangul-daemon.service
if [ "$INSTALL_BT" = "1" ] && [ -f "$BASEDIR/hangul-daemon.service" ]; then
    cp "$BASEDIR/hangul-daemon.service" /mnt/updated/etc/systemd/system/hangul-daemon.service
    mkdir -p /mnt/updated/etc/systemd/system/multi-user.target.wants
    ln -sf /etc/systemd/system/hangul-daemon.service /mnt/updated/etc/systemd/system/multi-user.target.wants/hangul-daemon.service
    echo "[$(date)] OK: hangul-daemon.service" >> "$LOG"
fi

# 6b. bluetooth boot-race fix for updated partition
if [ "$INSTALL_BT" = "1" ]; then
    sed -i 's|^ConditionPathIsDirectory=/sys/class/bluetooth|#ConditionPathIsDirectory=/sys/class/bluetooth|' /mnt/updated/usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
    echo "[$(date)] OK: bluetooth boot-race fix" >> "$LOG"
fi

# 6c. BLE Privacy fix for updated partition
if [ "$INSTALL_BT" = "1" ] && [ -f /mnt/updated/etc/bluetooth/main.conf ] && ! grep -q '^Privacy' /mnt/updated/etc/bluetooth/main.conf; then
    sed -i '/^\[General\]/a Privacy = off' /mnt/updated/etc/bluetooth/main.conf
    echo "[$(date)] OK: BLE privacy disabled" >> "$LOG"
fi

# 7. hangul-restore.service
cat > /mnt/updated/etc/systemd/system/hangul-restore.service << 'RESTORE_SVC_EOF'
[Unit]
Description=Hangul Input Restore
After=home.mount
Wants=home.mount
ConditionPathExists=/home/root/bt-keyboard/restore.sh

[Service]
Type=oneshot
ExecStart=/home/root/bt-keyboard/restore.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
RESTORE_SVC_EOF
mkdir -p /mnt/updated/etc/systemd/system/multi-user.target.wants
ln -sf /etc/systemd/system/hangul-restore.service /mnt/updated/etc/systemd/system/multi-user.target.wants/hangul-restore.service

# 8. swupdate conf.d 자기 복제
mkdir -p /mnt/updated/etc/swupdate/conf.d
cat > /mnt/updated/etc/swupdate/conf.d/99-hangul-postupdate << 'CONFD_EOF'
# Hangul post-update hook (auto-replicated)
SWUPDATE_ARGS+=" -p /home/root/bt-keyboard/post-update.sh"
CONFD_EOF
echo "[$(date)] OK: conf.d 자기 복제" >> "$LOG"

# 9. factory-guard 복제 (팩토리 리셋 안전장치)
if { [ "$INSTALL_KEYPAD" = "1" ] || [ "$INSTALL_BT" = "1" ]; } && [ -f /opt/bt-keyboard/factory-guard.sh ]; then
    mkdir -p /mnt/updated/opt/bt-keyboard
    cp /opt/bt-keyboard/factory-guard.sh /mnt/updated/opt/bt-keyboard/factory-guard.sh
    chmod +x /mnt/updated/opt/bt-keyboard/factory-guard.sh
    cat > /mnt/updated/etc/systemd/system/hangul-factory-guard.service << 'FGUARD_EOF'
[Unit]
Description=Hangul Factory Reset Guard
After=home.mount
Wants=home.mount
Before=xochitl.service

[Service]
Type=oneshot
ExecStart=/opt/bt-keyboard/factory-guard.sh
RemainAfterExit=no

[Install]
WantedBy=multi-user.target
FGUARD_EOF
    ln -sf /etc/systemd/system/hangul-factory-guard.service /mnt/updated/etc/systemd/system/multi-user.target.wants/hangul-factory-guard.service
    echo "[$(date)] OK: factory-guard 복제" >> "$LOG"
fi

sync
umount /mnt/updated 2>/dev/null || true

echo "[$(date)] post-update.sh 완료 (9/9 항목)" >> "$LOG"
POSTUPDATE_EOF
chmod +x "$BASEDIR/post-update.sh"
echo "  OK: post-update.sh created"

# factory-guard 설치 (rootfs에 직접)
if [ "$INSTALL_KEYPAD" = "1" ] || [ "$INSTALL_BT" = "1" ]; then
echo "  Installing factory-guard..."
mkdir -p /opt/bt-keyboard
cat > /opt/bt-keyboard/factory-guard.sh << 'FGUARD_SCRIPT_EOF'
#!/bin/sh
# hangul-factory-guard: 팩토리 리셋 후 hangul rootfs 흔적 자동 정리
XOCHITL="/usr/bin/xochitl"
KBDS="/home/root/.kbds"
ORIGINAL="/opt/bt-keyboard/xochitl.original"
HOME_STATE="/home/root/bt-keyboard"

HAS_PATCHED_XOCHITL=0
HAS_BT_ARTIFACTS=0

if strings "$XOCHITL" 2>/dev/null | grep -q "/home/root/.kbds/"; then
    HAS_PATCHED_XOCHITL=1
fi

if [ -f /etc/systemd/system/hangul-daemon.service ] || \
   [ -f /etc/systemd/system/hangul-restore.service ] || \
   [ -f /etc/modules-load.d/btnxpuart.conf ] || \
   [ -f /etc/swupdate/conf.d/99-hangul-postupdate ]; then
    HAS_BT_ARTIFACTS=1
fi

if [ "$HAS_PATCHED_XOCHITL" = "0" ] && [ "$HAS_BT_ARTIFACTS" = "0" ]; then
    exit 0
fi
if ! mountpoint -q /home 2>/dev/null; then
    exit 0
fi
if [ -d "$HOME_STATE" ]; then
    exit 0
fi
if [ "$HAS_PATCHED_XOCHITL" = "1" ] && [ -d "$KBDS" ] && [ -n "$(ls -A "$KBDS" 2>/dev/null)" ]; then
    exit 0
fi

mount -o remount,rw / 2>/dev/null || true
if [ "$HAS_PATCHED_XOCHITL" = "1" ] && [ -f "$ORIGINAL" ]; then
    cp "$ORIGINAL" "$XOCHITL"
    chmod 755 "$XOCHITL"
fi
rm -f /etc/systemd/system/xochitl.service.d/override.conf
rm -f /etc/systemd/system/xochitl.service.d/zz-hangul-hook.conf
rm -f /usr/lib/systemd/system/xochitl.service.d/zz-hangul-hook.conf
rmdir /etc/systemd/system/xochitl.service.d 2>/dev/null || true
CONF="/home/root/.config/remarkable/xochitl.conf"
if [ -f "$CONF" ]; then
    sed -i '/^Keyboard=ko_KR$/d' "$CONF"
    sed -i '/^Keyboard=/d' "$CONF"
    if ! grep -q '^Keyboard=' "$CONF"; then
        if grep -q '^\[General\]' "$CONF"; then
            sed -i '/^\[General\]/a\Keyboard=en_US' "$CONF"
        else
            echo "Keyboard=en_US" >> "$CONF"
        fi
    fi
fi
rm -f /etc/swupdate/conf.d/99-hangul-postupdate
# hangul-daemon, hangul-restore 서비스 비활성화 및 제거
systemctl stop hangul-daemon.service 2>/dev/null || true
systemctl disable hangul-daemon.service 2>/dev/null || true
systemctl disable hangul-restore.service 2>/dev/null || true
unmount_libepaper_mounts
rm -f "$LIBEPAPER_TMPFS"
rm -f /etc/systemd/system/hangul-daemon.service
rm -f /etc/systemd/system/hangul-restore.service
rm -f /etc/systemd/system/multi-user.target.wants/hangul-daemon.service
rm -f /etc/systemd/system/multi-user.target.wants/hangul-restore.service
rm -f /etc/modules-load.d/btnxpuart.conf
rm -f /etc/systemd/system/bluetooth.service.d/wait-for-hci.conf
rmdir /etc/systemd/system/bluetooth.service.d 2>/dev/null || true
# Restore ConditionPathIsDirectory in bluetooth.service (handle ## or #)
sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
sed -i '/^Privacy = off$/d' /etc/bluetooth/main.conf 2>/dev/null || true
# 한글 폰트 제거
rm -f /usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf
fc-cache -f 2>/dev/null || true
# 자기 자신 정리
rm -f /opt/bt-keyboard/factory-guard.sh
rm -f /opt/bt-keyboard/xochitl.original
rm -f /opt/bt-keyboard/hangul_hook.so
rmdir /opt/bt-keyboard 2>/dev/null || true
systemctl disable hangul-factory-guard.service 2>/dev/null || true
rm -f /etc/systemd/system/hangul-factory-guard.service
rm -f /etc/systemd/system/multi-user.target.wants/hangul-factory-guard.service
systemctl daemon-reload
FGUARD_SCRIPT_EOF
chmod +x /opt/bt-keyboard/factory-guard.sh

cat > /etc/systemd/system/hangul-factory-guard.service << 'FGUARD_SVC_EOF'
[Unit]
Description=Hangul Factory Reset Guard
After=home.mount
Wants=home.mount
Before=xochitl.service

[Service]
Type=oneshot
ExecStart=/opt/bt-keyboard/factory-guard.sh
RemainAfterExit=no

[Install]
WantedBy=multi-user.target
FGUARD_SVC_EOF
systemctl daemon-reload
systemctl enable hangul-factory-guard.service 2>/dev/null || true
echo "  OK: factory-guard installed"
else
rm -f /etc/systemd/system/hangul-factory-guard.service
rm -f /etc/systemd/system/multi-user.target.wants/hangul-factory-guard.service
rm -rf /opt/bt-keyboard 2>/dev/null || true
fi

# swupdate conf.d 등록 (현재 세션용)
mkdir -p /etc/swupdate/conf.d
cat > /etc/swupdate/conf.d/99-hangul-postupdate << 'CONFD_EOF'
# Hangul post-update hook
SWUPDATE_ARGS+=" -p /home/root/bt-keyboard/post-update.sh"
CONFD_EOF
echo "  OK: swupdate conf.d registered"

# 10. rootfs 영구 보존 (/etc는 overlayfs + tmpfs — 재부팅 시 유실)
echo "[10/10] Writing persistent files to rootfs..."
ROOTFS_DEV=$(mount | grep ' / ' | head -n1 | awk '{print $1}')
if [ -n "$ROOTFS_DEV" ]; then
    mkdir -p /mnt/rootfs
    umount /mnt/rootfs 2>/dev/null || true
    mount -o rw "$ROOTFS_DEV" /mnt/rootfs 2>/dev/null || mount "$ROOTFS_DEV" /mnt/rootfs 2>/dev/null || true
    mount -o remount,rw /mnt/rootfs 2>/dev/null || true
    if [ -d /mnt/rootfs/etc ]; then
        if mount | grep " /mnt/rootfs " | grep -q "(ro,"; then
            echo "  WARN: /mnt/rootfs mounted read-only, skipping persistent rootfs writes"
        else
            # btnxpuart module autoload
            if [ "$INSTALL_BT" = "1" ]; then
                mkdir -p /mnt/rootfs/etc/modules-load.d
                echo "btnxpuart" > /mnt/rootfs/etc/modules-load.d/btnxpuart.conf
            else
                rm -f /mnt/rootfs/etc/modules-load.d/btnxpuart.conf
            fi

            # xochitl drop-in (LD_PRELOAD)
            if [ "$INSTALL_KEYPAD" = "1" ]; then
                mkdir -p /mnt/rootfs/usr/lib/systemd/system/xochitl.service.d
                cat > /mnt/rootfs/usr/lib/systemd/system/xochitl.service.d/zz-hangul-hook.conf << 'HOOKCONF_EOF'
[Service]
Environment=LD_PRELOAD=/opt/bt-keyboard/hangul_hook.so
HOOKCONF_EOF
            fi

            # hangul-daemon service (BT keyboard)
            if [ "$INSTALL_BT" = "1" ] && [ -f /etc/systemd/system/hangul-daemon.service ]; then
                cp /etc/systemd/system/hangul-daemon.service /mnt/rootfs/etc/systemd/system/
                mkdir -p /mnt/rootfs/etc/systemd/system/multi-user.target.wants
                ln -sf /etc/systemd/system/hangul-daemon.service /mnt/rootfs/etc/systemd/system/multi-user.target.wants/hangul-daemon.service

                # bluetooth boot-race fix: comment out ConditionPathIsDirectory on rootfs
                sed -i 's|^ConditionPathIsDirectory=/sys/class/bluetooth|#ConditionPathIsDirectory=/sys/class/bluetooth|' /mnt/rootfs/usr/lib/systemd/system/bluetooth.service 2>/dev/null || true

                # BLE privacy fix
                if [ -f /mnt/rootfs/etc/bluetooth/main.conf ] && ! grep -q '^Privacy' /mnt/rootfs/etc/bluetooth/main.conf; then
                    sed -i '/^\[General\]/a Privacy = off' /mnt/rootfs/etc/bluetooth/main.conf
                fi
            fi

            # swupdate conf.d (post-update hook 영속화)
            mkdir -p /mnt/rootfs/etc/swupdate/conf.d
            cp /etc/swupdate/conf.d/99-hangul-postupdate /mnt/rootfs/etc/swupdate/conf.d/ 2>/dev/null || true

            # hangul-restore.service (부팅 시 안전망)
            if [ -f /etc/systemd/system/hangul-restore.service ]; then
                cp /etc/systemd/system/hangul-restore.service /mnt/rootfs/etc/systemd/system/
                ln -sf /etc/systemd/system/hangul-restore.service /mnt/rootfs/etc/systemd/system/multi-user.target.wants/hangul-restore.service
            fi

        # factory-guard 서비스 (팩토리 리셋 안전장치)
        if { [ "$INSTALL_KEYPAD" = "1" ] || [ "$INSTALL_BT" = "1" ]; } && [ -f /etc/systemd/system/hangul-factory-guard.service ]; then
            cp /etc/systemd/system/hangul-factory-guard.service /mnt/rootfs/etc/systemd/system/
            ln -sf /etc/systemd/system/hangul-factory-guard.service /mnt/rootfs/etc/systemd/system/multi-user.target.wants/hangul-factory-guard.service
        else
                rm -f /mnt/rootfs/etc/systemd/system/hangul-factory-guard.service
                rm -f /mnt/rootfs/etc/systemd/system/multi-user.target.wants/hangul-factory-guard.service
            fi

            sync
            echo "  OK: All /etc files written to rootfs"
        fi
    else
        echo "  WARN: rootfs mount failed"
    fi
    umount /mnt/rootfs 2>/dev/null || true
else
    echo "  WARN: rootfs device not found"
fi

# Restart services
echo ""
echo "Restarting services..."
systemctl daemon-reload

# Restart xochitl (applies LD_PRELOAD + font refresh)
if [ "$INSTALL_KEYPAD" = "1" ] && [ -f "$HOOK_SRC" ]; then
    echo "  Restarting xochitl (applying hangul hook)..."
    systemctl restart xochitl
    sleep 3
elif [ -f "$FONT_DST" ]; then
    echo "  Restarting xochitl (applying Korean font)..."
    systemctl restart xochitl
    sleep 3
fi

# Start hangul-daemon (BT keyboard) — bt only
if [ "$INSTALL_BT" = "1" ] && [ -f "$BASEDIR/hangul-daemon" ]; then
    echo "  Starting hangul-daemon..."
    systemctl start hangul-daemon.service 2>/dev/null || true
    sleep 2
fi

# Restart swupdate (applies -p post-update hook)
systemctl restart swupdate 2>/dev/null || true
echo "  OK: swupdate restarted (post-update hook active)"

# Verify
echo ""
echo "=========================================="
echo " Installation Complete!"
echo "=========================================="
echo ""

PASS=0
TOTAL=0

if [ "$INSTALL_KEYPAD" = "1" ]; then
    TOTAL=$((TOTAL+1))
    if strings "$XOCHITL" | grep -q '/home/root/.kbds/'; then
        echo " [OK] xochitl binary patched (external keyboard path)"
        PASS=$((PASS+1))
    else
        echo " [--] xochitl binary: NOT patched"
    fi

    TOTAL=$((TOTAL+1))
    if strings "$XOCHITL" | grep -q 'ko_KR'; then
        echo " [OK] xochitl binary patched (ko_KR locale)"
        PASS=$((PASS+1))
    else
        echo " [--] xochitl binary: ko_KR locale missing"
    fi
fi

TOTAL=$((TOTAL+1))
if [ -f "$FONT_DST" ]; then
    echo " [OK] Korean font installed"
    PASS=$((PASS+1))
else
    echo " [--] Korean font: not installed"
fi

if [ "$INSTALL_KEYPAD" = "1" ]; then
    TOTAL=$((TOTAL+1))
    KBD_INSTALLED=$(ls -d "$KBDS_DST"/*/keyboard_layout.json 2>/dev/null | wc -l)
    if [ "$KBD_INSTALLED" -ge 1 ]; then
        echo " [OK] Keyboard layouts installed ($KBD_INSTALLED locales)"
        PASS=$((PASS+1))
    else
        echo " [--] Keyboard layouts: not installed"
    fi

    TOTAL=$((TOTAL+1))
    if [ -f "$HOOK_DROPIN" ]; then
        echo " [OK] Hangul composition hook (LD_PRELOAD)"
        PASS=$((PASS+1))
    else
        echo " [--] Hangul composition hook: not installed"
    fi
fi

if [ "$INSTALL_BT" = "1" ]; then
    TOTAL=$((TOTAL+1))
    if systemctl is-active hangul-daemon.service >/dev/null 2>&1; then
        echo " [OK] BT keyboard daemon: running"
        PASS=$((PASS+1))
    else
        echo " [--] BT keyboard daemon: not running"
    fi

    TOTAL=$((TOTAL+1))
    if lsmod 2>/dev/null | grep -q btnxpuart; then
        echo " [OK] Bluetooth module: loaded"
        PASS=$((PASS+1))
    else
        echo " [--] Bluetooth module: not loaded"
    fi
fi

echo ""
echo " Components: $PASS/$TOTAL active"
echo ""
echo " All settings persist across reboots."
echo " After firmware update, run:"
echo "   bash /home/root/bt-keyboard/install.sh"
echo ""
