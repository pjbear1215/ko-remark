#!/bin/sh
# rekoit-post-update: 펌웨어 업데이트 직후 (재부팅 전) REKOIT 런타임 자동 주입
# SWUpdate -p 옵션으로 호출됨

LOG="/home/root/rekoit/post-update.log"
echo "[$(date)] post-update.sh 시작" >> "$LOG"

BASEDIR="/home/root/rekoit"
STATE_FILE="$BASEDIR/install-state.conf"
INSTALL_HANGUL=0
INSTALL_BT=0
if [ -f "$STATE_FILE" ]; then
    . "$STATE_FILE"
fi

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

if [ "$INSTALL_HANGUL" = "1" ]; then
    . "$BASEDIR/post-update-hangul.sh"
    post_update_hangul
fi
if [ "$INSTALL_BT" = "1" ]; then
    . "$BASEDIR/post-update-bt.sh"
    post_update_bt
fi

if [ -f "$BASEDIR/rekoit-restore.service" ]; then
    mkdir -p /mnt/updated/etc/systemd/system/multi-user.target.wants
    cp "$BASEDIR/rekoit-restore.service" /mnt/updated/etc/systemd/system/rekoit-restore.service
    ln -sf /etc/systemd/system/rekoit-restore.service /mnt/updated/etc/systemd/system/multi-user.target.wants/rekoit-restore.service
    echo "[$(date)] OK: rekoit-restore.service" >> "$LOG"
fi

mkdir -p /mnt/updated/etc/swupdate/conf.d
cat > /mnt/updated/etc/swupdate/conf.d/99-rekoit-postupdate << 'CONFD_EOF'
# REKOIT post-update hook (auto-replicated)
SWUPDATE_ARGS+=" -p /home/root/rekoit/post-update.sh"
CONFD_EOF
echo "[$(date)] OK: conf.d 자기 복제" >> "$LOG"

if [ "$INSTALL_BT" = "1" ] && [ -f /opt/rekoit/factory-guard.sh ]; then
    mkdir -p /mnt/updated/opt/rekoit
    cp /opt/rekoit/factory-guard.sh /mnt/updated/opt/rekoit/factory-guard.sh
    chmod +x /mnt/updated/opt/rekoit/factory-guard.sh
    cat > /mnt/updated/etc/systemd/system/rekoit-factory-guard.service << 'FGUARD_EOF'
[Unit]
Description=REKOIT Factory Reset Guard
After=home.mount
Wants=home.mount
Before=xochitl.service

[Service]
Type=oneshot
ExecStart=/opt/rekoit/factory-guard.sh
RemainAfterExit=no

[Install]
WantedBy=multi-user.target
FGUARD_EOF
    ln -sf /etc/systemd/system/rekoit-factory-guard.service /mnt/updated/etc/systemd/system/multi-user.target.wants/rekoit-factory-guard.service
    echo "[$(date)] OK: factory-guard 복제" >> "$LOG"
fi

sync
umount /mnt/updated 2>/dev/null || true

echo "[$(date)] post-update.sh 완료" >> "$LOG"
