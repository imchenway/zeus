# Zeus Browser 权限理由

- `tabs`：只用于列出顶层标签的最小元数据、精确声明标签、导航和关闭标签。
- `nativeMessaging`：只连接 Zeus 自有 Host；不连接第三方本机程序。
- `scripting`：仅在用户已授予的站点注入受控页面桥，不执行远程下载代码。
- `storage`：保存扩展自身的非敏感连接与权限提示状态。
- 可选站点权限：由用户从扩展弹窗按当前 origin 授予；拒绝时返回准确缺权错误。
- 可选 `bookmarks`、`history`、`downloads`、`clipboardRead`、`clipboardWrite`、`debugger`：只在对应高级功能被用户主动启用后使用。

凭据值不会发送给 Provider、Native Messaging 调试日志或浏览器历史。敏感提交与开发者能力仍由 Zeus 原生界面逐次确认。
