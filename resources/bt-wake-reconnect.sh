#!/bin/sh

BASEDIR="/home/root/rekoit"
STATE_FILE="$BASEDIR/install-state.conf"
BT_HELPER="$BASEDIR/rekoit-bt-helper"
SENTINEL="/tmp/rekoit-setup-active"
LOCKFILE="/tmp/rekoit-reconnect.lock"
POLL_CONFIG="/tmp/rekoit-poll-interval"

# Interval settings (seconds)
MIN_INTERVAL=10
MAX_INTERVAL=300

log_line() {
    printf '[%s] rekoit-bt-wake: %s\n' "$(date '+%H:%M:%S')" "$*"
}

is_setup_active() {
    if [ -f "$SENTINEL" ] || [ -f /tmp/rekoit-pair-SCAN.sh ] || [ -f /tmp/rekoit-pair-*.sh ]; then
        return 0
    fi
    return 1
}

is_any_device_connected() {
    if bluetoothctl info 2>/dev/null | grep -qi "Connected: yes"; then
        return 0
    fi
    return 1
}

# Get/Set current polling interval
get_interval() { cat "$POLL_CONFIG" 2>/dev/null || echo "$MIN_INTERVAL"; }
set_interval() { echo "$1" > "$POLL_CONFIG"; }

reset_polling() {
    CUR=$(get_interval)
    if [ "$CUR" -ne "$MIN_INTERVAL" ]; then
        log_line "RESET: User activity detected. Resetting poll interval to ${MIN_INTERVAL}s."
        set_interval "$MIN_INTERVAL"
    fi
    # Trigger an immediate scan if not already running
    reconnect_logic "active" &
}

ensure_adapter_powered() {
    if is_setup_active; then return 1; fi
    if ! bluetoothctl show 2>/dev/null | grep -qi "Powered: yes"; then
        log_line "ADAPTER: Powering on adapter..."
        bluetoothctl power on >/dev/null 2>&1
        sleep 1
    fi
    return 0
}

reconnect_to_addr() {
    ADDR="$1"
    [ -n "$ADDR" ] || return 1
    if is_setup_active; then return 1; fi
    bluetoothctl trust "$ADDR" >/dev/null 2>&1
    
    for i in 1 2 3; do
        if is_setup_active; then return 1; fi
        if bluetoothctl info "$ADDR" 2>/dev/null | grep -qi "Connected: yes"; then return 0; fi
        log_line "ACTION: Connecting to $ADDR (Attempt $i)..."
        bluetoothctl connect "$ADDR" >/dev/null 2>&1
        sleep 2
        if bluetoothctl info "$ADDR" 2>/dev/null | grep -qi "Connected: yes"; then
            log_line "SUCCESS: Connected to $ADDR"
            return 0
        fi
    done
    return 1
}

reconnect_logic() {
    MODE="$1"
    if is_setup_active; then return 0; fi
    if [ -f "$LOCKFILE" ]; then
        PID=$(cat "$LOCKFILE" 2>/dev/null)
        if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then return 0; fi
    fi
    echo $$ > "$LOCKFILE"
    trap 'rm -f "$LOCKFILE"' EXIT

    ensure_adapter_powered || { rm -f "$LOCKFILE"; return 0; }

    FOUND=0
    # 1. Standard Reconnect
    PAIRED_ADDRS=$(bluetoothctl devices Paired 2>/dev/null | awk '/[Dd]evice [0-9a-fA-F:]+/ {print $2}')
    for addr in $PAIRED_ADDRS; do
        if is_setup_active; then break; fi
        if ! bluetoothctl info "$addr" 2>/dev/null | grep -qi "Connected: yes"; then
            if reconnect_to_addr "$addr"; then FOUND=1; fi
        else
            FOUND=1
        fi
    done

    # 2. RPA Discovery
    if [ "$MODE" = "active" ] && [ "$FOUND" -eq 0 ]; then
        [ -f "$STATE_FILE" ] && . "$STATE_FILE"
        if [ -n "${BT_DEVICE_IRK:-}" ] && [ -f "$BT_HELPER" ]; then
            log_line "ACTION: Scanning for RPA matches..."
            SCAN_OUT=$(bluetoothctl --timeout 8 scan on 2>&1 || true)
            printf '%s\n' "$SCAN_OUT" | grep -i "Device " | while read -r LINE; do
                if is_setup_active; then break; fi
                C_MAC=$(echo "$LINE" | grep -Ei '[0-9a-f:]{17}' | head -n 1 | tr '[:upper:]' '[:lower:]')
                [ -n "$C_MAC" ] || continue
                if "$BT_HELPER" resolve-rpa "$BT_DEVICE_IRK" "$C_MAC" >/dev/null 2>&1; then
                    log_line "MATCH: Found $C_MAC"
                    KNOWN_MAC=$(echo "${BT_DEVICE_ADDRESS:-}" | tr '[:upper:]' '[:lower:]')
                    if [ "$C_MAC" != "$KNOWN_MAC" ]; then
                        sed -i "s/^BT_DEVICE_ADDRESS=.*/BT_DEVICE_ADDRESS=\"$C_MAC\"/" "$STATE_FILE"
                    fi
                    reconnect_to_addr "$C_MAC"
                    break
                fi
            done
        fi
    fi
    
    wait
    rm -f "$LOCKFILE"
    trap - EXIT
}

# Watch for events that indicate user activity
event_monitor() {
    log_line "Starting Activity Monitor..."
    journalctl -f -n0 -o cat 2>/dev/null | while IFS= read -r line; do
        [ -n "$line" ] || continue
        case "$line" in *"rekoit-bt-wake"*) continue ;; esac

        # Activity indicators: Hardware wake, System resume, Power key
        if echo "$line" | grep -qiE "ps_state = 0x00|Waking up|resumed|PowerKey"; then
            if is_setup_active; then continue; fi
            reset_polling
        fi
    done
}

polling_loop() {
    log_line "Starting Adaptive Polling Loop..."
    set_interval "$MIN_INTERVAL"
    
    while true; do
        INTERVAL=$(get_interval)
        sleep "$INTERVAL"
        
        if is_setup_active; then continue; fi
        
        if is_any_device_connected; then
            # Connected! Reset interval and be quiet.
            set_interval "$MIN_INTERVAL"
            continue
        fi

        # Reconnect logic (will log if connection attempt starts)
        reconnect_logic "active"
        
        # If still not connected, back off
        if ! is_any_device_connected; then
            NEW_INTERVAL=$((INTERVAL * 2))
            if [ "$NEW_INTERVAL" -gt "$MAX_INTERVAL" ]; then NEW_INTERVAL=$MAX_INTERVAL; fi
            set_interval "$NEW_INTERVAL"
        else
            set_interval "$MIN_INTERVAL"
        fi
    done
}

log_line "Reconnect Monitor v10.0 (Adaptive Activity-Aware Mode)"
log_line "==============================================="

rm -f "$LOCKFILE"
set_interval "$MIN_INTERVAL"

event_monitor &
polling_loop &

wait
