import {reportApplicationError} from './ui/ApplicationErrorDialog.js';

export interface StorageRecoveryFaultState {
    readsAvailable: boolean;
    phase: 'ready' | 'running' | 'failed';
}

/**
 * 存储首错只记录诊断事实；恢复操作由工作区内联恢复条显式提供，
 * 避免全局错误出口吞掉动作或重新引入模态弹窗。
 */
export function reportStorageReadOnlyFault(language: 'zh-CN' | 'en', readsAvailable: boolean): StorageRecoveryFaultState {
  const error = Object.assign(new Error(language === 'zh-CN' ? (readsAvailable ? '存储已进入只读保护。' : '存储读写已停止。') : readsAvailable ? 'Storage entered read-only protection.' : 'Storage reads and writes stopped.'), {
    code: 'ZEUS_STORAGE_READ_ONLY_FAULT',
  });
    reportApplicationError(error, {language});
    return {readsAvailable, phase: 'ready'};
}
