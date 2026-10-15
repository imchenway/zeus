#!/usr/bin/env node
/* global console, process, setTimeout, clearTimeout */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

/** 读取真实接力函数，检查期间不加载 Electron，也不启动安装器。 */
const source = await readFile(new URL('../apps/desktop/src/main/windowsReleaseInstaller.ts', import.meta.url), 'utf8');
/** 使用语法树提取内部函数，不为检查扩大生产模块的公开接口。 */
const syntax = ts.createSourceFile('windowsReleaseInstaller.ts', source, ts.ScriptTarget.Latest, true);
/** 检查直接执行当前源码，函数删除或改名会明确失败。 */
const declaration = syntax.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'launchWindowsInstaller');
assert.ok(declaration, '缺少 Windows 安装接力函数');
/** 仅移除 TypeScript 类型，保留实际取消和等待逻辑。 */
const javascript = ts.transpileModule(declaration.getText(syntax), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

/** 已授权的时序检查只模拟子进程事件和落盘边界，不代表 Windows NSIS 验收。 */
async function checkCancellation(failPersistence) {
  /** 每次检查使用独立记录，取消写入失败时不得伪造成功回执。 */
  const records = new Map();
  /** 模拟唯一被当前调用持有的子进程，禁止按名称批量终止。 */
  const child = new EventEmitter();
  /** 统计启动次数，取消后不能重新播放安装动作。 */
  let starts = 0;
  /** 统计终止请求；真实 exit 由检查明确控制。 */
  let kills = 0;
  Object.assign(child, {
    pid: 7,
    exitCode: null,
    signalCode: null,
    unref() {},
    kill() {
      kills += 1;
      return true;
    },
  });
  /** 固定事务身份只用于内存回执，不读写用户文件。 */
  const transaction = { transactionId: 'probe', resultPath: 'probe-result.json' };
  /** 实际函数使用受控外部依赖，避免执行安装或修改用户数据。 */
  const launch = runInNewContext(`${javascript}\nlaunchWindowsInstaller`, {
    process,
    resolve,
    setTimeout,
    clearTimeout,
    installerReadyTimeoutMs: 1000,
    /** 返回已准备的安装器；ready 不表示允许文件替换。 */
    spawn: () => {
      starts += 1;
      records.set(transaction.resultPath, JSON.stringify({ transactionId: transaction.transactionId, status: 'ready' }));
      return child;
    },
    /** 模拟已发布记录，读取仍经过实际 JSON 和身份校验。 */
    readFile: async (path) => records.get(path),
    /** 保留异步落盘边界，失败不可成为 cancelled。 */
    persistWindowsInstallRecord: async (path, content) => {
      if (failPersistence && path.endsWith('.cancel')) throw new Error('取消记录写入失败');
      records.set(path, content);
    },
  });
  /** 接收 Main 使用的实际激活与取消回调。 */
  let activateAgain;
  /** 检查取消只能发起一次并必须等到真实 exit。 */
  const operation = launch(
    {
      currentExecutablePath: 'Zeus.exe',
      onInstallReady: async (activate, cancel) => {
        activateAgain = activate;
        await activate();
        /** 同一取消 Promise 同时交给 Main 和失败收尾。 */
        const cancellation = cancel();
        assert.equal(cancel(), cancellation);
        if (failPersistence) {
          await assert.rejects(cancellation, /取消记录写入失败/u);
          return false;
        }
        /** kill 返回不代表退出；取消完成前不可返回 false 允许 Main 清状态。 */
        let completed = false;
        void cancellation.then(() => {
          completed = true;
        });
        await new Promise((done) => setTimeout(done, 0));
        assert.equal(completed, false);
        assert.equal(kills, 1);
        assert.equal(records.get(`${transaction.resultPath}.cancel`), transaction.transactionId);
        child.exitCode = 2;
        child.emit('exit', 2, null);
        await cancellation;
        return false;
      },
    },
    'installer.exe',
    transaction,
  );
  if (failPersistence) {
    await assert.rejects(operation, /取消记录写入失败/u);
    assert.equal(JSON.parse(records.get(transaction.resultPath)).status, 'ready');
    assert.equal(kills, 0);
  } else {
    assert.equal(await operation, false);
    assert.equal(JSON.parse(records.get(transaction.resultPath)).status, 'cancelled');
  }
  await assert.rejects(activateAgain(), /已撤销/u);
  assert.equal(starts, 1);
}

await checkCancellation(false);
await checkCancellation(true);
console.log('Windows 更新接力检查通过：持久取消、等待真实 exit、失败保留未知、禁止重放；未运行 NSIS。');
