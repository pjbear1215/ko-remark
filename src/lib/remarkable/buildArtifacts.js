import fs from "fs";

export function shouldRebuildArtifact(outputPath, sourcePaths) {
  if (!fs.existsSync(outputPath)) {
    return true;
  }

  const outputMtime = fs.statSync(outputPath).mtimeMs;
  return sourcePaths.some((sourcePath) => {
    if (!fs.existsSync(sourcePath)) {
      return true;
    }
    return fs.statSync(sourcePath).mtimeMs >= outputMtime;
  });
}
