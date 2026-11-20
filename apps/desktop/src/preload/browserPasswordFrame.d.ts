/** 填充只需要选中的一条凭据。 */
export interface BrowserPasswordSelection {
  id: string;
  username: string;
  password: string;
}

/** 当前可填字段及顶层登录框相对于网页视口的 CSS 像素位置。 */
export interface BrowserPasswordFrameProbe {
  documentId: string;
  username: boolean;
  password: boolean;
  anchor: { x: number; y: number; height: number } | undefined;
}

/** 文档标识由 probe 返回，fill 只接受同一实例的请求。 */
export type BrowserPasswordFrameRequest = { action: 'probe'; origin: string } | { action: 'fill'; origin: string; documentId: string; selection: BrowserPasswordSelection };
