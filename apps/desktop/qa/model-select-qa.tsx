import { useState, type CSSProperties, type MouseEvent } from 'react';
import { presentModelOptions } from '../src/renderer/modelOptionPresentation.js';
import { ComposerDropdown } from '../src/renderer/session/ComposerDropdown.js';
import { ZeusSelect } from '../src/renderer/ZeusSelect.js';
import { Button } from '../src/renderer/ui/Button.js';

/** 固定目录包含同名模型、长名称、不可用项；仅供本机预览，不连接模型服务。 */
const models = [
  ...['GPT-6-Astra', 'GPT-5.3-Codex-Spark', 'GPT-5.5', 'GPT-5.6-Luna', 'GPT-5.6-Sol', 'GPT-5.6-Terra'].map((name) => ({ id: `codex:${name}`, model: name, sourceName: 'Codex' })),
  ...['1XM', 'APIKey'].flatMap((sourceName) => ['Claude Fable 5', 'Claude Opus 5'].map((name) => ({ id: `${sourceName}:${name}`, model: name, sourceName }))),
  { id: 'long:model', model: 'Model with a deliberately long name for narrow window inspection', sourceName: 'Long provider name' },
  { id: 'unavailable:model', model: '不可用模型', sourceName: 'Unavailable', available: false },
];

/** 复用真实选择器和全部生产样式，独立偏好不会写入正式应用数据。 */
export function ModelSelectQa() {
  /** 预览主题不修改产品设置。 */
  const [dark, setDark] = useState(false);
  /** 中英文共用同一份置顶身份。 */
  const [english, setEnglish] = useState(false);
  /** 单供应商和子目录用于检查隐藏模型不会被置顶偏好重新引入。 */
  const [subset, setSubset] = useState(false);
  /** 两个独立入口分别记录选择，用于观察置顶不会触发切换。 */
  const [selected, setSelected] = useState('codex:GPT-6-Astra');
  /** 第二入口模拟其他业务页面的默认模型选择。 */
  const [secondary, setSecondary] = useState('APIKey:Claude Fable 5');
  /** 真实点击后的最小运行检查结果，只在验收页显示。 */
  const [check, setCheck] = useState('点击图钉后自动检查：持久化、无重复、当前选择不变。');
  /** 当前预览目录始终来自固定样本。 */
  const catalog = subset ? models.filter((model) => model.sourceName === 'APIKey') : models;
  /** 紧凑会话入口使用生产展示规则。 */
  const presentation = presentModelOptions(catalog, selected, english ? 'en-US' : 'zh-CN');
  /** 常规表单入口读取相同存储键，重开菜单即可同步。 */
  const other = presentModelOptions(catalog, secondary, english ? 'en-US' : 'zh-CN');
  /** 捕获操作前状态，在真实组件处理完成后核对置顶和取消置顶。 */
  const checkPin = (event: MouseEvent<HTMLElement>) => {
    /** 仅检查图钉操作，不接管产品事件。 */
    const pin = event.target instanceof Element ? event.target.closest('.zeus-select-pin') : null;
    if (!pin) return;
    /** 图钉与选项并列，直接读取该行的完整模型身份。 */
    const value = pin.parentElement?.querySelector<HTMLElement>('[data-value]')?.dataset.value;
    /** 操作前的置顶状态用于核对保存后确实翻转。 */
    const wasPinned = pin.getAttribute('aria-pressed') === 'true';
    window.setTimeout(() => {
      /** 核对持久化结果，而非仅检查按钮图案。 */
      const saved: string[] = JSON.parse(localStorage.getItem(presentation.pinning.storageKey) ?? '[]');
      /** 当前菜单每个模型只能出现一次。 */
      const shown = Array.from(document.querySelectorAll<HTMLElement>('.zeus-select-option[data-value]'), (option) => option.dataset.value);
      /** 置顶操作不得触发任一选择入口的模型切换。 */
      const passed =
        Boolean(value) &&
        saved.includes(value!) !== wasPinned &&
        new Set(shown).size === shown.length &&
        document.querySelector('[data-selected-model]')?.getAttribute('data-selected-model') === selected &&
        document.querySelector('[data-secondary-model]')?.getAttribute('data-secondary-model') === secondary;
      setCheck(passed ? '运行检查通过：已保存、无重复、当前选择不变。' : '运行检查失败，请查看当前菜单与保存结果。');
      console.assert(passed, '模型置顶运行检查失败');
    }, 0);
  };
  return (
    <main
      className={`macos-ai-app zeus-shell qa-error-layout theme-${dark ? 'dark' : 'light'}`}
      style={{ '--session-canvas': 'var(--zeus-product-panel)', '--session-text': 'var(--zeus-product-text)', padding: 24 } as CSSProperties}
      onClickCapture={checkPin}
    >
      <header className="qa-error-layout-heading">
        <div>
          <h1>模型选择框</h1>
          <p>真实组件预览 · 图钉只调整排序 · 刷新保留置顶</p>
        </div>
        <nav>
          <Button size="compact" onClick={() => setDark(!dark)}>
            {dark ? '浅色' : '深色'}
          </Button>
          <Button size="compact" onClick={() => setEnglish(!english)}>
            {english ? '中文' : 'English'}
          </Button>
          <Button size="compact" onClick={() => setSubset(!subset)}>
            {subset ? '全部供应商' : '仅 APIKey'}
          </Button>
        </nav>
      </header>
      <section className="qa-error-layout-heading" style={{ justifyContent: 'flex-start', alignItems: 'flex-start', minHeight: 450 }}>
        <div>
          <p>会话输入</p>
          <ComposerDropdown
            label="会话模型"
            value={presentation.selectedId}
            options={presentation.options}
            pinning={presentation.pinning}
            displayLabel={presentation.triggerLabel}
            searchable
            searchPlaceholder={english ? 'Search providers or models' : '搜索供应商或模型'}
            emptyLabel={english ? 'No matching models' : '没有匹配模型'}
            onChange={setSelected}
          />
          <p data-selected-model={selected}>当前选择：{selected}</p>
        </div>
        <div>
          <p>其他模型入口</p>
          <ZeusSelect
            size="regular"
            ariaLabel="其他模型入口"
            value={other.selectedId}
            options={other.options}
            pinning={other.pinning}
            triggerLabel={other.triggerLabel}
            searchable
            searchPlaceholder={english ? 'Search providers or models' : '搜索供应商或模型'}
            emptyLabel={english ? 'No matching models' : '没有匹配模型'}
            onChange={setSecondary}
          />
          <p data-secondary-model={secondary}>当前选择：{secondary}</p>
        </div>
      </section>
      <p role="status">{check}</p>
    </main>
  );
}
