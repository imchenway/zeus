/** 原生服务刚刚读取的实际操作目标；不接受模型自行声明控件性质。 */
export interface ComputerActionTarget {
  /** 仅用于当前动作的原生校验凭据。 */
  token: string;
  /** 实际运行应用的名称。 */
  appName: string;
  /** 已观察窗口的标题。 */
  windowTitle: string;
  /** 已观察窗口的系统编号。 */
  windowId: number;
  /** 控件的系统角色。 */
  role: string;
  /** 控件的系统子角色。 */
  subrole: string;
  /** 控件的可见标题。 */
  title: string;
  /** 控件的辅助说明。 */
  description: string;
  /** 控件标识，仅参与敏感字段识别。 */
  identifier: string;
  /** 系统确认该控件支持文字修改。 */
  editable: boolean;
  /** 系统标记的安全输入框。 */
  secure: boolean;
}

/** 中文动作不使用英文词边界，避免“发送”“删除文件”等控件漏检。 */
const sensitiveActionPattern = /\b(buy|purchase|pay|checkout|order|submit|send|publish|delete|remove|erase|confirm|authorize|transfer|sign|login|log in)\b|注册|登录|提交|发送|发布|购买|支付|下单|删除|移除|确认|授权|转账|签署/iu;
/** 保留安全输入保护；中文字段名称同样按完整文本识别。 */
const secureFieldPattern = /\b(password|passcode|otp|one.?time|verification|cvv|cvc|card|iban|routing|account|ssn|secret|token)\b|身份证|密码|验证码|卡号|账户|密钥/iu;

/** 普通文本编辑不因控件名字包含“发送”等文字而被当作最终提交。 */
export function computerActionApprovalReason(tool: string, args: Record<string, unknown>, target: ComputerActionTarget, english: boolean): string | null {
  /** 当前控件的真实描述，仅用于风险识别。 */
  const descriptor = `${target.role} ${target.subrole} ${target.title} ${target.description} ${target.identifier}`;
  /** 文字写入共用安全字段和可编辑性检查。 */
  const textInput = ['set_value', 'type_text', 'paste'].includes(tool);
  if (textInput && (target.secure || secureFieldPattern.test(descriptor))) {
    throw Object.assign(new Error('Zeus 不读取或填写密码、验证码及其他安全文本字段。'), { code: 'ZEUS_COMPUTER_SECURE_FIELD_BLOCKED' });
  }
  if (textInput && target.editable) return null;
  if (tool === 'press_key') {
    /** 与原生按键解析保持相同的空白及大小写处理。 */
    const parts = String(args.key ?? '')
      .toLowerCase()
      .split('+')
      .map((part) => part.trim())
      .filter(Boolean);
    /** 最后一个片段是实际按键。 */
    const key = parts.at(-1);
    /** 组合键不能直接继承普通删字的批准。 */
    const modifiers = parts.slice(0, -1);
    // 导航键不激活当前控件；即使焦点在“发送”按钮上也不应重复确认。
    if (modifiers.every((part) => part === 'shift') && /^(tab|escape|left|right|up|down|arrowleft|arrowright|arrowup|arrowdown|home|end|pageup|pagedown)$/u.test(key ?? '')) return null;
    if (key === 'delete' || key === 'backspace') {
      if (target.editable && modifiers.length === 0) return null;
      return english ? 'This key is not a plain text deletion. It may delete an object or trigger an application shortcut.' : '这次按键不属于普通文本删字，可能删除对象或触发应用快捷操作。';
    }
    if (key === 'enter' || key === 'return') {
      if (modifiers.length === 0 && ['AXLink', 'AXDisclosureTriangle'].includes(target.role) && !sensitiveActionPattern.test(descriptor)) return null;
      // ponytail: 通用辅助功能无法证明回车只会换行；换行走已有 type_text，实际按键保留提交确认。
      if (target.editable)
        return english ? 'Enter in this field may submit or send its contents. For a line break, the agent should insert newline text instead.' : '在这个输入框按回车可能提交或发送内容。如果只是换行，AI 应直接插入换行文字。';
      return english ? 'This key may activate the focused control or the window’s default action.' : '这个按键可能触发当前控件或窗口的默认操作。';
    }
    // 仅确认普通按键与常见编辑快捷键；其他组合键可能触发应用级发送等操作。
    if (target.editable) {
      if (modifiers.every((part) => part === 'shift')) return null;
      /** 统一 Command 别名，只有常见编辑操作与撤销重做直接执行。 */
      const editingModifiers = modifiers
        .map((part) => (/^(meta|super|cmd|command)$/u.test(part) ? 'command' : part))
        .sort()
        .join('+');
      if ((editingModifiers === 'command' && /^[acvxz]$/u.test(key ?? '')) || (editingModifiers === 'command+shift' && key === 'z')) return null;
      return english ? 'This shortcut is not recognized as ordinary text editing. It may trigger an application action.' : '无法确认这个组合键仅用于普通文本编辑，它可能触发应用快捷操作。';
    }
  }
  if (tool === 'click' && target.editable) return null;
  if (tool === 'perform_secondary_action' && args.action === 'AXShowMenu') return null;
  if (tool === 'perform_secondary_action' && ['AXDelete', 'AXConfirm'].includes(String(args.action))) return english ? 'This accessibility action deletes or confirms the selected object.' : '这个控件操作会删除或确认选中的对象。';
  if (sensitiveActionPattern.test(descriptor)) return english ? 'This control may send information, submit changes, or perform a consequential action.' : '这个控件可能发送信息、提交修改或执行有实际影响的操作。';
  if (textInput) return english ? 'The target does not expose an editable text field. Input may trigger an application action.' : '目标没有公开可编辑文本框，输入可能触发应用操作。';
  return null;
}

/** 将真实应用、窗口、控件及具体动作呈现给用户，避免暴露内部工具名作为操作说明。 */
export function computerActionApprovalDetail(tool: string, args: Record<string, unknown>, target: ComputerActionTarget, english: boolean): string {
  /** 没有可见名称时明确说明控件未命名，不冒充应用名称。 */
  const label = target.title || target.description || (target.editable ? (english ? 'Text field' : '文本输入框') : english ? 'Unnamed control' : '未命名控件');
  /** 用户可见的操作名称，按应用语言输出。 */
  const actionNames: Record<string, string> = english
    ? { click: 'Click', drag: 'Drag', paste: 'Paste text', perform_secondary_action: 'Perform control action', press_key: 'Press key', set_value: 'Replace text', type_text: 'Insert text' }
    : { click: '点击', drag: '拖拽', paste: '粘贴文字', perform_secondary_action: '执行控件操作', press_key: '按键', set_value: '替换文字', type_text: '插入文字' };
  /** 真实按键及系统动作不得被通用提示替代。 */
  const action = tool === 'press_key' ? `${actionNames[tool]} ${String(args.key ?? '')}` : tool === 'perform_secondary_action' ? `${actionNames[tool]} ${String(args.action ?? '')}` : (actionNames[tool] ?? tool);
  /** 非普通输入仍需确认时展示将写入的文字，安全输入已在判定入口拒绝。 */
  const text = typeof args.text === 'string' ? args.text : typeof args.value === 'string' ? args.value : null;
  return [
    `${english ? 'App' : '应用'}：${approvalDisplayText(target.appName)}`,
    `${english ? 'Window' : '窗口'}：${approvalDisplayText(target.windowTitle || `#${target.windowId}`)}`,
    `${english ? 'Control' : '控件'}：${approvalDisplayText(label)}`,
    `${english ? 'Action' : '操作'}：${approvalDisplayText(action)}`,
    ...(text !== null ? [`${english ? 'Text preview' : '文字预览'}：${approvalDisplayText(JSON.stringify(text))}`] : []),
  ].join('\n');
}

/** 控件文字只能占据自己的说明行；超长名称明确标记省略，避免挤出动作信息。 */
function approvalDisplayText(value: string): string {
  /** 移除控制字符及双向覆盖，保留普通 Unicode 名称。 */
  const text = value.replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, ' ');
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
