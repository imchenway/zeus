/** 附件加载使用柔和骨架；已有缩略图时保留原图并叠加光扫。 */
export function ResourceLoading(props: { label: string; overlay?: boolean }) {
  return (
    <span className="resource-loading" data-overlay={props.overlay || undefined} role="status">
      <span className="resource-loading-progress" aria-hidden="true" />
      <span className="resource-loading-label">{props.label}</span>
    </span>
  );
}
