# Changelog

All notable changes to this project are documented in this file.

## [0.9.0] - 2026-04-21

### 🚀 Introducing REKOIT
REKOIT is a professional Korean input and Bluetooth management toolkit for reMarkable devices, built with a focus on system stability, performance, and a seamless user experience.

### ✨ Key Features
- **High-Performance Typing:** Features a specialized Hangul input daemon with **delayed commit** and adaptive preview logic, delivering a fast, responsive experience equivalent to native English input.
- **Advanced Bluetooth Control:**
  - Dedicated dashboard to monitor and manage all registered (paired/trusted) Bluetooth keyboards.
  - Secure removal logic that completely clears device system data and Identity Resolving Keys (IRK).
  - Real-time connection status indicators for instant feedback.
- **Comprehensive Platform Support:** Full support for **macOS**, **Linux**, and **WSL** (Windows Subsystem for Linux), including automatic dependency detection and guided setup.
- **Safety-First Installation:**
  - Built-in technical transparency guides explaining the non-destructive nature of the toolkit.
  - Mandatory environment checks to ensure a safe and successful setup process.
- **Custom Hardware Mapping:** Persistent support for swapping **CapsLock** and **LeftCtrl** keys at the hardware level.
- **User-Centric Documentation:** Restructured guides with hierarchical numbering and environment-specific troubleshooting tips.

### 🛡️ Technical Excellence & Reliability
- **Non-Destructive Architecture:** Utilizes `tmpfs` bind mounts to integrate system libraries, keeping the physical root filesystem in its original, pristine state.
- **Robust Persistence:** Features a dedicated `rekoit-restore` systemd service that automatically restores the environment after OS updates or reboots.
- **Clean System Integrity:** Operates without modifying standard shell configuration files (`.bashrc`, `.profile`), maintaining a standard and predictable system environment.
- **Atomic Asset Management:** Smart installation logic that dynamically handles fonts and binaries to keep the setup process lightweight and reliable.
- **Self-Healing Design:** Supports re-installing over existing setups to easily update configurations or restore functionality without a full uninstall.
