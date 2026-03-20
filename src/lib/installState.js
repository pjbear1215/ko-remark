export const XOCHITL_DROPIN_DIR = "/usr/lib/systemd/system/xochitl.service.d";
export const XOCHITL_HOOK_DROPIN = `${XOCHITL_DROPIN_DIR}/zz-hangul-hook.conf`;

export function renderInstallState(state) {
  return `INSTALL_KEYPAD=0\nINSTALL_BT=${state.installBt ? "1" : "0"}\nSWAP_LEFT_CTRL_CAPSLOCK=${state.swapLeftCtrlCapsLock ? "1" : "0"}\nKEYBOARD_LOCALES=\n`;
}
