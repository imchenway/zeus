import { useRef, useState } from 'react';
import { reportApplicationError } from '../ui/ApplicationErrorDialog.js';

/** 设置编辑共用保存状态，只有最后一笔写入成功才显示已保存。 */
export type SettingsSaveState = 'idle' | 'saving' | 'saved' | 'failed';

/** 按交互顺序写入，失败不重放；调用方保留草稿并允许用户再次编辑。 */
export function useSettingsAutosave(language: 'zh-CN' | 'en-US') {
  /** 队列在组件离开后仍完成已经确认的本地写入。 */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  /** 后来的修改不能被较早的回执标记为已保存。 */
  const revision = useRef(0);
  /** 仅保存反馈进入渲染状态。 */
  const [status, setStatus] = useState<SettingsSaveState>('idle');

  /** 闭包必须捕获本次输入及记录身份，不能在执行时借用另一个编辑器的草稿。 */
  function save(write: () => Promise<unknown>): Promise<boolean> {
    /** 当前操作拥有反馈的序号。 */
    const current = ++revision.current;
    setStatus('saving');
    /** 队列中的失败被消费，因此不会阻断用户后续明确修改。 */
    const result = queue.current.then(write).then(
      () => {
        if (revision.current === current) setStatus('saved');
        return true;
      },
      (error: unknown) => {
        if (revision.current === current) setStatus('failed');
        reportApplicationError(error, { language: language === 'zh-CN' ? 'zh-CN' : 'en' });
        return false;
      },
    );
    queue.current = result;
    return result;
  }

  /** 切换记录时重置显示，不取消已经排入队列的写入。 */
  function reset(): void {
    revision.current += 1;
    setStatus('idle');
  }
  return { status, save, reset };
}

/** 页面右上角统一的真实保存结果。 */
export function SettingsSaveStatus(props: { status: SettingsSaveState; language: 'zh-CN' | 'en-US' }) {
  /** 文案跟随当前页面语言。 */
  const zh = props.language === 'zh-CN';
  return (
    <span className="settings-save-status" role="status" data-state={props.status}>
      {props.status === 'saving' ? (zh ? '正在保存…' : 'Saving…') : props.status === 'saved' ? (zh ? '已保存' : 'Saved') : props.status === 'failed' ? (zh ? '未保存，请重试' : 'Not saved. Retry.') : null}
    </span>
  );
}
