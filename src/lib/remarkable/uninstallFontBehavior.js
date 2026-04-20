export const HANGUL_FONT_PATH = "/home/root/.local/share/fonts/rekoit/NotoSansCJKkr-Regular.otf";
export const HANGUL_FONT_DIR = "/home/root/.local/share/fonts/rekoit";

/**
 * @typedef {object} FontRemovalOptions
 * @property {boolean} [deleteFont]
 * @property {string} [prefix]
 * @property {boolean} [ignoreMissing]
 * @property {boolean} [refreshCache]
 */

/**
 * @param {FontRemovalOptions} [options]
 */
export function buildFontRemovalCommands({
  deleteFont,
  prefix = "",
  ignoreMissing = false,
  refreshCache = false,
} = {}) {
  if (!deleteFont) {
    return "# 폰트 유지";
  }

  const fontDirPath = `${prefix}${HANGUL_FONT_DIR}`;
  const suffix = ignoreMissing ? " 2>/dev/null || true" : "";
  const commands = [`rm -rf ${fontDirPath}${suffix}`];

  if (refreshCache) {
    commands.push("fc-cache -f 2>/dev/null || true");
  }

  return commands.join("\n");
}
