//! 本任务私有命名管道：由内核证明服务端身份，不接受外部 PID 指令。

use crate::process::{current_user_sid, identity, own, valid_generation, wide};
use serde_json::{json, Value};
use std::{io, mem::{size_of}, os::windows::io::{AsRawHandle, OwnedHandle}, ptr::{null, null_mut}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, thread::{self, JoinHandle}, time::{Duration, Instant}};
use windows_sys::Win32::{Foundation::*, Security::*, Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1}, Storage::FileSystem::*, System::{JobObjects::TerminateJobObject, Pipes::*}};

/// generation 是随机 UUID，不能包含路径或命名空间控制字符。
fn pipe_name(token: &str) -> Result<Vec<u16>, Box<dyn std::error::Error>> {
    if !valid_generation(token) { return Err("原生进程身份无效".into()); }
    wide(format!(r"\\.\pipe\Zeus.Runtime.{token}"))
}

/// 持有后台控制线程，关闭时等待它释放管道与 Job 引用。
pub struct Server {
    /// 只结束控制线程，不代表用户命令成功退出。
    closed: Arc<AtomicBool>,
    /// 有界轮询保证宿主退出不会被空闲客户端拖住。
    thread: Option<JoinHandle<()>>,
}

impl Server {
    /// 创建当前用户专属管道；同名管道存在时直接拒绝启动。
    pub fn start(token: &str, job: Arc<OwnedHandle>, cancelled: Arc<AtomicBool>, child_handle: Arc<Mutex<Option<Arc<OwnedHandle>>>>) -> Result<Self, Box<dyn std::error::Error>> {
        let name = pipe_name(token)?;
        let sddl = wide(format!("D:P(A;;GA;;;SY)(A;;GA;;;{})", current_user_sid()?))?;
        let pipe = unsafe {
            let mut descriptor = null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut descriptor, null_mut()) == 0 { return Err(io::Error::last_os_error().into()); }
            let security = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: descriptor, bInheritHandle: 0 };
            let handle = CreateNamedPipeW(name.as_ptr(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 4096, 4096, 0, &security);
            let result = own(handle);
            LocalFree(descriptor);
            result?
        };
        let closed = Arc::new(AtomicBool::new(false));
        let shutdown = closed.clone();
        let task = thread::spawn(move || unsafe {
            while !shutdown.load(Ordering::SeqCst) {
                if ConnectNamedPipe(pipe.as_raw_handle(), null_mut()) == 0 && GetLastError() != ERROR_PIPE_CONNECTED {
                    thread::sleep(Duration::from_millis(10));
                    continue;
                }
                let deadline = Instant::now() + Duration::from_secs(1);
                let mut buffer = [0u8; 4096];
                let mut count = 0;
                while !shutdown.load(Ordering::SeqCst) && Instant::now() < deadline {
                    if ReadFile(pipe.as_raw_handle(), buffer.as_mut_ptr(), buffer.len() as u32, &mut count, null_mut()) != 0 && count > 0 { break; }
                    if GetLastError() != ERROR_NO_DATA { break; }
                    thread::sleep(Duration::from_millis(10));
                }
                if let Ok(message) = serde_json::from_slice::<Value>(&buffer[..count as usize]) {
                    let action = message.get("action").and_then(Value::as_str).unwrap_or_default();
                    if action == "inspect" || action == "stop" {
                        if action == "stop" {
                            cancelled.store(true, Ordering::SeqCst);
                            TerminateJobObject(job.as_raw_handle(), 125);
                        }
                        let child_identity = child_handle.lock().ok().and_then(|current| current.as_ref().and_then(|handle| {
                            let mut code = 0;
                            if windows_sys::Win32::System::Threading::GetExitCodeProcess(handle.as_raw_handle(), &mut code) == 0 || code != STILL_ACTIVE as u32 { return None; }
                            crate::process::identity_from_handle(windows_sys::Win32::System::Threading::GetProcessId(handle.as_raw_handle()), handle).ok()
                        }));
                        let reply = serde_json::to_vec(&json!({"state":"verified","childIdentity":child_identity})).unwrap_or_default();
                        let mut written = 0;
                        WriteFile(pipe.as_raw_handle(), reply.as_ptr(), reply.len() as u32, &mut written, null_mut());
                        // 非阻塞通道等待客户端消费，避免断开使内核丢弃未读回复。
                        let until = Instant::now() + Duration::from_millis(100);
                        while Instant::now() < until {
                            let mut available = 0;
                            if PeekNamedPipe(pipe.as_raw_handle(), null_mut(), 0, null_mut(), &mut available, null_mut()) == 0 { break; }
                            thread::sleep(Duration::from_millis(5));
                        }
                    }
                }
                DisconnectNamedPipe(pipe.as_raw_handle());
            }
        });
        Ok(Self { closed, thread: Some(task) })
    }
}

impl Drop for Server {
    /// Job 的最后句柄不会被长期控制线程意外保留。
    fn drop(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() { let _ = thread.join(); }
    }
}

/// 通过系统管道服务端 PID 和真实映像核对目标；停止与查询使用同一连接。
pub fn request(request: &Value) -> Result<Value, Box<dyn std::error::Error>> {
    let token = request.get("token").and_then(Value::as_str).ok_or("缺少原生进程身份")?;
    let action = request.get("action").and_then(Value::as_str).ok_or("缺少控制操作")?;
    if action != "inspect" && action != "stop" { return Err("未知原生控制操作".into()); }
    let name = pipe_name(token)?;
    unsafe {
        let raw = CreateFileW(name.as_ptr(), GENERIC_READ | GENERIC_WRITE, 0, null(), OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, null_mut());
        if raw == INVALID_HANDLE_VALUE {
            return Ok(json!({"state":if GetLastError() == ERROR_FILE_NOT_FOUND {"not_found"} else {"unavailable"}}));
        }
        let pipe = own(raw)?;
        let mut server_pid = 0;
        if GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut server_pid) == 0 { return Err(io::Error::last_os_error().into()); }
        if request.get("pid").and_then(Value::as_u64).is_some_and(|expected| expected != server_pid as u64) { return Ok(json!({"state":"mismatch"})); }
        let actual = identity(server_pid)?;
        let expected_image = std::env::current_exe()?;
        if !actual["imagePath"].as_str().is_some_and(|image| image.eq_ignore_ascii_case(&expected_image.to_string_lossy())) { return Ok(json!({"state":"mismatch"})); }
        let encoded = serde_json::to_vec(&json!({"action":action}))?;
        let mut transferred = 0;
        if WriteFile(pipe.as_raw_handle(), encoded.as_ptr(), encoded.len() as u32, &mut transferred, null_mut()) == 0 { return Err(io::Error::last_os_error().into()); }
        let mut buffer = [0u8; 4096];
        if ReadFile(pipe.as_raw_handle(), buffer.as_mut_ptr(), buffer.len() as u32, &mut transferred, null_mut()) == 0 { return Err(io::Error::last_os_error().into()); }
        let reply: Value = serde_json::from_slice(&buffer[..transferred as usize])?;
        if reply.get("state").and_then(Value::as_str) != Some("verified") { return Err("原生控制回复无效".into()); }
        Ok(json!({"state":"verified","identity":actual,"childIdentity":reply["childIdentity"]}))
    }
}
