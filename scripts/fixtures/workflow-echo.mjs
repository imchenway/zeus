import { createInterface } from 'node:readline';

/** 验收专用真实 stdio MCP 服务，只回显输入，不访问外部系统。 */
const input = createInterface({ input: process.stdin });
/** 同一进程内的真实调用次数随输出返回。 */
let calls = 0;
input.on('line', (line) => {
  /** 每行处理一条标准 JSON-RPC 消息，通知不需要回应。 */
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  /** 目录和执行共用相同工具定义。 */
  const tool = { name: 'echo', description: '回显结构化输入', inputSchema: { type: 'object', properties: { value: {} }, required: ['value'] }, annotations: { readOnlyHint: true, destructiveHint: false } };
  /** 只支持本专项使用的握手、目录、调用和存活检查。 */
  const result =
    message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'workflow-echo', version: '1.0.0' } }
      : message.method === 'tools/list'
        ? { tools: [tool] }
        : message.method === 'tools/call'
          ? { content: [{ type: 'text', text: 'echo complete' }], structuredContent: { received: message.params.arguments, calls: ++calls }, isError: false }
          : {};
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
});
