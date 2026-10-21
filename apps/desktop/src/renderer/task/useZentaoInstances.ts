import { useEffect, useState } from 'react';
import type { ZentaoInstanceRecord } from '@zeus/shared';
import type { DashboardClient } from '../dashboardClient.js';
import { zentaoInstancesChangedEvent } from '../features/integrations/integrationApiClient.js';
import { ZeusApiError } from '../transport/localApiTransport.js';

/** 所有任务入口读取同一服务端登录事实；网页 Cookie 不参与写入判断。 */
export function useZentaoInstances(client?: Pick<DashboardClient, 'loadZentaoInstances'> | null): ZentaoInstanceRecord[] {
  /** 未验证之前不展示任何禅道操作。 */
  const [instances, setInstances] = useState<ZentaoInstanceRecord[]>([]);
  useEffect(() => {
    if (!client) {
      setInstances([]);
      return;
    }
    /** 关闭或切换客户端后，旧响应不得恢复入口。 */
    let version = 0;
    /** 配置和写入事件只触发状态读取，不自动重试业务写入。 */
    const refresh = (): void => {
      /** 当前刷新身份阻止慢响应覆盖更新的登录结果。 */
      const current = ++version;
      void client
        .loadZentaoInstances()
        .then((loaded) => {
          if (current === version) setInstances(loaded.filter((instance) => instance.authenticationStatus === 'authenticated'));
        })
        .catch(() => {
          // 普通网络故障保留已有登录事实；登录及重试原因由设置页展示。
        });
    };
    setInstances([]);
    refresh();
    window.addEventListener(zentaoInstancesChangedEvent, refresh);
    return () => {
      version += 1;
      window.removeEventListener(zentaoInstancesChangedEvent, refresh);
    };
  }, [client]);
  return instances;
}

/** 远端可能已写入的失败禁止再次提交，原命令身份由客户端保留。 */
export function isZentaoWriteUnknown(error: unknown): boolean {
  return !(error instanceof ZeusApiError) || error.recoveryRequired || error.status >= 500 || error.error === 'ZEUS_INTEGRATION_COMMAND_OUTCOME_UNKNOWN';
}
