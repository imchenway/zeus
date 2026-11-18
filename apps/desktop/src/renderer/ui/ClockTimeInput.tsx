import type { ComponentProps } from 'react';

/** 任务与自动化使用本地 HH:mm，文本输入使时钟界面独立于系统的上午、下午格式。 */
export function ClockTimeInput(props: Omit<ComponentProps<'input'>, 'type' | 'pattern' | 'maxLength' | 'placeholder'>) {
  return <input {...props} type="text" pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]" maxLength={5} placeholder="HH:mm" />;
}
