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

/** 安全输入仍检查真实字段信息；不再根据控件文案决定是否申请动作授权。 */
const secureFieldPattern = /\b(password|passcode|otp|one.?time|verification|cvv|cvc|card|iban|routing|account|ssn|secret|token)\b|身份证|密码|验证码|卡号|账户|密钥/iu;

/** 所有动作沿用设置授权，仅拒绝安全字段输入，不创建额外确认。 */
export function assertComputerActionInputAllowed(tool: string, args: Record<string, unknown>, target: ComputerActionTarget): void {
  /** 可见名称优先，安全字段识别仍包含原生标识。 */
  const descriptor = [target.title, target.description].filter((value) => value.trim()).join(' ') || target.identifier;
  /** 与已有安全输入保护保持一致，普通按钮名称不等同于输入字段。 */
  const secureInput = target.secure || secureFieldPattern.test(`${target.role} ${target.subrole} ${descriptor} ${target.identifier}`);
  if (['set_value', 'type_text', 'paste'].includes(tool) && secureInput) {
    throw Object.assign(new Error('Zeus 不读取或填写密码、验证码及其他安全文本字段。'), { code: 'ZEUS_COMPUTER_SECURE_FIELD_BLOCKED' });
  }
  if (tool !== 'press_key' || !(target.secure || (target.editable && secureInput))) return;
  /** 安全字段仍允许原有的退出和定位操作；不为普通控件维护快捷键授权名单。 */
  const parts = String(args.key ?? '')
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  /** 最后一个片段为实际按键。 */
  const key = parts.at(-1);
  /** 修饰键别名与原生解析保持一致。 */
  const modifiers = [...new Set(parts.slice(0, -1).map((part) => (/^(meta|super|cmd|command)$/u.test(part) ? 'command' : /^(alt|option)$/u.test(part) ? 'option' : /^(ctrl|control)$/u.test(part) ? 'control' : part)))].sort();
  /** 只用于识别安全字段已有的定位操作例外。 */
  const chord = modifiers.join('+');
  if (modifiers.every((part) => part === 'shift') && /^(tab|escape|left|right|up|down|arrowleft|arrowright|arrowup|arrowdown|home|end|pageup|pagedown)$/u.test(key ?? '')) return;
  if (chord === 'command' && /^[afg]$/u.test(key ?? '')) return;
  if (chord === 'command+shift' && key === 'g') return;
  if (target.editable && modifiers.every((part) => ['command', 'option', 'shift'].includes(part)) && /^(left|right|up|down|arrowleft|arrowright|arrowup|arrowdown|home|end|pageup|pagedown)$/u.test(key ?? '')) return;
  throw Object.assign(new Error('Zeus 不读取或填写密码、验证码及其他安全文本字段。'), { code: 'ZEUS_COMPUTER_SECURE_FIELD_BLOCKED' });
}
