import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';

/** 从实际共用 API 提取宿主通道清单，避免 Chromium 另维护一份失配的接口副本。 */
export async function readDesktopBridgeContract(desktopRoot) {
  /** 界面 API 与启动报告器是通道定义的两个现有来源。 */
  const sources = await Promise.all(
    ['desktopApi.cts', 'rendererBootstrapState.cjs'].map(async (name) => {
      /** 以 TypeScript 语法树读取源码，不执行预加载代码。 */
      const source = await readFile(join(desktopRoot, 'src', 'preload', name), 'utf8');
      return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    }),
  );
  /** 各类通道分开保存，宿主不能将单向通知当作请求执行。 */
  const channels = { invoke: new Set(), send: new Set(), subscribe: new Set() };
  /** 实际对界面公开的方法名，用于原生接线核对。 */
  const methods = [];

  /** 固定通道必须使用源码中的字面量；动态参数仅由共用包装函数转发。 */
  function addChannel(kind, argument) {
    if (argument && ts.isStringLiteral(argument) && argument.text.startsWith('zeus:')) channels[kind].add(argument.text);
  }

  /** 遍历实际调用位置，同时保留资源授权包装器的两条动态分支。 */
  function visit(node) {
    if (ts.isCallExpression(node)) {
      /** 当前调用的方法文本只用于匹配已知包装器。 */
      const callee = node.expression.getText();
      if (callee === 'transport.invoke' || ['invokeMainCommand', 'invokeProjectSourceCommand', 'invokeBrowserConversationCommand'].includes(callee)) addChannel('invoke', node.arguments[0]);
      else if (callee === 'transport.send') addChannel('send', node.arguments[0]);
      else if (callee === 'transport.subscribe') addChannel('subscribe', node.arguments[0]);
      else if (callee === 'authorizePendingResourceFiles') {
        addChannel('invoke', node.arguments[2]);
        addChannel('invoke', node.arguments[3]);
      } else if (callee === 'options.send') addChannel('send', node.arguments[0]);
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'createDesktopApi') {
      /** 只取工厂顶层返回值，排除内部辅助函数中的临时对象。 */
      const result = node.body?.statements.find((statement) => ts.isReturnStatement(statement));
      if (!result?.expression || !ts.isObjectLiteralExpression(result.expression)) throw new Error('桌面 API 工厂必须返回显式方法对象。');
      for (const property of result.expression.properties) {
        if (!property.name || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) throw new Error('桌面 API 不允许动态方法名。');
        if (property.name.text !== 'appName') methods.push(property.name.text);
      }
    }
    // 启动报告器的失败通知通过局部变量发送，类型声明明确列出允许的两个通道。
    if (ts.isStringLiteral(node) && ['zeus:renderer-bootstrap-failed', 'zeus:renderer-runtime-failed'].includes(node.text)) channels.send.add(node.text);
    ts.forEachChild(node, visit);
  }

  for (const source of sources) visit(source);
  if (methods.length === 0 || channels.invoke.size === 0 || channels.subscribe.size === 0) throw new Error('桌面通道清单为空，不能生成原生接线资源。');
  return {
    artifactKind: 'desktop-transport-contract',
    methods: methods.sort(),
    channels: Object.fromEntries(Object.entries(channels).map(([kind, names]) => [kind, [...names].sort()])),
  };
}
