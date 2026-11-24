import type { CodexRuntimeUpdateProgress } from '../features/codex/codexApiClient.js';

/** 托管工具的安装与升级共用进度条，未获真实总量时只报告阶段。 */
export function ManagedCliProgress({
  program,
  zh,
  stage,
  progress,
  bytes,
}: {
  program: string;
  zh: boolean;
  stage: CodexRuntimeUpdateProgress['stage'];
  progress: number | null;
  bytes?: { received: number; total: number | null };
}): React.JSX.Element {
  /** 阶段文字独立于字节进度，下载完之后仍能说明在做什么。 */
  const labels: Record<CodexRuntimeUpdateProgress['stage'], [string, string]> = {
    checking: [`正在检查 ${program}`, `Checking ${program}`],
    waiting: ['正在等待当前工作结束', 'Waiting for current work to finish'],
    preparing: [`正在准备 ${program}`, `Preparing ${program}`],
    downloading: [`正在下载 ${program}`, `Downloading ${program}`],
    installing: [`正在安装 ${program}`, `Installing ${program}`],
    verifying: [`正在校验 ${program}`, `Verifying ${program}`],
    switching: [`正在重新连接 ${program}`, `Reconnecting ${program}`],
    completed: [`${program} 已就绪`, `${program} is ready`],
  };
  /** 向下取整，只有实际完成才显示 100%。 */
  const percent = progress === null ? null : Math.floor(progress * 100);
  /** 数字跟随系统语言，MB 使用十进制字节。 */
  const size = bytes ? new Intl.NumberFormat(zh ? 'zh-CN' : 'en-US', { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 }) : null;
  /** 当前阶段提供唯一的可读状态。 */
  const label = labels[stage][zh ? 0 : 1];
  return (
    <div className="managed-cli-progress">
      <div className="managed-cli-progress-heading">
        <span role="status">{label}</span>
        <span className="managed-cli-progress-amount">
          {bytes && size ? (
            <span>
              {size.format(bytes.received / 1_000_000)}
              {bytes.total === null ? '' : ` / ${size.format(bytes.total / 1_000_000)}`}
            </span>
          ) : null}
          {percent === null ? null : <strong>{percent}%</strong>}
        </span>
      </div>
      <div
        className="managed-cli-progress-track"
        data-indeterminate={percent === null || undefined}
        role="progressbar"
        aria-label={zh ? `${program} 进度` : `${program} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={percent === null ? label : undefined}
      >
        <span style={percent === null ? undefined : { inlineSize: `${percent}%` }} />
      </div>
    </div>
  );
}
