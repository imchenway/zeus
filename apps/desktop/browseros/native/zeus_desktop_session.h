// Zeus 原生桌面会话：只有宿主显式绑定的 WebContents 才能访问桌面服务。
#ifndef CHROME_BROWSER_UI_WEBUI_ZEUS_ZEUS_DESKTOP_SESSION_H_
#define CHROME_BROWSER_UI_WEBUI_ZEUS_ZEUS_DESKTOP_SESSION_H_

#include <string>
#include <string_view>

#include "base/callback_list.h"
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/supports_user_data.h"
#include "base/values.h"

namespace content {
class WebContents;
}

namespace zeus {

// 固定窗口的原生桌面服务入口；回调运行在浏览器 UI 线程，载荷使用共用 wire 编码。
class ZeusDesktopSession : public base::SupportsUserData::Data {
 public:
  // 服务响应区分失败与成功；成功值必须是有效 wire 载荷，失败值为错误文字。
  using Reply = base::OnceCallback<void(bool, base::Value)>;
  // 每个绑定持有所属窗口的服务回调，不接受网页提供的窗口身份。
  using Invoke = base::RepeatingCallback<void(std::string, base::Value, Reply)>;
  // 无响应通知仍由宿主按通道和所属窗口处理。
  using Send = base::RepeatingCallback<void(std::string, base::Value)>;
  // 事件仅传递业务载荷，不向界面暴露原生 IPC 或发送者对象。
  using Event = base::RepeatingCallback<void(std::string_view, const base::Value&)>;

  // 在宿主创建的桌面 WebContents 导航前绑定服务；替换会撤销旧绑定。
  static void Bind(content::WebContents* contents, Invoke invoke, Send send);
  // 关闭窗口或撤销其桌面权限时移除服务绑定。
  static void Revoke(content::WebContents* contents);
  // 只读取原生对象上的绑定，不从 URL、JS 参数或浏览器资料推导权限。
  static ZeusDesktopSession* Get(content::WebContents* contents);
  // WebContents 销毁时同步撤销事件和未完成请求的会话身份。
  ~ZeusDesktopSession() override;
  // 桌面会话不能复制到另一个窗口。
  ZeusDesktopSession(const ZeusDesktopSession&) = delete;
  // 桌面会话不能赋值覆盖另一个窗口的身份。
  ZeusDesktopSession& operator=(const ZeusDesktopSession&) = delete;

  // 转交已校验的请求；没有自动重试或跨窗口回退。
  void InvokeChannel(std::string channel, base::Value arguments, Reply reply);
  // 转交已校验的无响应通知。
  void SendChannel(std::string channel, base::Value arguments);
  // 仅发布共用契约内的事件及有效载荷，非法事件返回 false。
  bool Publish(std::string_view channel, const base::Value& payload);
  // 页面允许接收 JS 时订阅，刷新或导航时通过订阅对象释放。
  base::CallbackListSubscription Subscribe(Event event);
  // 异步响应使用弱身份，不能保活已关闭的窗口。
  base::WeakPtr<ZeusDesktopSession> GetWeakPtr();

 private:
  // 绑定只能由 Bind 创建，避免未归属窗口的游离会话。
  ZeusDesktopSession(Invoke invoke, Send send);
  // 请求回调由可信原生宿主提供。
  Invoke invoke_;
  // 通知回调由可信原生宿主提供。
  Send send_;
  // 事件订阅随本次窗口绑定销毁。
  base::RepeatingCallbackList<void(std::string_view, const base::Value&)> events_;
  // 最后声明以先撤销异步弱引用。
  base::WeakPtrFactory<ZeusDesktopSession> weak_factory_{this};
};

// 验证共用 wire 的节点、深度、文本、二进制与对象字段限制。
bool IsValidDesktopWire(const base::Value& value);
// 桌面请求的最外层必须是参数数组，不能把业务对象当作参数列表。
bool IsValidDesktopArguments(const base::Value& value);
// 按请求、通知、事件分别查找共用接口生成的通道清单。
bool IsDesktopChannel(std::string_view kind, std::string_view channel);

}  // namespace zeus

#endif  // CHROME_BROWSER_UI_WEBUI_ZEUS_ZEUS_DESKTOP_SESSION_H_
