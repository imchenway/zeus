import { join, win32 } from 'node:path';

/** 官方图文指南包含各平台安装步骤，浏览器不直接打开 shell 脚本。 */
export const codexInstallationGuideUrl = 'https://learn.chatgpt.com/docs/codex/cli';

/** 官方安装命令只用于明确的用户安装入口；Zeus 不在检测失败后自动执行。 */
export function codexInstallationCommand(codexHome?: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    /** PowerShell 单引号通过重复单引号保留路径原文。 */
    const assignments = codexHome ? `$env:CODEX_HOME='${codexHome.replaceAll("'", "''")}'; $env:CODEX_INSTALL_DIR='${win32.join(codexHome, 'bin').replaceAll("'", "''")}'; ` : '';
    return `${assignments}irm https://chatgpt.com/codex/install.ps1 | iex`;
  }
  /** POSIX 路径作为单个参数引用，不能把目录当成 shell 代码。 */
  const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
  return `curl -fsSL https://chatgpt.com/codex/install.sh | ${codexHome ? `CODEX_HOME=${quote(codexHome)} CODEX_INSTALL_DIR=${quote(join(codexHome, 'bin'))} ` : ''}sh`;
}

/** 官方 standalone 包支持 bin 布局与已有平铺布局，只在受管根中寻找。 */
export function codexStandaloneCandidates(codexHome: string): string[] {
  /** Windows 原生入口使用 exe 后缀。 */
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
  return [join(codexHome, 'packages', 'standalone', 'current', 'bin', name), join(codexHome, 'packages', 'standalone', 'current', name)];
}
