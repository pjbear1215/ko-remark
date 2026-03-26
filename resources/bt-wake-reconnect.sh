#!/bin/sh

BASEDIR="/home/root/rekoit"
STATE_FILE="$BASEDIR/install-state.conf"
LAST_TRIGGER=0

is_valid_bluetooth_address() {
    printf '%s\n' "$1" | grep -Eq '^[0-9A-F:]{17}$'
}

list_known_paired_bluetooth_devices() {
    DEVICES=$(bluetoothctl devices Paired 2>/dev/null || true)
    TRUSTED=$(bluetoothctl devices Trusted 2>/dev/null || true)
    {
        printf '%s\n' "$DEVICES"
        printf '%s\n' "$TRUSTED"
    } | awk '/^Device [0-9A-F:]+/ {print $2}' | awk '!seen[$0]++'
}

list_paired_bluetooth_devices() {
    CANDIDATES=""
    KNOWN_DEVICES=$(list_known_paired_bluetooth_devices)
    if [ -n "${BT_DEVICE_ADDRESS:-}" ] && is_valid_bluetooth_address "$BT_DEVICE_ADDRESS" && printf '%s\n' "$KNOWN_DEVICES" | grep -Fxq "$BT_DEVICE_ADDRESS"; then
        CANDIDATES="$BT_DEVICE_ADDRESS"
    fi
    {
        printf '%s\n' "$CANDIDATES"
        printf '%s\n' "$KNOWN_DEVICES"
    } | awk '/^[0-9A-F:]{17}$/ {print $1}' | awk '!seen[$0]++'
}

log_line() {
    printf '%s\n' "rekoit-bt-wake: $*"
}

extract_address_from_line() {
    printf '%s\n' "$1" | grep -Eo '[0-9A-F:]{17}' | head -n 1
}

is_target_paired_bluetooth_address() {
    ADDR="$1"
    [ -n "$ADDR" ] || return 1
    for known in $(list_paired_bluetooth_devices); do
        [ "$known" = "$ADDR" ] && return 0
    done
    return 1
}

is_controller_powered() {
    POWERED=$(bluetoothctl show 2>/dev/null | awk '/Powered:/ {print $2; exit}')
    [ "$POWERED" = "yes" ]
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

device_has_input_node() {
    ADDR="$1"
    NAME=$(get_bluetooth_device_name "$ADDR")
    [ -n "$NAME" ] || return 1
    grep -Fq "Name=\"$NAME\"" /proc/bus/input/devices 2>/dev/null && return 0
    grep -Fq "Name=\"$NAME Keyboard\"" /proc/bus/input/devices 2>/dev/null && return 0
    return 1
}

remember_bluetooth_device_address() {
    ADDR="$1"
    if [ -z "$ADDR" ] || ! is_valid_bluetooth_address "$ADDR" || [ ! -f "$STATE_FILE" ]; then
        return 0
    fi
    if grep -q '^BT_DEVICE_ADDRESS=' "$STATE_FILE" 2>/dev/null; then
        sed -i "s/^BT_DEVICE_ADDRESS=.*/BT_DEVICE_ADDRESS=$ADDR/" "$STATE_FILE" 2>/dev/null || true
    else
        printf '\nBT_DEVICE_ADDRESS=%s\n' "$ADDR" >> "$STATE_FILE"
    fi
}

has_effectively_connected_paired_device() {
    for addr in $(list_paired_bluetooth_devices); do
        [ -n "$addr" ] || continue
        if bluetoothctl info "$addr" 2>/dev/null | grep -q 'Connected: yes' && device_has_input_node "$addr"; then
            return 0
        fi
    done
    return 1
}

disconnect_paired_bluetooth_devices() {
    for addr in $(list_paired_bluetooth_devices); do
        [ -n "$addr" ] || continue
        log_line "disconnect -> $addr"
        bluetoothctl disconnect "$addr" 2>/dev/null || true
    done
    sleep 1
}

reconnect_paired_bluetooth_devices() {
    FORCE_CYCLE="${1:-0}"
    ATTEMPT=1
    while [ "$ATTEMPT" -le 2 ]; do
        if [ "$FORCE_CYCLE" = "1" ]; then
            disconnect_paired_bluetooth_devices
        fi
        for addr in $(list_paired_bluetooth_devices); do
            [ -n "$addr" ] || continue
            log_line "connect attempt $ATTEMPT -> $addr"
            bluetoothctl power on 2>/dev/null || true
            bluetoothctl connect "$addr" 2>/dev/null || true
            sleep 2
            if bluetoothctl info "$addr" 2>/dev/null | grep -q 'Connected: yes'; then
                remember_bluetooth_device_address "$addr"
                log_line "connect success -> $addr"
                return 0
            fi
        done
        ATTEMPT=$((ATTEMPT + 1))
        sleep 2
    done
    log_line "connect failed"
    return 1
}

retry_reconnect_window() {
    FORCE_CYCLE="${1:-0}"
    WINDOW_ATTEMPT=1
    while [ "$WINDOW_ATTEMPT" -le 6 ]; do
        if [ "$FORCE_CYCLE" != "1" ] && has_effectively_connected_paired_device; then
            log_line "already connected"
            return 0
        fi
        log_line "retry window attempt $WINDOW_ATTEMPT"
        if reconnect_paired_bluetooth_devices "$FORCE_CYCLE"; then
            return 0
        fi
        WINDOW_ATTEMPT=$((WINDOW_ATTEMPT + 1))
        sleep 4
    done
    log_line "retry window exhausted"
    return 1
}

should_handle_trigger() {
    NOW=$(date +%s 2>/dev/null || echo 0)
    if [ "$NOW" -gt 0 ] && [ "$LAST_TRIGGER" -gt 0 ] && [ $((NOW - LAST_TRIGGER)) -lt 6 ]; then
        return 1
    fi
    LAST_TRIGGER=$NOW
    return 0
}

journalctl -f -n0 -o cat 2>/dev/null | while IFS= read -r line; do
    INSTALL_BT=0
    if [ -f "$STATE_FILE" ]; then
        . "$STATE_FILE"
    fi

    [ "$INSTALL_BT" = "1" ] || continue
    if ! is_controller_powered; then
        continue
    fi

    case "$line" in
        *"Controller resume with wake event"*)
            should_handle_trigger || continue
            log_line "wake event detected"
            sleep 1
            retry_reconnect_window || true
            ;;
        *"블루투스 입력 장치 재열거 대기:"*)
            should_handle_trigger || continue
            if has_effectively_connected_paired_device; then
                log_line "bluetooth reenumeration ignored while connected"
                continue
            fi
            log_line "bluetooth reenumeration trigger"
            sleep 1
            retry_reconnect_window 1 || true
            ;;
        *"Connected: no"*|*" disconnected with reason "*)
            ADDR=$(extract_address_from_line "$line")
            is_target_paired_bluetooth_address "$ADDR" || continue
            should_handle_trigger || continue
            if has_effectively_connected_paired_device; then
                log_line "bluetooth disconnect ignored while connected"
                continue
            fi
            log_line "bluetooth disconnect trigger -> $ADDR"
            sleep 1
            retry_reconnect_window 1 || true
            ;;
    esac
done
