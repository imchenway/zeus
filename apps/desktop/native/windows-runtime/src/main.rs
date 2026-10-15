//! Zeus Windows 原生运行入口：只接受私有结构化描述，不解释模型命令。

#[cfg(windows)]
mod control;
#[cfg(windows)]
mod process;
#[cfg(windows)]
mod sandbox;
#[cfg(windows)]
mod broker;
#[cfg(windows)]
mod usn;

use serde::{Deserialize, Serialize};

/// 宿主冻结的本次目录权限；不含网络放开选项。
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SandboxPolicy {
    /// 只读或仅工作区可写，未知模式在信任边界拒绝。
    mode: String,
    /// 受限执行固定关闭网络，不接受静默放宽。
    network: String,
    /// 优先于读取与写入根的显式禁止路径。
    denied_roots: Vec<std::path::PathBuf>,
    /// 从广泛父目录授权中排除私有树，只有显式登记的子根可另行授权。
    excluded_roots: Vec<std::path::PathBuf>,
    /// 已登记的只读根目录。
    readable_roots: Vec<std::path::PathBuf>,
    /// 已登记的可写根目录，不接受任意全盘通配符。
    writable_roots: Vec<std::path::PathBuf>,
    /// 当前命令独占的临时目录。
    scratch_directory: std::path::PathBuf,
}

/// helper 专用环境传入的启动请求；业务子进程不能继承它。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchRequest {
    /// 经宿主解析的真实可执行入口。
    command: String,
    /// 未经 shell 展开的独立参数。
    args: Vec<String>,
    /// 本轮已授权的真实工作目录。
    cwd: std::path::PathBuf,
    /// 当前命令独占身份，作为恢复通道名称的一部分。
    generation: String,
    /// 终端由 node-pty 提供，本进程继承其 ConPTY。
    terminal: bool,
    /// 显式 cmd 包装保留调用方已完成的 Windows 参数转义。
    windows_verbatim_arguments: bool,
    /// 完全访问模式不设置此字段，但仍必须进入 Job。
    policy: Option<SandboxPolicy>,
}

/// 原生错误只给出系统错误码，不回显命令参数、环境或凭据。
#[cfg(windows)]
fn run() -> Result<i32, Box<dyn std::error::Error>> {
    use std::io::Read;
    let action = std::env::args().nth(1).unwrap_or_default();
    if matches!(action.as_str(), "broker-install" | "broker-uninstall" | "broker-service") {
        broker::entry(&action)?;
        return Ok(0);
    }
    if action == "serve" {
        let encoded = std::env::var("ZEUS_WINDOWS_RUNTIME_REQUEST")?;
        std::env::remove_var("ZEUS_WINDOWS_RUNTIME_REQUEST");
        let request: LaunchRequest = serde_json::from_str(&encoded)?;
        return process::serve(request);
    }
    let mut encoded = String::new();
    std::io::stdin().take(1024 * 1024 + 1).read_to_string(&mut encoded)?;
    if encoded.len() > 1024 * 1024 { return Err("原生控制请求超出大小限制".into()); }
    let request: serde_json::Value = serde_json::from_str(&encoded)?;
    let result = match action.as_str() {
        "control" => control::request(&request)?,
        "info" => process::inspect(&request)?,
        "children" => process::children(&request)?,
        "capabilities" => process::capabilities()?,
        "terminate-child" => process::terminate_child(&request)?,
        "setup" => sandbox::initialize(&request)?,
        "status" => sandbox::status(&request)?,
        "cleanup" => sandbox::cleanup(&request)?,
        _ => return Err("未知的原生控制入口".into()),
    };
    println!("{}", result);
    Ok(0)
}

/// helper 的退出码来自实际子命令；启动失败不会伪装成命令成功。
fn main() {
    #[cfg(windows)]
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            if let Some(system) = error.downcast_ref::<std::io::Error>() {
                eprintln!("Zeus Windows 原生执行失败（系统错误 {}）。", system.raw_os_error().unwrap_or(0));
            } else {
                eprintln!("Zeus Windows 原生执行或隔离配置无效；请检查安全执行环境设置。");
            }
            std::process::exit(125);
        }
    }
    #[cfg(not(windows))]
    {
        eprintln!("此组件只能在 Windows 上运行。");
        std::process::exit(125);
    }
}
