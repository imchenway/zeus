import assert from 'node:assert/strict';
import { compareModelNames, presentModelOptions } from '../apps/desktop/src/renderer/modelOptionPresentation.ts';

/** 截图目录的目标顺序，覆盖空格与连字符混用、数字降序和同型号字母升序。 */
const expected = ['GPT-6.1-Sol', 'GPT-6.1 Terra', 'GPT-6-Astra', 'GPT-6-Luna', 'GPT-6-Sol', 'GPT-5.6-Luna', 'GPT-5.6-Sol', 'GPT-5.6-Terra'];
/** 逆序目录用于确认展示排序不依赖上游顺序。 */
const models = [...expected].reverse().map((model) => ({ id: model, model, sourceName: 'Codex' }));
/** 较旧模型保持选中，但不会因此占据首位。 */
const selectedId = 'GPT-5.6-Luna';
assert.deepEqual(
  presentModelOptions(models, selectedId, 'zh-CN').models.map((model) => model.id),
  expected,
);
assert.equal(presentModelOptions(models, selectedId, 'en-US').selectedId, selectedId);
assert.equal(presentModelOptions(models, '', 'zh-CN').selectedId, models[0]!.id);
assert.deepEqual(
  models.map((model) => model.id),
  [...expected].reverse(),
);
assert.deepEqual(['GPT-6.2', 'GPT-6', 'GPT-6.10', 'Claude 5'].sort(compareModelNames), ['Claude 5', 'GPT-6.10', 'GPT-6.2', 'GPT-6']);
console.log('模型名称排序检查通过');
