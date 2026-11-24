import path from 'node:path';

// An output directory must not depend on a per-drive process cwd (D:folder).
// Resolve a rooted path (\folder) on the drive/share of Pi's working directory.
export function resolveOutputDir(cwd: string, dir: string, paths = path): string {
  if (paths.sep === '\\') {
    if (/^[a-z]:(?![\\/])/i.test(dir)) throw new Error('Invalid outputDir: use a full drive path (D:\\folder) or a relative directory without a drive letter');
    if (/^[\\/]{2}[?.][\\/]/.test(dir)) throw new Error('Invalid outputDir: use a standard drive or UNC path, not a device path');
  }
  if (!paths.isAbsolute(dir) && dir.split(/[\\/]/).includes('..')) throw new Error('Invalid outputDir: relative paths must not contain ".."');
  return paths.resolve(cwd,dir);
}

export function imageFileStem(name: string, paths = path): string {
  let base = paths.basename(name).replace(/\.[a-z0-9]+$/i, '') || 'image';
  if (paths.sep === '\\') {
    base = base.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[ .]+$/, '') || 'image';
    if (/^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³]) *(?:\.|$)/i.test(base)) base = '_'+base;
    // Leave room for the extension, numbering, and collision suffix.
    base = base.slice(0,230).replace(/[\uD800-\uDBFF]$/, '');
  }
  return base;
}

/** Only option values use quotes; ordinary prompt text (including apostrophes)
 * is not shell syntax. Backslashes in Windows paths are always literal. */
export function imagineTokens(args: string): string[] {
  const tokens: string[] = [];
  const re = /\s+|(?:(model|n|count|size|out|outputDir)=(["'])((?:(?!\2)[\s\S])*)\2(?=\s|$))|(\S+)/giy;
  for (let match; (match = re.exec(args));) {
    if (match[1]) tokens.push(`${match[1]}=${match[3]}`);
    else if (match[4]) {
      if (/^(?:model|n|count|size|out|outputDir)=["']/i.test(match[4])) throw new Error('选项值的引号不匹配；示例：out="D:\\My Images"');
      tokens.push(match[4]);
    }
  }
  return tokens;
}
