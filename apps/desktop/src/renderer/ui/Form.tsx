import { createContext, useContext, type FormHTMLAttributes } from 'react';
import { useAsyncAction } from './useAsyncAction.js';

/** 表单只向自身提交按钮传递忙碌状态，不锁住取消、导航或其他表单。 */
const FormPendingContext = createContext(false);

/** 提交按钮读取最近表单的异步状态。 */
export function useFormPending(): boolean {
  return useContext(FormPendingContext);
}

/** 保留原生表单布局与键盘提交，统一阻止异步提交期间的重复操作。 */
export function Form({ onSubmit, children, ...props }: FormHTMLAttributes<HTMLFormElement>) {
  /** 回车与点击提交进入同一条在途链，取消按钮保留独立交互。 */
  const action = useAsyncAction(onSubmit);
  return (
    <FormPendingContext.Provider value={action.pending}>
      <form
        {...props}
        aria-busy={action.pending || props['aria-busy'] || undefined}
        onSubmit={(event) => {
          if (!onSubmit) return;
          event.preventDefault();
          return action.execute(event);
        }}
      >
        {children}
      </form>
    </FormPendingContext.Provider>
  );
}
