import type { CommandDefinition } from '@zeus/shared';
import { ArrowUpIcon } from '@phosphor-icons/react/dist/csr/ArrowUp';
import { ArrowDownIcon } from '@phosphor-icons/react/dist/csr/ArrowDown';
import { ZeusSelect } from '../ZeusSelect.js';
import { Button } from '../ui/Button.js';

/** 命令多选与执行顺序共用已配置命令身份，不复制命令内容。 */
export function GitDeliveryCommandSelect(props: {
  /** 项目与全局合并后的可用命令目录。 */
  commands: readonly Pick<CommandDefinition, 'id' | 'title'>[];
  /** 数组顺序就是推送后的命令执行顺序。 */
  selectedIds: readonly string[];
  /** 更新本次组合的命令选择，不直接运行命令。 */
  onChange: (ids: string[]) => void;
  /** 加载、交付执行或未勾选推送时禁止修改。 */
  disabled: boolean;
  /** 跟随交付页面语言。 */
  zh: boolean;
}) {
  /** 已失效命令仍保留为已选项，允许用户主动取消。 */
  const selected = props.selectedIds.map((id) => ({ id, title: props.commands.find((command) => command.id === id)?.title ?? (props.zh ? '命令不可用' : 'Command unavailable') }));
  /** 空选择不伪造命令；多选在触发器中显示首项与总数。 */
  const label =
    selected.length === 0 ? (props.zh ? '选择命令' : 'Select commands') : selected.length === 1 ? selected[0]!.title : props.zh ? `${selected[0]!.title} 等 ${selected.length} 项` : `${selected[0]!.title} +${selected.length - 1}`;

  /** 新选择追加到末尾，取消选择不打乱其余命令的顺序。 */
  function toggleCommand(id: string): void {
    if (props.selectedIds.includes(id)) props.onChange(props.selectedIds.filter((value) => value !== id));
    else if (props.selectedIds.length < 50) props.onChange([...props.selectedIds, id]);
  }

  /** 在下拉面板中调整执行顺序，保留已选命令集合。 */
  function moveCommand(index: number, offset: number): void {
    /** 复制选择，避免原地修改交付设置。 */
    const ids = [...props.selectedIds];
    if (index + offset < 0 || index + offset >= ids.length) return;
    [ids[index], ids[index + offset]] = [ids[index + offset]!, ids[index]!];
    props.onChange(ids);
  }

  return (
    <ZeusSelect
      size="compact"
      value=""
      selectedValues={props.selectedIds}
      triggerLabel={label}
      ariaLabel={props.zh ? '推送后命令' : 'Commands after push'}
      options={[
        ...props.commands.map((command) => ({ value: command.id, label: command.title, disabled: props.selectedIds.length >= 50 && !props.selectedIds.includes(command.id) })),
        ...selected.filter((command) => !props.commands.some((available) => available.id === command.id)).map((command) => ({ value: command.id, label: command.title })),
      ]}
      disabled={props.disabled}
      searchPlaceholder={props.zh ? '搜索命令' : 'Search commands'}
      emptyLabel={props.zh ? '没有可选命令' : 'No commands available'}
      onChange={toggleCommand}
      popoverMinWidth={280}
      footer={
        selected.length > 1 ? (
          <span className="git-delivery-command-order">
            <span className="git-delivery-command-order-title">{props.zh ? '执行顺序' : 'Execution order'}</span>
            <span className="git-delivery-command-order-list" role="list" aria-label={props.zh ? '命令执行顺序' : 'Command execution order'}>
              {selected.map((command, index) => (
                <span className="git-delivery-command-order-item" role="listitem" key={command.id}>
                  <span className="git-delivery-command-order-number" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span className="git-delivery-command-order-name">{command.title}</span>
                  <Button size="compact" aria-label={props.zh ? `上移 ${command.title}` : `Move ${command.title} up`} disabled={props.disabled || index === 0} onClick={() => moveCommand(index, -1)}>
                    <ArrowUpIcon aria-hidden="true" />
                  </Button>
                  <Button size="compact" aria-label={props.zh ? `下移 ${command.title}` : `Move ${command.title} down`} disabled={props.disabled || index === selected.length - 1} onClick={() => moveCommand(index, 1)}>
                    <ArrowDownIcon aria-hidden="true" />
                  </Button>
                </span>
              ))}
            </span>
          </span>
        ) : undefined
      }
    />
  );
}
