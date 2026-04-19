list_paired_bluetooth_devices() {
    CANDIDATES=""
    if printf '%s\n' "${BT_DEVICE_ADDRESS:-}" | grep -Eq '^[0-9A-F:]{17}$'; then
        CANDIDATES="$BT_DEVICE_ADDRESS"
    fi
    DEVICES=$(bluetoothctl devices Paired 2>/dev/null || true)
    TRUSTED=$(bluetoothctl devices Trusted 2>/dev/null || true)
    {
        printf '%s\n' "$CANDIDATES"
        printf '%s\n' "$DEVICES"
        printf '%s\n' "$TRUSTED"
    } | awk '/^Device [0-9A-F:]+/ {print $2} /^[0-9A-F:]{17}$/ {print $1}' | awk '!seen[$0]++'
}

get_bluetooth_device_name() {
    ADDR="$1"
    INFO=$(bluetoothctl info "$ADDR" 2>/dev/null || true)
    NAME=$(printf '%s\n' "$INFO" | sed -n 's/^[[:space:]]*Name: //p' | head -n 1)
    if [ -n "$NAME" ]; then
        printf '%s\n' "$NAME"
        return 0
    fi
    printf '%s\n' "$INFO" | sed -n 's/^[[:space:]]*Alias: //p' | head -n 1
}

find_latest_visible_bluetooth_address_by_name() {
    TARGET_NAME="$1"
    [ -n "$TARGET_NAME" ] || return 1

    DEVICES=$(bluetoothctl devices 2>/dev/null || true)
    MATCH=$(printf '%s\n' "$DEVICES" | awk -v target="$TARGET_NAME" '
        /^Device [0-9A-F:]+ / {
            addr=$2
            name=substr($0, index($0, $3))
            if (name == target) {
                latest=addr
            }
        }
        END {
            if (latest != "") {
                print latest
            }
        }
    ')
    if [ -n "$MATCH" ]; then
        printf '%s\n' "$MATCH"
        return 0
    fi

    SCAN_OUT=$(bluetoothctl --timeout 6 scan on 2>&1 || true)
    OBSERVED_ADDRS=$(printf '%s\n' "$SCAN_OUT" | awk '/Device [0-9A-F:]+/ {print $3}' | sort -u)
    for CANDIDATE_ADDR in $OBSERVED_ADDRS; do
        [ -n "$CANDIDATE_ADDR" ] || continue
        CANDIDATE_INFO=$(bluetoothctl info "$CANDIDATE_ADDR" 2>/dev/null || true)
        CANDIDATE_NAME=$(printf '%s\n' "$CANDIDATE_INFO" | sed -n 's/^[[:space:]]*Name: //p' | head -n 1)
        CANDIDATE_ALIAS=$(printf '%s\n' "$CANDIDATE_INFO" | sed -n 's/^[[:space:]]*Alias: //p' | head -n 1)
        if [ "$CANDIDATE_NAME" = "$TARGET_NAME" ] || [ "$CANDIDATE_ALIAS" = "$TARGET_NAME" ]; then
            printf '%s\n' "$CANDIDATE_ADDR"
            return 0
        fi
    done
    return 1
}

resolve_reconnect_bluetooth_address() {
    ADDR="$1"
    [ -n "$ADDR" ] || return 1
    NAME=$(get_bluetooth_device_name "$ADDR")
    RESOLVED=$(find_latest_visible_bluetooth_address_by_name "$NAME" 2>/dev/null || true)
    if [ -n "$RESOLVED" ]; then
        printf '%s\n' "$RESOLVED"
        return 0
    fi
    printf '%s\n' "$ADDR"
}

reconnect_paired_bluetooth_devices() {
    CONNECTED=1
    for addr in $(list_paired_bluetooth_devices); do
        [ -n "$addr" ] || continue
        TARGET_ADDR=$(resolve_reconnect_bluetooth_address "$addr" 2>/dev/null || printf '%s\n' "$addr")
        bluetoothctl connect "$TARGET_ADDR" 2>/dev/null || true
        sleep 2
        if bluetoothctl info "$TARGET_ADDR" 2>/dev/null | grep -q 'Connected: yes'; then
            if [ "$TARGET_ADDR" != "$addr" ] && [ -f "$STATE_FILE" ]; then
                sed -i "s/^BT_DEVICE_ADDRESS=.*/BT_DEVICE_ADDRESS=$TARGET_ADDR/" "$STATE_FILE" 2>/dev/null || true
            fi
            CONNECTED=0
            break
        fi
    done
    return $CONNECTED
}

restore_bt_runtime() {
    if grep -q '^ConditionPathIsDirectory=/sys/class/bluetooth' /usr/lib/systemd/system/bluetooth.service 2>/dev/null; then
        sed -i 's|^ConditionPathIsDirectory=/sys/class/bluetooth|#ConditionPathIsDirectory=/sys/class/bluetooth|' /usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
        CHANGED=1
    fi

    if [ -f /etc/bluetooth/main.conf ]; then
        if grep -q '^#\?Privacy' /etc/bluetooth/main.conf 2>/dev/null; then
            sed -i 's/^#\?Privacy.*/Privacy = off/' /etc/bluetooth/main.conf 2>/dev/null || true
            CHANGED=1
        elif ! grep -q '^Privacy = off$' /etc/bluetooth/main.conf 2>/dev/null; then
            sed -i '/^\[General\]/a Privacy = off' /etc/bluetooth/main.conf
            CHANGED=1
        fi
        if grep -q '^#\?FastConnectable' /etc/bluetooth/main.conf 2>/dev/null; then
            sed -i 's/^#\?FastConnectable.*/FastConnectable = true/' /etc/bluetooth/main.conf 2>/dev/null || true
            CHANGED=1
        elif ! grep -q '^FastConnectable = true$' /etc/bluetooth/main.conf 2>/dev/null; then
            sed -i '/^\[General\]/a FastConnectable = true' /etc/bluetooth/main.conf
            CHANGED=1
        fi
    fi

    if [ "$BLUETOOTH_POWER_ON" = "1" ]; then
        modprobe btnxpuart 2>/dev/null || true
        systemctl stop rekoit-bt-agent.service 2>/dev/null || true
        systemctl disable rekoit-bt-agent.service 2>/dev/null || true
        rm -f /etc/systemd/system/rekoit-bt-agent.service
        rm -f /etc/systemd/system/multi-user.target.wants/rekoit-bt-agent.service
        if [ -f "$BASEDIR/rekoit-bt-wake-reconnect.service" ] && [ ! -f /etc/systemd/system/rekoit-bt-wake-reconnect.service ]; then
            cp "$BASEDIR/rekoit-bt-wake-reconnect.service" /etc/systemd/system/rekoit-bt-wake-reconnect.service
            ln -sf /etc/systemd/system/rekoit-bt-wake-reconnect.service /etc/systemd/system/multi-user.target.wants/rekoit-bt-wake-reconnect.service
            CHANGED=1
        fi
        systemctl daemon-reload 2>/dev/null || true
        systemctl reset-failed bluetooth.service 2>/dev/null || true
        systemctl start bluetooth.service 2>/dev/null || true
        systemctl restart rekoit-bt-wake-reconnect.service 2>/dev/null || true
        for i in 1 2 3 4 5 6; do
            ACTIVE=$(systemctl is-active bluetooth.service 2>/dev/null || true)
            if [ "$ACTIVE" = "active" ]; then
                bluetoothctl power on 2>/dev/null || true
                sleep 1
                POWERED=$(bluetoothctl show 2>/dev/null | grep "Powered:" | awk '{print $2}')
                [ "$POWERED" = "yes" ] && break
            fi
            sleep 1
        done
        if [ "$POWERED" = "yes" ]; then
            reconnect_paired_bluetooth_devices || true
            (
                sleep 6
                bluetoothctl power on 2>/dev/null || true
                reconnect_paired_bluetooth_devices || true
            ) >/dev/null 2>&1 &
        fi
    else
        systemctl stop rekoit-bt-wake-reconnect.service 2>/dev/null || true
    fi
}
