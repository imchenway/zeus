// 将桌面会话附着在原生窗口内容上，并在转发前核对共用消息格式。
#include "chrome/browser/ui/webui/zeus/zeus_desktop_session.h"

#include <algorithm>
#include <cmath>
#include <iterator>
#include <memory>
#include <set>
#include <utility>

#include "base/base64.h"
#include "base/check.h"
#include "base/strings/utf_string_conversions.h"
#include "chrome/browser/ui/webui/zeus/resources/zeus_desktop_contract.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/web_contents.h"

namespace zeus {
namespace {

// 本进程唯一的用户数据键，网页无法构造同一原生地址。
const char kDesktopSessionKey = 0;
// 单条消息的累计原始数据上限，单位为字节，与界面 wire 一致。
constexpr size_t kMaximumBytes = 64 * 1024 * 1024;
// 嵌套层数上限，避免不可信载荷耗尽浏览器线程调用栈。
constexpr size_t kMaximumDepth = 64;
// 节点数量上限，约束低字节数但大量分配的载荷。
constexpr size_t kMaximumNodes = 200000;

// 单条消息的累计预算；不会在请求之间复用状态。
struct WireBudget {
  // 已计入的原始数据字节数。
  size_t bytes = 0;
  // 已计入的值及对象键数量。
  size_t nodes = 0;

  // 在递归和二进制解码之前消耗预算，使用减法避免溢出。
  bool Take(size_t depth, size_t size = 0) {
    if (depth > kMaximumDepth || nodes >= kMaximumNodes ||
        size > kMaximumBytes - bytes) {
      return false;
    }
    ++nodes;
    bytes += size;
    return true;
  }

  // JS 字符串按 UTF-16 计费；先限制 UTF-8 长度，再做有限转换。
  bool Text(size_t depth, const std::string& text) {
    if (text.size() > kMaximumBytes * 2) {
      return false;
    }
    return Take(depth, base::UTF8ToUTF16(text).size() * 2);
  }
};

// 只接受 JSON 原语和带明确类型标记的容器，不做隐式类型转换。
bool ValidateWire(const base::Value& value, WireBudget& budget, size_t depth) {
  if (value.is_string()) {
    return budget.Text(depth, value.GetString());
  }
  if (!budget.Take(depth)) {
    return false;
  }
  if (value.is_none() || value.is_bool() || value.is_int()) {
    return true;
  }
  if (value.is_double()) {
    return std::isfinite(value.GetDouble());
  }
  if (!value.is_list()) {
    return false;
  }
  // 容器第一项为类型标记，其余项目严格按对应编码读取。
  const auto& list = value.GetList();
  if (list.empty() || !list[0].is_string()) {
    return false;
  }
  // 类型标记与界面编码器保持一致。
  const std::string& tag = list[0].GetString();
  if (tag == "undefined") {
    return list.size() == 1;
  }
  if (list.size() != 2) {
    return false;
  }
  if (tag == "buffer") {
    if (!list[1].is_string()) {
      return false;
    }
    // 先限制编码体积，避免在预算检查前分配附件内存。
    const std::string& encoded = list[1].GetString();
    if (encoded.size() % 4 != 0 ||
        encoded.size() > ((kMaximumBytes + 2) / 3) * 4) {
      return false;
    }
    // 按规范尾部填充计算原始字节数。
    const size_t padding = encoded.ends_with("==") ? 2 :
                           encoded.ends_with("=") ? 1 : 0;
    // 空串没有填充；其他编码至少包含完整四字符组。
    const size_t size = encoded.size() / 4 * 3 - padding;
    if (!budget.Take(depth, size)) {
      return false;
    }
    // 重新编码校验尾位和非法字符，不接受宽松 Base64 变体。
    std::string decoded;
    return base::Base64Decode(encoded, &decoded) && decoded.size() == size &&
           base::Base64Encode(decoded) == encoded;
  }
  if (!list[1].is_list()) {
    return false;
  }
  if (tag == "array") {
    for (const auto& child : list[1].GetList()) {
      if (!ValidateWire(child, budget, depth + 1)) {
        return false;
      }
    }
    return true;
  }
  if (tag != "object") {
    return false;
  }
  // 同一对象不允许重复键，避免不同语言解码后得到不同业务含义。
  std::set<std::string> keys;
  for (const auto& item : list[1].GetList()) {
    if (!item.is_list() || item.GetList().size() != 2 ||
        !item.GetList()[0].is_string()) {
      return false;
    }
    // 对象条目为键与编码值的二元组。
    const auto& entry = item.GetList();
    // 键必须计入同一条消息预算。
    const std::string& key = entry[0].GetString();
    if (!budget.Text(depth, key) || !keys.insert(key).second ||
        !ValidateWire(entry[1], budget, depth + 1)) {
      return false;
    }
  }
  return true;
}

}  // namespace

bool IsValidDesktopWire(const base::Value& value) {
  // 校验过程只保留当前消息预算。
  WireBudget budget;
  return ValidateWire(value, budget, 0);
}

bool IsValidDesktopArguments(const base::Value& value) {
  return value.is_list() && value.GetList().size() == 2 &&
         value.GetList()[0].is_string() &&
         value.GetList()[0].GetString() == "array" && IsValidDesktopWire(value);
}

bool IsDesktopChannel(std::string_view kind, std::string_view channel) {
  if (kind == "invoke") {
    return std::ranges::find(kZeusInvokeChannels, channel) != std::end(kZeusInvokeChannels);
  }
  if (kind == "send") {
    return std::ranges::find(kZeusSendChannels, channel) != std::end(kZeusSendChannels);
  }
  return kind == "subscribe" &&
         std::ranges::find(kZeusSubscribeChannels, channel) != std::end(kZeusSubscribeChannels);
}

ZeusDesktopSession::ZeusDesktopSession(Invoke invoke, Send send)
    : invoke_(std::move(invoke)), send_(std::move(send)) {
  CHECK(invoke_);
  CHECK(send_);
}

ZeusDesktopSession::~ZeusDesktopSession() = default;

void ZeusDesktopSession::Bind(content::WebContents* contents, Invoke invoke, Send send) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  CHECK(contents);
  contents->SetUserData(&kDesktopSessionKey,
      std::unique_ptr<ZeusDesktopSession>(new ZeusDesktopSession(std::move(invoke), std::move(send))));
}

void ZeusDesktopSession::Revoke(content::WebContents* contents) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  contents->RemoveUserData(&kDesktopSessionKey);
}

ZeusDesktopSession* ZeusDesktopSession::Get(content::WebContents* contents) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  return static_cast<ZeusDesktopSession*>(contents->GetUserData(&kDesktopSessionKey));
}

void ZeusDesktopSession::InvokeChannel(std::string channel, base::Value arguments, Reply reply) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  invoke_.Run(std::move(channel), std::move(arguments), std::move(reply));
}

void ZeusDesktopSession::SendChannel(std::string channel, base::Value arguments) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  send_.Run(std::move(channel), std::move(arguments));
}

bool ZeusDesktopSession::Publish(std::string_view channel, const base::Value& payload) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  if (!IsDesktopChannel("subscribe", channel) || !IsValidDesktopWire(payload)) {
    return false;
  }
  events_.Notify(channel, payload);
  return true;
}

base::CallbackListSubscription ZeusDesktopSession::Subscribe(Event event) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  return events_.Add(std::move(event));
}

base::WeakPtr<ZeusDesktopSession> ZeusDesktopSession::GetWeakPtr() {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  return weak_factory_.GetWeakPtr();
}

}  // namespace zeus
