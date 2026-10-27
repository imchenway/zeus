// 现有 React 界面和原生桌面会话之间的受限 WebUI 适配。
#include "chrome/browser/ui/webui/zeus/zeus_ui.h"

#include <map>
#include <memory>
#include <utility>

#include "base/functional/bind.h"
#include "base/location.h"
#include "base/memory/weak_ptr.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/webui/zeus/resources/zeus_csp.h"
#include "chrome/browser/ui/webui/zeus/resources/zeus_resources_map.h"
#include "chrome/browser/ui/webui/zeus/zeus_desktop_session.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_data_source.h"
#include "content/public/browser/web_ui_message_handler.h"
#include "content/public/common/url_constants.h"
#include "url/gurl.h"

namespace zeus {
namespace {

// 同一文档最多保留的未完成请求数，防止渲染进程耗尽浏览器内存。
constexpr size_t kMaximumPendingInvocations = 128;
// 单个原生请求的最长等待时间，单位为秒，不会自动重新发送请求。
constexpr base::TimeDelta kInvocationTimeout = base::Seconds(120);

// 来源必须是当前顶层 Zeus 文档；URL 正确本身不代表拥有桌面权限。
bool IsTrustedZeusDocument(content::WebUI* web_ui, const GURL& source_url) {
  return source_url.SchemeIs(content::kChromeUIScheme) &&
         source_url.host() == "zeus" && !source_url.has_port() &&
         !source_url.has_username() && !source_url.has_password() &&
         web_ui->GetRenderFrameHost() &&
         web_ui->GetRenderFrameHost() == web_ui->GetWebContents()->GetPrimaryMainFrame() &&
         web_ui->GetRenderFrameHost()->GetLastCommittedURL() == source_url;
}

}  // namespace

// 请求、通知和事件各自使用生成的清单，服务不就绪时返回失败而非成功占位。
class ZeusDesktopHandler : public content::WebUIMessageHandler {
 public:
  // 处理器由 WebUI 唯一持有，异步任务只持有弱引用。
  ZeusDesktopHandler() = default;
  // 析构会取消定时器并释放原生事件订阅。
  ~ZeusDesktopHandler() override = default;

 private:
  // 绑定两条与 Chromium preload 完全一致的消息入口。
  void RegisterMessages() override {
    web_ui()->RegisterMessageCallback("zeusDesktopInvoke",
        base::BindRepeating(&ZeusDesktopHandler::HandleInvoke, base::Unretained(this)));
    web_ui()->RegisterMessageCallback("zeusDesktopSend",
        base::BindRepeating(&ZeusDesktopHandler::HandleSend, base::Unretained(this)));
  }

  // 第一次有效请求到达后才订阅事件，不能在页面初始化前调用 JS。
  void OnJavascriptAllowed() override {
    // 仅取得与当前 WebContents 绑定的原生会话。
    auto* session = ZeusDesktopSession::Get(web_ui()->GetWebContents());
    if (session) {
      subscription_ = session->Subscribe(base::BindRepeating(
          &ZeusDesktopHandler::OnEvent, weak_factory_.GetWeakPtr(), session->GetWeakPtr()));
    }
  }

  // 刷新、导航或渲染进程失效时撤销全部旧文档的响应路径。
  void OnJavascriptDisallowed() override {
    weak_factory_.InvalidateWeakPtrs();
    pending_.clear();
    subscription_ = {};
  }

  // 请求必须同时具有合法回调身份、登记通道、编码参数和原生窗口绑定。
  void HandleInvoke(const base::ListValue& args) {
    if (args.empty() || !args[0].is_string() || args[0].GetString().empty() ||
        args[0].GetString().size() > 256) {
      return;
    }
    AllowJavascript();
    // 回调身份只属于当前页面；不用于业务授权。
    const std::string callback_id = args[0].GetString();
    if (args.size() != 3 || !args[1].is_string() ||
        !IsDesktopChannel("invoke", args[1].GetString()) ||
        !IsValidDesktopArguments(args[2])) {
      RejectJavascriptCallback(base::Value(callback_id), base::Value("Zeus 原生桌面请求格式或通道无效。"));
      return;
    }
    // 窗口身份由宿主设置，不能用地址相同的普通浏览器标签替代。
    auto* session = ZeusDesktopSession::Get(web_ui()->GetWebContents());
    if (!session) {
      RejectJavascriptCallback(base::Value(callback_id), base::Value("Zeus 原生桌面服务尚未绑定此窗口。"));
      return;
    }
    if (pending_.contains(callback_id)) {
      return;
    }
    if (pending_.size() >= kMaximumPendingInvocations) {
      RejectJavascriptCallback(base::Value(callback_id), base::Value("Zeus 原生桌面请求过多，请等待已有请求结束。"));
      return;
    }
    // 定时器由请求表拥有，回复或文档撤销都会同步停止计时。
    auto timer = std::make_unique<base::OneShotTimer>();
    timer->Start(FROM_HERE, kInvocationTimeout,
        base::BindOnce(&ZeusDesktopHandler::OnTimeout, weak_factory_.GetWeakPtr(), callback_id));
    pending_.emplace(callback_id, std::move(timer));
    session->InvokeChannel(args[1].GetString(), args[2].Clone(),
        base::BindOnce(&ZeusDesktopHandler::OnReply, weak_factory_.GetWeakPtr(),
                       callback_id, session->GetWeakPtr()));
  }

  // 单向通知不创建虚假响应，也不接受请求通道作为通知执行。
  void HandleSend(const base::ListValue& args) {
    if (args.size() != 2 || !args[0].is_string() ||
        !IsDesktopChannel("send", args[0].GetString()) ||
        !IsValidDesktopArguments(args[1])) {
      return;
    }
    // 已撤销绑定的通知不能转交其他窗口或新的桌面实例。
    auto* session = ZeusDesktopSession::Get(web_ui()->GetWebContents());
    if (!session) {
      return;
    }
    AllowJavascript();
    session->SendChannel(args[0].GetString(), args[1].Clone());
  }

  // 只向发起请求的文档及同一会话返回结果，非法 wire 响应按失败处理。
  void OnReply(std::string callback_id, base::WeakPtr<ZeusDesktopSession> session,
               bool success, base::Value response) {
    if (pending_.erase(callback_id) == 0 || !IsJavascriptAllowed()) {
      return;
    }
    if (!session || session.get() != ZeusDesktopSession::Get(web_ui()->GetWebContents())) {
      RejectJavascriptCallback(base::Value(callback_id), base::Value("Zeus 原生窗口绑定已撤销，动作结果需重新确认。"));
      return;
    }
    if (success && IsValidDesktopWire(response)) {
      ResolveJavascriptCallback(base::Value(callback_id), response);
      return;
    }
    // 失败只接收有界错误文字，不把任意宿主对象传入界面异常链。
    const std::string message = !success && response.is_string() &&
                                       response.GetString().size() <= 4096
        ? response.GetString()
        : "Zeus 原生桌面服务返回了无效结果。";
    RejectJavascriptCallback(base::Value(callback_id), base::Value(message));
  }

  // 超时只结束等待，不推断动作未执行，也不自动重放。
  void OnTimeout(std::string callback_id) {
    pending_.erase(callback_id);
    if (IsJavascriptAllowed()) {
      RejectJavascriptCallback(base::Value(callback_id),
          base::Value("Zeus 原生桌面请求超时，已发出的动作可能已执行；请先检查结果，不要自动重放。"));
    }
  }

  // 会话撤销后旧事件不能进入新绑定的页面。
  void OnEvent(base::WeakPtr<ZeusDesktopSession> session,
               std::string_view channel, const base::Value& payload) {
    if (IsJavascriptAllowed() && session &&
        session.get() == ZeusDesktopSession::Get(web_ui()->GetWebContents())) {
      FireWebUIListener(channel, payload);
    }
  }

  // 当前文档的请求与定时器按回调身份保存，不包含业务参数或密码。
  std::map<std::string, std::unique_ptr<base::OneShotTimer>> pending_;
  // 当前页面唯一的原生事件订阅。
  base::CallbackListSubscription subscription_;
  // 最后声明以先撤销所有异步回调。
  base::WeakPtrFactory<ZeusDesktopHandler> weak_factory_{this};
};

ZeusUIConfig::ZeusUIConfig() : DefaultWebUIConfig(content::kChromeUIScheme, "zeus") {}

bool ZeusUIConfig::IsWebUIEnabled(content::BrowserContext* browser_context) {
  return !Profile::FromBrowserContext(browser_context)->IsOffTheRecord();
}

ZeusUI::ZeusUI(content::WebUI* web_ui) : content::WebUIController(web_ui) {
  // 资源仅来自构建产物清单，不读取页面指定的任意本地文件。
  auto* source = content::WebUIDataSource::CreateAndAdd(Profile::FromWebUI(web_ui), "zeus");
  source->AddResourcePaths(kZeusResources);
  source->SetDefaultResource(kZeusDefaultResource);
  // 复用当前 React 页面的 CSP，不引入 Chromium 的额外脚本来源。
  for (const auto& directive : kZeusContentSecurityPolicy) {
    source->OverrideContentSecurityPolicy(directive.name, directive.value);
  }
  // 当前 React 与富文本组件尚未采用 Trusted Types，保持现有页面的策略边界。
  source->DisableTrustedTypesCSP();
  // 消息处理器只提供受控转发，具体桌面服务由窗口创建者独立绑定。
  auto handler = std::make_unique<ZeusDesktopHandler>();
  handler_ = handler.get();
  web_ui->AddMessageHandler(std::move(handler));
}

ZeusUI::~ZeusUI() = default;

bool ZeusUI::OverrideHandleWebUIMessage(const GURL& source_url,
                                       const std::string& message,
                                       const base::ListValue& args) {
  return !IsTrustedZeusDocument(web_ui(), source_url) ||
         (message != "zeusDesktopInvoke" && message != "zeusDesktopSend");
}

void ZeusUI::WebUIPrimaryPageChanged(content::Page& page) {
  handler_->DisallowJavascript();
}

WEB_UI_CONTROLLER_TYPE_IMPL(ZeusUI)

}  // namespace zeus
