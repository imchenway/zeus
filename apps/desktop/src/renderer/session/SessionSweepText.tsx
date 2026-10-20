/** 会话状态共用文字扫光；视觉副本不参与朗读、选中或布局。 */
export function SessionSweepText(props: { text: string; className: string; active: boolean }) {
  return (
    <span className={`session-sweep-text ${props.className}`}>
      {props.text}
      {props.active ? <span className="session-sweep-text-light" data-text={props.text} aria-hidden="true" /> : null}
    </span>
  );
}
