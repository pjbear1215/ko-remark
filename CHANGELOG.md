# Changelog

All notable changes to this web installer should be documented in this file.

## 0.0.2

- Improved Bluetooth reconnection logic for multi-pairing keyboards (e.g., HHKB).
- Added automatic re-pairing (active repair) when 'evdevkeyboard' input loss is detected.
- Reduced wake trigger cooldown to 10s for better responsiveness during device switching.
- Optimized monitor loop by caching discovery state to reduce CPU load.
- Added 'trust' reinforcement to the passive reconnection flow.
