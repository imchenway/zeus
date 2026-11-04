/** WebUI 只接收 JSON；所有容器均带类型标记，避免业务对象被误识别为二进制。 */
export type ChromiumWireValue = null | boolean | number | string | ['undefined'] | ['buffer', string] | ['array', ChromiumWireValue[]] | ['object', Array<[string, ChromiumWireValue]>];

/** 单条桌面消息允许的累计数据大小，单位为字节；编码和解码采用相同限制。 */
const maximumMessageBytes = 64 * 1024 * 1024;
/** 限制嵌套深度，避免损坏载荷耗尽界面调用栈。 */
const maximumDepth = 64;
/** 限制小对象数量，防止低字节数的载荷造成大量分配。 */
const maximumNodes = 200_000;
/** 字符串编码分块大小，避免将整个附件展开为函数参数。 */
const binaryChunkSize = 16 * 1024;

/** 每次转换单独维护限额，不在不同请求之间共享可变状态。 */
class MessageBudget {
  /** 当前消息已处理的累计字节数。 */
  private bytes = 0;
  /** 当前消息已处理的节点数。 */
  private nodes = 0;

  /** 在分配或递归前检查当前节点；文本按 UTF-16 字节数保守计费。 */
  take(depth: number, bytes = 0): void {
    this.nodes += 1;
    this.bytes += bytes;
    if (depth > maximumDepth || this.nodes > maximumNodes || this.bytes > maximumMessageBytes) {
      throw new Error('桌面消息超过传输限额，请减少单次附件或数据大小。');
    }
  }
}

/** 将现有桌面 DTO 转换为 WebUI 可传递的数据，保留 undefined 和 ArrayBuffer。 */
export function encodeChromiumWire(value: unknown): ChromiumWireValue {
  /** 当前请求的限额。 */
  const budget = new MessageBudget();
  /** 只跟踪当前递归路径，允许不同字段引用同一个无环对象。 */
  const ancestors = new Set<object>();

  /** 递归转换一项数据；不接受隐含序列化行为或有损数值。 */
  function encode(item: unknown, depth: number): ChromiumWireValue {
    budget.take(depth, typeof item === 'string' ? item.length * 2 : 0);
    if (item === undefined) return ['undefined'];
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (item instanceof ArrayBuffer) {
      budget.take(depth, item.byteLength);
      /** 分块构建二进制文本，不把原始附件写入日志。 */
      const bytes = new Uint8Array(item);
      /** 有界文本块在编码前合并。 */
      const chunks: string[] = [];
      for (let offset = 0; offset < bytes.length; offset += binaryChunkSize) {
        chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + binaryChunkSize)));
      }
      return ['buffer', btoa(chunks.join(''))];
    }
    if (typeof item !== 'object' || item === null) throw new Error('桌面消息包含不支持的数据类型。');
    if (ancestors.has(item)) throw new Error('桌面消息不能包含循环引用。');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (item.length > maximumNodes) throw new Error('桌面消息包含过多数组元素。');
        return ['array', Array.from(item, (child) => encode(child, depth + 1))];
      }
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        throw new Error('桌面消息只支持普通数据对象和 ArrayBuffer。');
      }
      return [
        'object',
        Object.entries(item).map(([key, child]) => {
          budget.take(depth, key.length * 2);
          return [key, encode(child, depth + 1)];
        }),
      ];
    } finally {
      ancestors.delete(item);
    }
  }

  return encode(value, 0);
}

/** 验证并还原原生宿主的响应；协议损坏必须报错，不能静默丢失附件。 */
export function decodeChromiumWire(value: unknown): unknown {
  /** 当前响应的限额。 */
  const budget = new MessageBudget();

  /** 递归还原一项数据，拒绝未知类型、重复字段和非规范二进制编码。 */
  function decode(item: unknown, depth: number): unknown {
    budget.take(depth, typeof item === 'string' ? item.length * 2 : 0);
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!Array.isArray(item)) throw new Error('原生桌面消息格式无效。');
    if (item[0] === 'undefined' && item.length === 1) return undefined;
    if (item.length !== 2) throw new Error('原生桌面消息类型无效。');
    if (item[0] === 'buffer' && typeof item[1] === 'string') {
      /** 在解码前检查字节上限与 Base64 格式。 */
      const encoded = item[1];
      if (encoded.length % 4 !== 0) throw new Error('原生桌面附件编码无效。');
      /** 去除末尾填充后的实际二进制长度。 */
      const size = (encoded.length / 4) * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
      budget.take(depth, size);
      /** 浏览器原生解码器拒绝非法字符，重新编码用于核对非规范尾部。 */
      const binary = atob(encoded);
      if (binary.length !== size || btoa(binary) !== encoded) throw new Error('原生桌面附件编码无效。');
      return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
    }
    if (item[0] === 'array' && Array.isArray(item[1])) {
      if (item[1].length > maximumNodes) throw new Error('原生桌面消息包含过多数组元素。');
      return Array.from(item[1], (child) => decode(child, depth + 1));
    }
    if (item[0] === 'object' && Array.isArray(item[1])) {
      /** 用明确的数据属性写入，避免 __proto__ 等业务字段修改原型。 */
      const result: Record<string, unknown> = {};
      for (const entry of item[1]) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || Object.hasOwn(result, entry[0])) {
          throw new Error('原生桌面消息字段无效。');
        }
        budget.take(depth, entry[0].length * 2);
        Object.defineProperty(result, entry[0], { value: decode(entry[1], depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return result;
    }
    throw new Error('原生桌面消息包含未知类型。');
  }

  return decode(value, 0);
}
