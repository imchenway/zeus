/**
 * 模型 ID → 厂商官方文档里的版本名。
 *
 * OpenAI 兼容的 `/models` 接口只承诺 `id / object / created / owned_by`，不返回版本名，
 * 所以「DeepSeek-V4-Pro-0813」这类快照只能人工登记。这张表是唯一的人工维护点：
 *
 * - 只登记能核对到官方文档的条目，不猜、不推断；
 * - 表里没有的模型退回显示 pi-ai 目录名或模型 ID，界面不会因此报错；
 * - 真机探测到的服务端实际返回标识永远优先于这张表，避免表过期时盖住真实结果；
 * - 厂商发布新版本时在这里加一行即可，不需要改任何代码逻辑。
 *
 * ponytail: 手工表的固有上限是“会过期”——厂商换快照后这里不会自动更新，
 * 所以它只作为展示兜底，判断真实版本一律以探测观测为准。
 */
const modelVersionNames: Readonly<Record<string, string>> = {
  // DeepSeek 官方文档「模型细节」表（api-docs.deepseek.com）登记的版本名。
  'deepseek-flash': 'DeepSeek-V4.1-Flash',
  'deepseek-v4-pro': 'DeepSeek-V4-Pro-0813',
};

/** 查询官方版本名；未登记时返回 null，由调用方退回目录名或模型 ID。 */
export function readOfficialModelVersion(modelId: string): string | null {
  return modelVersionNames[modelId.trim().toLowerCase()] ?? null;
}
