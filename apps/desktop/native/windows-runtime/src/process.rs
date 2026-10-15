//! 通过 Windows Job 与真实进程句柄管理命令，不以裸 PID 终止恢复对象。

use crate::{control, sandbox, LaunchRequest};
use serde_json::{json, Value};
use std::{io, mem::{size_of, zeroed}, os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle}, os::windows::ffi::OsStrExt, ptr::{null, null_mut}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}};
use windows_sys::Win32::{Foundation::*, Security::*, Security::Authorization::ConvertSidToStringSidW, System::{Console::*, Diagnostics::ToolHelp::*, RemoteDesktop::ProcessIdToSessionId, JobObjects::*, Threading::*}};

/// 实际查询当前交互会话与输入桌面；安全桌面和无桌面服务不能伪装成可用。
pub fn capabilities() -> Result<Value, Box<dyn std::error::Error>> {
    use windows_sys::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop, DESKTOP_READOBJECTS};
    unsafe {
        let mut session = 0;
        if ProcessIdToSessionId(GetCurrentProcessId(), &mut session) == 0 { return Err(io::Error::last_os_error().into()); }
        let desktop = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
        let available = session != 0 && !desktop.is_null();
        if !desktop.is_null() { CloseDesktop(desktop); }
        Ok(json!({"interactiveDesktop":available,"sessionId":session}))
    }
}

/// UTF-16 参数禁止内嵌空字符，防止校验内容与系统实际解析不同。
pub fn wide(value: impl AsRef<std::ffi::OsStr>) -> Result<Vec<u16>, Box<dyn std::error::Error>> {
    let mut result: Vec<u16> = value.as_ref().encode_wide().collect();
    if result.contains(&0) { return Err("Windows 参数含空字符".into()); }
    result.push(0);
    Ok(result)
}

/// 接管非空有效句柄，所有提前返回均由 RAII 关闭。
pub unsafe fn own(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE { return Err(io::Error::last_os_error()); }
    Ok(OwnedHandle::from_raw_handle(handle))
}

/// 校验 UUID 形状，限制命名管道名称并拒绝路径注入。
pub fn valid_generation(value: &str) -> bool {
    value.len() == 36 && value.bytes().enumerate().all(|(index, byte)| if [8, 13, 18, 23].contains(&index) { byte == b'-' } else { byte.is_ascii_hexdigit() })
}

/// 按 Windows C Runtime 规则编码一个参数；cmd 的显式原始模式由调用方单独声明。
fn quote(value: &str) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for character in value.chars() {
        if character == '\\' { slashes += 1; continue; }
        result.push_str(&"\\".repeat(if character == '"' { slashes * 2 + 1 } else { slashes }));
        result.push(character);
        slashes = 0;
    }
    result.push_str(&"\\".repeat(slashes * 2));
    result.push('"');
    result
}

/// 获取当前账号 SID，用于只有当前用户和系统可访问的控制管道 DACL。
pub fn current_user_sid() -> Result<String, Box<dyn std::error::Error>> {
    unsafe {
        let mut token = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 { return Err(io::Error::last_os_error().into()); }
        let token = own(token)?;
        let mut size = 0;
        GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut size);
        let mut storage = vec![0usize; (size as usize + size_of::<usize>() - 1) / size_of::<usize>()];
        if GetTokenInformation(token.as_raw_handle(), TokenUser, storage.as_mut_ptr().cast(), size, &mut size) == 0 { return Err(io::Error::last_os_error().into()); }
        let user = &*(storage.as_ptr() as *const TOKEN_USER);
        let mut sid = null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut sid) == 0 { return Err(io::Error::last_os_error().into()); }
        let mut length = 0;
        while *sid.add(length) != 0 { length += 1; }
        let result = String::from_utf16_lossy(std::slice::from_raw_parts(sid, length));
        LocalFree(sid.cast());
        Ok(result)
    }
}

/// 返回由同一个进程句柄读取的不可复用出生身份和映像路径。
pub fn identity(pid: u32) -> Result<Value, Box<dyn std::error::Error>> {
    unsafe {
        let handle = own(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid))?;
        identity_from_handle(pid, &handle)
    }
}

/// 结束操作复用同一个句柄查询身份，关闭 PID 复用竞争窗口。
pub fn identity_from_handle(pid: u32, handle: &OwnedHandle) -> Result<Value, Box<dyn std::error::Error>> {
    unsafe {
        let (mut created, mut exited, mut kernel, mut user): (FILETIME, FILETIME, FILETIME, FILETIME) = (zeroed(), zeroed(), zeroed(), zeroed());
        if GetProcessTimes(handle.as_raw_handle(), &mut created, &mut exited, &mut kernel, &mut user) == 0 { return Err(io::Error::last_os_error().into()); }
        let mut path = vec![0u16; 32768];
        let mut length = path.len() as u32;
        if QueryFullProcessImageNameW(handle.as_raw_handle(), 0, path.as_mut_ptr(), &mut length) == 0 { return Err(io::Error::last_os_error().into()); }
        Ok(json!({"pid":pid,"creationTime":(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64).to_string(),"imagePath":String::from_utf16_lossy(&path[..length as usize])}))
    }
}

/// 读取系统快照中的直接父子关系，不读取其他进程命令行或环境。
fn process_parents() -> Result<Vec<(u32, u32)>, Box<dyn std::error::Error>> {
    unsafe {
        let snapshot = own(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0))?;
        let mut entry: PROCESSENTRY32W = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut rows = Vec::new();
        let mut more = Process32FirstW(snapshot.as_raw_handle(), &mut entry);
        while more != 0 {
            rows.push((entry.th32ProcessID, entry.th32ParentProcessID));
            more = Process32NextW(snapshot.as_raw_handle(), &mut entry);
        }
        Ok(rows)
    }
}

/// 信任边界只接受真实的 Windows 无符号进程身份。
fn pid(request: &Value, field: &str) -> Result<u32, Box<dyn std::error::Error>> {
    let value = request.get(field).and_then(Value::as_u64).filter(|value| *value > 1 && *value <= u32::MAX as u64).ok_or("进程身份无效")?;
    Ok(value as u32)
}

/// CUA 启动时核对真实 worker 父进程和程序路径。
pub fn inspect(request: &Value) -> Result<Value, Box<dyn std::error::Error>> {
    let requested = pid(request, "pid")?;
    let mut result = identity(requested)?;
    result["parentPid"] = json!(process_parents()?.iter().find(|entry| entry.0 == requested).map(|entry| entry.1));
    Ok(result)
}

/// 只返回指定宿主的直接子进程，供启动取消时执行准确清理。
pub fn children(request: &Value) -> Result<Value, Box<dyn std::error::Error>> {
    let parent = pid(request, "pid")?;
    let rows: Vec<Value> = process_parents()?.into_iter().filter(|entry| entry.1 == parent).filter_map(|entry| identity(entry.0).ok()).collect();
    Ok(json!(rows))
}

/// 仅停止仍属于指定父进程、出生时间与程序路径均匹配的原生 worker。
pub fn terminate_child(request: &Value) -> Result<Value, Box<dyn std::error::Error>> {
    let requested = pid(request, "pid")?;
    let parent = pid(request, "parentPid")?;
    unsafe {
        let handle = own(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, 0, requested))?;
        let current = identity_from_handle(requested, &handle)?;
        if !process_parents()?.contains(&(requested, parent)) || current["imagePath"] != request["imagePath"] || current["creationTime"] != request["creationTime"] { return Err("原生子进程身份已变化".into()); }
        if TerminateProcess(handle.as_raw_handle(), 125) == 0 { return Err(io::Error::last_os_error().into()); }
    }
    Ok(json!({"stopped":true}))
}

/// 私有 Job 名称与随机任务身份绑定，恢复可查询内核对象而不是猜测后代 PID。
pub fn job_name(generation: &str) -> Result<Vec<u16>, Box<dyn std::error::Error>> {
    if !valid_generation(generation) { return Err("Job 身份无效".into()); }
    wide(format!("Global\\Zeus.RuntimeJob.{}.{}", current_user_sid()?, generation))
}
/// 先终止整棵 Job 进程树并等待内核确认；未确认就不能撤销 ACL 或删除 profile。
pub fn terminate_job(job: &OwnedHandle) -> Result<(), Box<dyn std::error::Error>> {
    unsafe {
        if TerminateJobObject(job.as_raw_handle(), 125) == 0 { return Err(io::Error::last_os_error().into()); }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let mut information: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = zeroed();
            if QueryInformationJobObject(job.as_raw_handle(), JobObjectBasicAccountingInformation, (&mut information as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(), size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32, null_mut()) == 0 { return Err(io::Error::last_os_error().into()); }
            if information.ActiveProcesses == 0 { return Ok(()); }
            if std::time::Instant::now() >= deadline { return Err("受限进程树退出状态无法确认，已保留恢复日志".into()); }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
}

/// ConPTY 的 Ctrl+C 交给业务进程处理；自定义处理器不会让子进程继承忽略标记。
unsafe extern "system" fn console_control(event: u32) -> BOOL {
    i32::from(matches!(event, CTRL_C_EVENT | CTRL_BREAK_EVENT))
}

/// 在恢复通道与 Job 就绪之后创建命令，任何失败均不放行到普通 spawn。
pub fn serve(request: LaunchRequest) -> Result<i32, Box<dyn std::error::Error>> {
    if !valid_generation(&request.generation) || !request.cwd.is_absolute() || request.command.is_empty() || request.args.len() > 32768 { return Err("原生启动描述无效".into()); }
    std::env::remove_var("ZEUS_RUNTIME_PROCESS_IDENTITY_TOKEN");
    let cancelled = Arc::new(AtomicBool::new(false));
    unsafe {
        if request.terminal && SetConsoleCtrlHandler(Some(console_control), 1) == 0 { return Err(io::Error::last_os_error().into()); }
        let name = job_name(&request.generation)?;
        let descriptor = sandbox::security_descriptor()?;
        let security = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: descriptor.0, bInheritHandle: 0 };
        let raw_job = CreateJobObjectW(&security, name.as_ptr());
        let already_exists = GetLastError() == ERROR_ALREADY_EXISTS;
        let job = Arc::new(own(raw_job)?);
        if already_exists { return Err("同一任务 Job 已经存在，未重复执行命令".into()); }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(job.as_raw_handle(), JobObjectExtendedLimitInformation, (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) == 0 { return Err(io::Error::last_os_error().into()); }
        let child_handle = Arc::new(Mutex::new(None));
        let _control = control::Server::start(&request.generation, job.clone(), cancelled.clone(), child_handle.clone())?;
        let mut prepared = request.policy.as_ref().map(|policy| sandbox::prepare(policy, &request.generation, &request.cwd)).transpose()?;
        if cancelled.load(Ordering::SeqCst) { return Err("命令已取消".into()); }
        let result = launch(&request, &job, prepared.as_ref(), &cancelled, &child_handle);
        // 目标退出后先清理残留后代，再撤销目录授权。
        if let Err(error) = terminate_job(&job) {
            if let Some(prepared) = prepared.as_mut() { prepared.retain_for_recovery(); }
            return Err(error);
        }
        if let Some(prepared) = prepared.as_mut() { prepared.cleanup()?; }
        result
    }
}

/// 子进程先保持挂起，加入 Job 成功后才运行；句柄继承只限标准输入输出。
unsafe fn launch(request: &LaunchRequest, job: &OwnedHandle, sandbox: Option<&sandbox::PreparedSandbox>, cancelled: &AtomicBool, child_handle: &Mutex<Option<Arc<OwnedHandle>>>) -> Result<i32, Box<dyn std::error::Error>> {
    let executable = wide(&request.command)?;
    let arguments = if request.windows_verbatim_arguments { request.args.join(" ") } else { request.args.iter().map(|value| quote(value)).collect::<Vec<_>>().join(" ") };
    let mut command_line = wide(format!("{} {}", quote(&request.command), arguments))?;
    let cwd = wide(&request.cwd)?;
    let attribute_count = if sandbox.is_some() { 2 } else { 0 } + if request.terminal { 0 } else { 1 };
    let mut attribute_size = 0;
    if attribute_count > 0 { InitializeProcThreadAttributeList(null_mut(), attribute_count, 0, &mut attribute_size); }
    let mut attributes = vec![0usize; (attribute_size + size_of::<usize>() - 1) / size_of::<usize>()];
    let mut startup: STARTUPINFOEXW = zeroed();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = if attribute_count > 0 { attributes.as_mut_ptr().cast() } else { null_mut() };
    if attribute_count > 0 && InitializeProcThreadAttributeList(startup.lpAttributeList, attribute_count, 0, &mut attribute_size) == 0 { return Err(io::Error::last_os_error().into()); }
    let mut handles = vec![GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE), GetStdHandle(STD_ERROR_HANDLE)];
    handles.retain(|handle| !handle.is_null() && *handle != INVALID_HANDLE_VALUE);
    handles.sort();
    handles.dedup();
    let prepare_attributes = (|| -> Result<(), Box<dyn std::error::Error>> {
        if !request.terminal {
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
            startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
            startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
            for handle in &handles { if SetHandleInformation(*handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) == 0 { return Err(io::Error::last_os_error().into()); } }
            if UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, handles.as_mut_ptr().cast(), handles.len() * size_of::<HANDLE>(), null_mut(), null_mut()) == 0 { return Err(io::Error::last_os_error().into()); }
        }
        if let Some(prepared) = sandbox { prepared.apply_attributes(startup.lpAttributeList)?; }
        Ok(())
    })();
    if let Err(error) = prepare_attributes { if attribute_count > 0 { DeleteProcThreadAttributeList(startup.lpAttributeList); } return Err(error); }
    let mut child: PROCESS_INFORMATION = zeroed();
    let created = CreateProcessW(executable.as_ptr(), command_line.as_mut_ptr(), null(), null(), if request.terminal { 0 } else { 1 }, CREATE_SUSPENDED | if attribute_count > 0 { EXTENDED_STARTUPINFO_PRESENT } else { 0 } | if request.terminal { 0 } else { CREATE_NO_WINDOW }, null(), cwd.as_ptr(), &startup.StartupInfo, &mut child);
    let creation_error = io::Error::last_os_error();
    if attribute_count > 0 { DeleteProcThreadAttributeList(startup.lpAttributeList); }
    if created == 0 { return Err(creation_error.into()); }
    let process = Arc::new(own(child.hProcess)?);
    *child_handle.lock().map_err(|_| "子进程身份锁不可用")? = Some(process.clone());
    let thread = own(child.hThread)?;
    if AssignProcessToJobObject(job.as_raw_handle(), process.as_raw_handle()) == 0 {
        let error = io::Error::last_os_error();
        TerminateProcess(process.as_raw_handle(), 125);
        return Err(error.into());
    }
    if let Some(sandbox) = sandbox { if let Err(error) = sandbox.record_process(child.dwProcessId, &process) { TerminateProcess(process.as_raw_handle(), 125); return Err(error); } }
    if cancelled.load(Ordering::SeqCst) || ResumeThread(thread.as_raw_handle()) == u32::MAX {
        let error = io::Error::last_os_error();
        TerminateProcess(process.as_raw_handle(), 125);
        return Err(error.into());
    }
    if WaitForSingleObject(process.as_raw_handle(), INFINITE) != WAIT_OBJECT_0 { return Err(io::Error::last_os_error().into()); }
    let mut code = 125;
    if GetExitCodeProcess(process.as_raw_handle(), &mut code) == 0 { return Err(io::Error::last_os_error().into()); }
    Ok(code as i32)
}
