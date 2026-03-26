#!/bin/sh
# reMarkable Korean (Hangul) Input Installer
# Handles: Type Folio / BT keyboard hangul + font + persistence
# Survives reboots (base filesystem writes) and firmware updates (files in /home)
# Usage: bash /home/root/rekoit/install.sh

set -e

BASEDIR="/home/root/rekoit"
STATE_FILE="$BASEDIR/install-state.conf"
FONT_SRC="$BASEDIR/fonts/NotoSansCJKkr-Regular.otf"
FONT_DST="/usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf"
SERVICE_SRC="$BASEDIR/hangul-daemon.service"
LIBEPAPER="/usr/lib/plugins/platforms/libepaper.so"
LIBEPAPER_TMPFS="/dev/shm/hangul-libepaper.so"
LIBEPAPER_BACKUP="$BASEDIR/backup/libepaper.so.original"
BT_BACKUP="$BASEDIR/bt-pairing"
BT_SRC="/var/lib/bluetooth"
HANGUL_INSTALL_LIB="$BASEDIR/install-hangul.sh"
BT_INSTALL_LIB="$BASEDIR/install-bt.sh"

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
echo " ReKoIt Installer v2.4"
echo "=========================================="
echo ""

# 설치 모드: env 우선, 없으면 마지막 설치 상태 유지
STATE_HANGUL=0
STATE_BT=0
STATE_BLUETOOTH_POWER_ON=0
STATE_SWAP_LEFT_CTRL_CAPSLOCK=0
STATE_BT_DEVICE_ADDRESS=""
STATE_LOCALES=""
if [ -f "$STATE_FILE" ]; then
    . "$STATE_FILE"
    STATE_HANGUL=${INSTALL_HANGUL:-1}
    STATE_BT=${INSTALL_BT:-0}
    STATE_BLUETOOTH_POWER_ON=${BLUETOOTH_POWER_ON:-0}
    STATE_SWAP_LEFT_CTRL_CAPSLOCK=${SWAP_LEFT_CTRL_CAPSLOCK:-0}
    STATE_BT_DEVICE_ADDRESS=${BT_DEVICE_ADDRESS:-}
    STATE_LOCALES=${KEYBOARD_LOCALES:-}
fi
INSTALL_HANGUL=${INSTALL_HANGUL:-$STATE_HANGUL}
INSTALL_BT=${INSTALL_BT:-$STATE_BT}
BLUETOOTH_POWER_ON=${BLUETOOTH_POWER_ON:-$STATE_BLUETOOTH_POWER_ON}
SWAP_LEFT_CTRL_CAPSLOCK=${SWAP_LEFT_CTRL_CAPSLOCK:-$STATE_SWAP_LEFT_CTRL_CAPSLOCK}
BT_DEVICE_ADDRESS=${BT_DEVICE_ADDRESS:-$STATE_BT_DEVICE_ADDRESS}
KEYBOARD_LOCALES=""
printf 'INSTALL_HANGUL=%s\nINSTALL_BT=%s\nBLUETOOTH_POWER_ON=%s\nSWAP_LEFT_CTRL_CAPSLOCK=%s\nBT_DEVICE_ADDRESS=%s\nKEYBOARD_LOCALES=%s\n' "$INSTALL_HANGUL" "$INSTALL_BT" "$BLUETOOTH_POWER_ON" "$SWAP_LEFT_CTRL_CAPSLOCK" "$BT_DEVICE_ADDRESS" "$KEYBOARD_LOCALES" > "$STATE_FILE"
echo "  Mode: hangul=$INSTALL_HANGUL, bt=$INSTALL_BT, btPower=$BLUETOOTH_POWER_ON, swapCtrlCaps=$SWAP_LEFT_CTRL_CAPSLOCK"
echo ""

if [ "$INSTALL_HANGUL" = "1" ]; then
    if [ ! -f "$HANGUL_INSTALL_LIB" ]; then
        echo "missing helper: $HANGUL_INSTALL_LIB" >&2
        exit 1
    fi
    . "$HANGUL_INSTALL_LIB"
fi

if [ "$INSTALL_BT" = "1" ]; then
    if [ ! -f "$BT_INSTALL_LIB" ]; then
        echo "missing helper: $BT_INSTALL_LIB" >&2
        exit 1
    fi
    . "$BT_INSTALL_LIB"
fi

# 1. Prepare filesystem
echo "[1/10] Preparing filesystem..."
mount -o remount,rw / 2>/dev/null || true
echo "  OK: Active rootfs mounted rw"

echo "[1.5/9] SKIP: on-screen keyboard support removed"

if [ "$INSTALL_BT" = "1" ]; then
    install_bt_module
else
    echo "[2/10] SKIP: bluetooth module auto-load disabled"
fi
if [ "$INSTALL_HANGUL" = "1" ]; then
    install_hangul_font
else
    echo "[3/10] SKIP: hangul font install disabled"
fi

echo "[4/10] SKIP: on-screen keyboard layouts removed"

echo "[5/10] SKIP: on-screen keyboard hook removed"

if [ "$INSTALL_BT" = "1" ]; then
    sync_bt_pairings
else
    echo "[6/10] SKIP: bluetooth pairing restore not requested"
fi
if [ "$INSTALL_HANGUL" = "1" ]; then
    install_hangul_runtime
else
    echo "[7/10] SKIP: hangul runtime install disabled"
fi
if [ "$INSTALL_BT" = "1" ]; then
    apply_bt_runtime_config
else
    echo "  OK: bluetooth runtime changes cleared"
fi
if [ "$INSTALL_HANGUL" = "1" ]; then
    backup_and_mount_libepaper
else
    echo "[8/10] SKIP: libepaper backup/runtime mount disabled"
fi

# 9. SWUpdate post-update hook (펌웨어 업데이트 후 한글 자동 복구)
echo "[9/10] Installing SWUpdate post-update hook..."
POST_UPDATE_SCRIPTS="post-update.sh"
if [ "$INSTALL_HANGUL" = "1" ]; then
    POST_UPDATE_SCRIPTS="$POST_UPDATE_SCRIPTS post-update-hangul.sh"
fi
if [ "$INSTALL_BT" = "1" ]; then
    POST_UPDATE_SCRIPTS="$POST_UPDATE_SCRIPTS post-update-bt.sh"
fi
for script in $POST_UPDATE_SCRIPTS; do
    if [ ! -f "$BASEDIR/$script" ]; then
        echo "  ERROR: missing $script"
        exit 1
    fi
    chmod +x "$BASEDIR/$script"
done
echo "  OK: post-update helpers ready"

# ReKoIt factory guard 설치 (rootfs에 직접)
if [ "$INSTALL_BT" = "1" ]; then
echo "  Installing ReKoIt safety guard..."
mkdir -p /opt/rekoit
cat > /opt/rekoit/factory-guard.sh << 'FGUARD_SCRIPT_EOF'
#!/bin/sh
# rekoit-factory-guard: 팩토리 리셋 후 ReKoIt rootfs 흔적 자동 정리
HOME_STATE="/home/root/rekoit"

HAS_BT_ARTIFACTS=0

if [ -f /etc/systemd/system/hangul-daemon.service ] || \
   [ -f /etc/systemd/system/rekoit-restore.service ] || \
   [ -f /etc/systemd/system/rekoit-bt-wake-reconnect.service ] || \
   [ -f /etc/modules-load.d/btnxpuart.conf ] || \
   [ -f /etc/swupdate/conf.d/99-rekoit-postupdate ]; then
    HAS_BT_ARTIFACTS=1
fi

if [ "$HAS_BT_ARTIFACTS" = "0" ]; then
    exit 0
fi
if ! mountpoint -q /home 2>/dev/null; then
    exit 0
fi
if [ -d "$HOME_STATE" ]; then
    exit 0
fi
mount -o remount,rw / 2>/dev/null || true
rm -f /etc/swupdate/conf.d/99-rekoit-postupdate
# ReKoIt 공통 서비스와 한글 입력 런타임 비활성화 및 제거
systemctl stop hangul-daemon.service 2>/dev/null || true
systemctl disable hangul-daemon.service 2>/dev/null || true
systemctl disable rekoit-restore.service 2>/dev/null || true
systemctl stop rekoit-bt-wake-reconnect.service 2>/dev/null || true
systemctl disable rekoit-bt-wake-reconnect.service 2>/dev/null || true
unmount_libepaper_mounts
rm -f "$LIBEPAPER_TMPFS"
rm -f /etc/systemd/system/hangul-daemon.service
rm -f /etc/systemd/system/rekoit-restore.service
rm -f /etc/systemd/system/rekoit-bt-wake-reconnect.service
rm -f /etc/systemd/system/multi-user.target.wants/hangul-daemon.service
rm -f /etc/systemd/system/multi-user.target.wants/rekoit-restore.service
rm -f /etc/systemd/system/multi-user.target.wants/rekoit-bt-wake-reconnect.service
rm -f /etc/modules-load.d/btnxpuart.conf
rm -f /etc/systemd/system/bluetooth.service.d/wait-for-hci.conf
rmdir /etc/systemd/system/bluetooth.service.d 2>/dev/null || true
# Restore ConditionPathIsDirectory in bluetooth.service (handle ## or #)
sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
sed -i '/^Privacy = off$/d' /etc/bluetooth/main.conf 2>/dev/null || true
sed -i '/^FastConnectable = true$/d' /etc/bluetooth/main.conf 2>/dev/null || true
# 한글 폰트 제거
rm -f /usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf
fc-cache -f 2>/dev/null || true
# 자기 자신 정리
rm -f /opt/rekoit/factory-guard.sh
rmdir /opt/rekoit 2>/dev/null || true
systemctl disable rekoit-factory-guard.service 2>/dev/null || true
rm -f /etc/systemd/system/rekoit-factory-guard.service
rm -f /etc/systemd/system/multi-user.target.wants/rekoit-factory-guard.service
systemctl daemon-reload
FGUARD_SCRIPT_EOF
chmod +x /opt/rekoit/factory-guard.sh

cat > /etc/systemd/system/rekoit-factory-guard.service << 'FGUARD_SVC_EOF'
[Unit]
Description=ReKoIt Factory Reset Guard
After=home.mount
Wants=home.mount
Before=xochitl.service

[Service]
Type=oneshot
ExecStart=/opt/rekoit/factory-guard.sh
RemainAfterExit=no

[Install]
WantedBy=multi-user.target
FGUARD_SVC_EOF
systemctl daemon-reload
systemctl enable rekoit-factory-guard.service 2>/dev/null || true
echo "  OK: ReKoIt safety guard installed"
else
rm -f /etc/systemd/system/rekoit-factory-guard.service
rm -f /etc/systemd/system/multi-user.target.wants/rekoit-factory-guard.service
rm -rf /opt/rekoit 2>/dev/null || true
fi

# swupdate conf.d 등록 (현재 세션용)
mkdir -p /etc/swupdate/conf.d
cat > /etc/swupdate/conf.d/99-rekoit-postupdate << 'CONFD_EOF'
# ReKoIt post-update hook
SWUPDATE_ARGS+=" -p /home/root/rekoit/post-update.sh"
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

            # hangul-daemon service
            if [ -f /etc/systemd/system/hangul-daemon.service ]; then
                cp /etc/systemd/system/hangul-daemon.service /mnt/rootfs/etc/systemd/system/
                mkdir -p /mnt/rootfs/etc/systemd/system/multi-user.target.wants
                ln -sf /etc/systemd/system/hangul-daemon.service /mnt/rootfs/etc/systemd/system/multi-user.target.wants/hangul-daemon.service
            fi

            if [ "$INSTALL_BT" = "1" ]; then
                sed -i 's|^ConditionPathIsDirectory=/sys/class/bluetooth|#ConditionPathIsDirectory=/sys/class/bluetooth|' /mnt/rootfs/usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
                if [ -f /mnt/rootfs/etc/bluetooth/main.conf ] && ! grep -q '^Privacy' /mnt/rootfs/etc/bluetooth/main.conf; then
                    sed -i '/^\[General\]/a Privacy = off' /mnt/rootfs/etc/bluetooth/main.conf
                fi
                if [ -f /mnt/rootfs/etc/bluetooth/main.conf ] && ! grep -q '^FastConnectable = true$' /mnt/rootfs/etc/bluetooth/main.conf; then
                    if grep -q '^#\?FastConnectable' /mnt/rootfs/etc/bluetooth/main.conf 2>/dev/null; then
                        sed -i 's/^#\?FastConnectable.*/FastConnectable = true/' /mnt/rootfs/etc/bluetooth/main.conf 2>/dev/null || true
                    else
                        sed -i '/^\[General\]/a FastConnectable = true' /mnt/rootfs/etc/bluetooth/main.conf
                    fi
                fi
                if [ -f /etc/systemd/system/rekoit-bt-wake-reconnect.service ]; then
                    cp /etc/systemd/system/rekoit-bt-wake-reconnect.service /mnt/rootfs/etc/systemd/system/
                    ln -sf /etc/systemd/system/rekoit-bt-wake-reconnect.service /mnt/rootfs/etc/systemd/system/multi-user.target.wants/rekoit-bt-wake-reconnect.service
                fi
                rm -f /mnt/rootfs/etc/systemd/system/rekoit-bt-agent.service
                rm -f /mnt/rootfs/etc/systemd/system/multi-user.target.wants/rekoit-bt-agent.service
            else
                sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /mnt/rootfs/usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
                sed -i '/^Privacy = off$/d' /mnt/rootfs/etc/bluetooth/main.conf 2>/dev/null || true
                sed -i '/^FastConnectable = true$/d' /mnt/rootfs/etc/bluetooth/main.conf 2>/dev/null || true
                rm -f /mnt/rootfs/etc/systemd/system/rekoit-bt-agent.service
                rm -f /mnt/rootfs/etc/systemd/system/rekoit-bt-wake-reconnect.service
                rm -f /mnt/rootfs/etc/systemd/system/multi-user.target.wants/rekoit-bt-agent.service
                rm -f /mnt/rootfs/etc/systemd/system/multi-user.target.wants/rekoit-bt-wake-reconnect.service
            fi

            # swupdate conf.d (post-update hook 영속화)
            mkdir -p /mnt/rootfs/etc/swupdate/conf.d
            cp /etc/swupdate/conf.d/99-rekoit-postupdate /mnt/rootfs/etc/swupdate/conf.d/ 2>/dev/null || true

            # ReKoIt 복구 서비스 (부팅 시 안전망)
            if [ -f /etc/systemd/system/rekoit-restore.service ]; then
                cp /etc/systemd/system/rekoit-restore.service /mnt/rootfs/etc/systemd/system/
                ln -sf /etc/systemd/system/rekoit-restore.service /mnt/rootfs/etc/systemd/system/multi-user.target.wants/rekoit-restore.service
            fi

        # ReKoIt factory guard 서비스 (팩토리 리셋 안전장치)
        if [ "$INSTALL_BT" = "1" ] && [ -f /etc/systemd/system/rekoit-factory-guard.service ]; then
            cp /etc/systemd/system/rekoit-factory-guard.service /mnt/rootfs/etc/systemd/system/
            ln -sf /etc/systemd/system/rekoit-factory-guard.service /mnt/rootfs/etc/systemd/system/multi-user.target.wants/rekoit-factory-guard.service
        else
                rm -f /mnt/rootfs/etc/systemd/system/rekoit-factory-guard.service
                rm -f /mnt/rootfs/etc/systemd/system/multi-user.target.wants/rekoit-factory-guard.service
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

# Restart xochitl (applying Korean font)
if [ "$INSTALL_HANGUL" = "1" ] && [ -f "$FONT_DST" ]; then
    echo "  Restarting xochitl (applying Korean font)..."
    systemctl restart xochitl
    sleep 3
fi

# Start hangul-daemon
if [ "$INSTALL_HANGUL" = "1" ] && [ -f "$BASEDIR/hangul-daemon" ]; then
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

if [ "$INSTALL_HANGUL" = "1" ]; then
    TOTAL=$((TOTAL+1))
    if [ -f "$FONT_DST" ]; then
        echo " [OK] Korean font installed"
        PASS=$((PASS+1))
    else
        echo " [--] Korean font: not installed"
    fi

    TOTAL=$((TOTAL+1))
    if systemctl is-active hangul-daemon.service >/dev/null 2>&1; then
        echo " [OK] Hangul daemon: running"
        PASS=$((PASS+1))
    else
        echo " [--] Hangul daemon: not running"
    fi
fi

if [ "$INSTALL_BT" = "1" ]; then
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
echo "   bash /home/root/rekoit/install.sh"
echo ""
