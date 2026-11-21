/** 填充只需要选中的一条凭据。 */
export interface BrowserPasswordSelection {
  id: string;
  username: string;
  password: string;
}

/** 登录框可见部分相对于当前 frame 视口的 CSS 像素矩形。 */
export interface BrowserPasswordAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 当前文档可填字段和弹层定位所需的登录框位置。 */
export interface BrowserPasswordFrameProbe {
  documentId: string;
  username: boolean;
  password: boolean;
  anchor: BrowserPasswordAnchor | undefined;
}

/** anchor 只在父 frame 换算几何，fill 只接受 probe 确认的文档。 */
export type BrowserPasswordFrameRequest =
  { action: 'probe'; origin: string } | { action: 'anchor'; childIndex: number; childCount: number; anchor: BrowserPasswordAnchor } | { action: 'fill'; origin: string; documentId: string; selection: BrowserPasswordSelection };
