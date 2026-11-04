// Zeus 可信 WebUI 的注册与原生消息入口。
#ifndef CHROME_BROWSER_UI_WEBUI_ZEUS_ZEUS_UI_H_
#define CHROME_BROWSER_UI_WEBUI_ZEUS_ZEUS_UI_H_

#include "base/memory/raw_ptr.h"
#include "content/public/browser/web_ui_controller.h"
#include "content/public/browser/webui_config.h"

namespace zeus {

class ZeusUI;
class ZeusDesktopHandler;

// 将 chrome://zeus 注册到正常浏览器资料，不在无痕资料中创建桌面入口。
class ZeusUIConfig : public content::DefaultWebUIConfig<ZeusUI> {
 public:
  // 地址固定为 Zeus 自有的可信宿主，不从命令行或网页参数读取。
  ZeusUIConfig();
  // 无痕浏览器资料不能成为持久桌面服务的身份来源。
  bool IsWebUIEnabled(content::BrowserContext* browser_context) override;
};

// 载入现有 Zeus 资源，并将受控消息转交当前窗口绑定的原生会话。
class ZeusUI : public content::WebUIController {
 public:
  // 资源注册不自动赋予桌面权限，权限来自独立的原生会话绑定。
  explicit ZeusUI(content::WebUI* web_ui);
  // 控制器销毁后不保留页面处理器。
  ~ZeusUI() override;
  // 控制器只能归属于创建时的 WebUI。
  ZeusUI(const ZeusUI&) = delete;
  // 控制器不能转移到另一个页面。
  ZeusUI& operator=(const ZeusUI&) = delete;
  // 在解析消息之前拒绝子框架、错误来源及未登记的原生消息名。
  bool OverrideHandleWebUIMessage(const GURL& source_url,
                                 const std::string& message,
                                 const base::ListValue& args) override;
  // 文档切换撤销旧回调和订阅，防止响应送入新页面。
  void WebUIPrimaryPageChanged(content::Page& page) override;

 private:
  // WebUI 拥有处理器；此处只用于文档切换时撤销回调。
  raw_ptr<ZeusDesktopHandler> handler_ = nullptr;
  // Chromium 使用独立类型身份进行安全的控制器转换。
  WEB_UI_CONTROLLER_TYPE_DECL();
};

}  // namespace zeus

#endif  // CHROME_BROWSER_UI_WEBUI_ZEUS_ZEUS_UI_H_
