install_bt_module() {
    if [ "$INSTALL_BT" = "1" ]; then
        echo "[2/10] Setting up btnxpuart module..."
        mkdir -p /etc/modules-load.d
        echo "btnxpuart" > /etc/modules-load.d/btnxpuart.conf
        modprobe btnxpuart 2>/dev/null || true
        echo "  OK: btnxpuart.conf written"
    else
        echo "[2/10] SKIP: bluetooth module auto-load disabled"
        rm -f /etc/modules-load.d/btnxpuart.conf
    fi
}

sync_bt_pairings() {
    if [ "$INSTALL_BT" = "1" ]; then
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
    else
        echo "[6/10] SKIP: bluetooth pairing restore not requested"
    fi
}

apply_bt_runtime_config() {
    if [ "$INSTALL_BT" = "1" ]; then
        sed -i 's|^ConditionPathIsDirectory=/sys/class/bluetooth|#ConditionPathIsDirectory=/sys/class/bluetooth|' /usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
        if [ -f /etc/bluetooth/main.conf ]; then
            if grep -q '^#\?Privacy' /etc/bluetooth/main.conf 2>/dev/null; then
                sed -i 's/^#\?Privacy.*/Privacy = off/' /etc/bluetooth/main.conf 2>/dev/null || true
            else
                sed -i '/^\[General\]/a Privacy = off' /etc/bluetooth/main.conf
            fi
            if grep -q '^#\?FastConnectable' /etc/bluetooth/main.conf 2>/dev/null; then
                sed -i 's/^#\?FastConnectable.*/FastConnectable = true/' /etc/bluetooth/main.conf 2>/dev/null || true
            else
                sed -i '/^\[General\]/a FastConnectable = true' /etc/bluetooth/main.conf
            fi
        fi
        systemctl stop rekoit-bt-agent.service 2>/dev/null || true
        systemctl disable rekoit-bt-agent.service 2>/dev/null || true
        rm -f /etc/systemd/system/rekoit-bt-agent.service
        rm -f /etc/systemd/system/multi-user.target.wants/rekoit-bt-agent.service
        if [ -f "$BASEDIR/rekoit-bt-wake-reconnect.service" ]; then
            cp "$BASEDIR/rekoit-bt-wake-reconnect.service" /etc/systemd/system/rekoit-bt-wake-reconnect.service
            mkdir -p /etc/systemd/system/multi-user.target.wants
            ln -sf /etc/systemd/system/rekoit-bt-wake-reconnect.service /etc/systemd/system/multi-user.target.wants/rekoit-bt-wake-reconnect.service
            systemctl enable rekoit-bt-wake-reconnect.service 2>/dev/null || true
            systemctl restart rekoit-bt-wake-reconnect.service 2>/dev/null || true
        fi
        echo "  OK: bluetooth boot-race fix installed"
        echo "  OK: BLE privacy disabled (NXP compatibility)"
        echo "  OK: fast reconnect acceptance enabled"
        echo "  OK: legacy bluetooth agent removed"
        echo "  OK: wake reconnect monitor enabled"
    else
        sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
        sed -i '/^Privacy = off$/d' /etc/bluetooth/main.conf 2>/dev/null || true
        sed -i '/^FastConnectable = true$/d' /etc/bluetooth/main.conf 2>/dev/null || true
        systemctl stop rekoit-bt-agent.service 2>/dev/null || true
        systemctl disable rekoit-bt-agent.service 2>/dev/null || true
        systemctl stop rekoit-bt-wake-reconnect.service 2>/dev/null || true
        systemctl disable rekoit-bt-wake-reconnect.service 2>/dev/null || true
        rm -f /etc/systemd/system/rekoit-bt-agent.service
        rm -f /etc/systemd/system/rekoit-bt-wake-reconnect.service
        rm -f /etc/systemd/system/multi-user.target.wants/rekoit-bt-agent.service
        rm -f /etc/systemd/system/multi-user.target.wants/rekoit-bt-wake-reconnect.service
        echo "  OK: bluetooth runtime changes cleared"
    fi
}
