import { workManagementInputSha256 } from './workManagementCommandApplication.js';

/** 独立员工指派在原会话中展示具体范围，确认只绑定本次工具调用和原始参数。 */
export function taskWorkAssignmentApproval(callId: string, args: Record<string, unknown>) {
  return {
    taskWorkAssignment: { callId, inputSha256: workManagementInputSha256(args) },
    command: `安排数字员工：${String(args.employeeId ?? '')}\n工作：${String(args.title ?? '')}`,
    reason: `${String(args.description ?? '')}\n\n此操作会创建或指派独立工作。仅确认本次安排，不修改任何会话的权限。`,
  };
}
