post_update_bt() {
    mkdir -p /mnt/updated/etc/modules-load.d
    echo "btnxpuart" > /mnt/updated/etc/modules-load.d/btnxpuart.conf
    echo "[$(date)] OK: btnxpuart.conf" >> "$LOG"

    sed -i 's|^ConditionPathIsDirectory=/sys/class/bluetooth|#ConditionPathIsDirectory=/sys/class/bluetooth|' /mnt/updated/usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
    echo "[$(date)] OK: bluetooth boot-race fix" >> "$LOG"

    if [ -f /mnt/updated/etc/bluetooth/main.conf ]; then
        if grep -q '^#\?Privacy' /mnt/updated/etc/bluetooth/main.conf 2>/dev/null; then
            sed -i 's/^#\?Privacy.*/Privacy = off/' /mnt/updated/etc/bluetooth/main.conf 2>/dev/null || true
        else
            sed -i '/^\[General\]/a Privacy = off' /mnt/updated/etc/bluetooth/main.conf
        fi
        if grep -q '^#\?FastConnectable' /mnt/updated/etc/bluetooth/main.conf 2>/dev/null; then
            sed -i 's/^#\?FastConnectable.*/FastConnectable = true/' /mnt/updated/etc/bluetooth/main.conf 2>/dev/null || true
        else
            sed -i '/^\[General\]/a FastConnectable = true' /mnt/updated/etc/bluetooth/main.conf
        fi
        echo "[$(date)] OK: BLE privacy disabled" >> "$LOG"
        echo "[$(date)] OK: FastConnectable enabled" >> "$LOG"
    fi

    rm -f /mnt/updated/etc/systemd/system/rekoit-bt-agent.service
    rm -f /mnt/updated/etc/systemd/system/multi-user.target.wants/rekoit-bt-agent.service
    echo "[$(date)] OK: legacy rekoit-bt-agent.service removed" >> "$LOG"
    if [ -f "$BASEDIR/rekoit-bt-wake-reconnect.service" ]; then
        mkdir -p /mnt/updated/etc/systemd/system/multi-user.target.wants
        cp "$BASEDIR/rekoit-bt-wake-reconnect.service" /mnt/updated/etc/systemd/system/rekoit-bt-wake-reconnect.service
        ln -sf /etc/systemd/system/rekoit-bt-wake-reconnect.service /mnt/updated/etc/systemd/system/multi-user.target.wants/rekoit-bt-wake-reconnect.service
        echo "[$(date)] OK: rekoit-bt-wake-reconnect.service" >> "$LOG"
    fi

}
