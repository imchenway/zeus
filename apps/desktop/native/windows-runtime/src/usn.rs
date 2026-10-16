//! 固定系统服务只追踪登记卷的文件身份并移除本产品唯一 SID；绝不读取文件内容。
use crate::process::{own, valid_generation, wide};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, io, mem::{size_of, zeroed}, os::windows::io::{AsRawHandle, OwnedHandle}, path::{Path, PathBuf}, ptr::{null, null_mut}, time::{Duration, Instant}};
use windows_sys::Win32::{Foundation::*, Security::*, Storage::FileSystem::*, System::{IO::DeviceIoControl, Ioctl::*, JobObjects::*, SystemServices::JOB_OBJECT_QUERY}};

/// 每个卷在任何授权前冻结日志身份和起点，日志换代或截断一律拒绝假报清理。
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VolumeCheckpoint {
    /// 使用卷 GUID，不依赖后来可能变化的盘符。
    volume: String,
    /// 系统日志创建身份。
    journal: u64,
    /// 第一次目录授权之前的下一个 USN。
    start: i64,
}
/// 服务登记只保存 SID 所属账号、随机任务身份及卷元数据。
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registration {
    /// 来自真实管道客户端令牌，不从请求接收。
    user: String,
    /// 本产品包名称的随机身份。
    generation: String,
    /// 来自真实管道进程句柄的 helper 身份，准备阶段的空 Job 不等于可以撤权。
    owner: Value,
    /// 任务涉及的有限卷集合。
    volumes: Vec<VolumeCheckpoint>,
}
/// 校验固定协议身份，文件名不能包含路径或其他 SID 文本。
fn registration_path(user: &str, request: &Value) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let generation = request.get("generation").and_then(Value::as_str).ok_or("缺少受限任务身份")?;
    if !valid_generation(generation) || !user.starts_with("S-1-") || !user.bytes().all(|byte| byte.is_ascii_digit() || matches!(byte, b'S' | b'-')) { return Err("受限任务登记身份无效".into()); }
    Ok(crate::broker::state_directory()?.join(format!("{user}.{generation}.json")))
}
/// 只接受 Windows 返回的本地卷 GUID；不跟随任意设备名称。
fn open_volume(volume: &str) -> Result<OwnedHandle, Box<dyn std::error::Error>> {
    if !volume.starts_with("\\\\?\\Volume{") || !volume.ends_with("}\\") || volume.len() != 49 { return Err("卷身份不是本地卷 GUID".into()); }
    let name = wide(volume.trim_end_matches('\\'))?;
    unsafe { Ok(own(CreateFileW(name.as_ptr(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, null(), OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, null_mut()))?) }
}
/// 官方卷日志查询失败直接保留登记，不创建或重置用户卷日志。
fn query(handle: &OwnedHandle) -> Result<USN_JOURNAL_DATA_V0, Box<dyn std::error::Error>> {
    unsafe {
        let mut data: USN_JOURNAL_DATA_V0 = zeroed();
        let mut bytes = 0;
        if DeviceIoControl(handle.as_raw_handle(), FSCTL_QUERY_USN_JOURNAL, null(), 0, (&mut data as *mut USN_JOURNAL_DATA_V0).cast(), size_of::<USN_JOURNAL_DATA_V0>() as u32, &mut bytes, null_mut()) == 0 { return Err(io::Error::last_os_error().into()); }
        if bytes < size_of::<USN_JOURNAL_DATA_V0>() as u32 || data.NextUsn < 0 { return Err("卷日志响应不完整".into()); }
        Ok(data)
    }
}
/// 系统解析本地路径所处卷；请求不能把网络共享或任意设备伪装成卷。
fn volume_for(path: &str) -> Result<String, Box<dyn std::error::Error>> {
    crate::sandbox::validate_local_path(Path::new(path))?;
    let encoded = wide(path)?;
    unsafe {
        let mut mount = vec![0u16; 32768];
        if GetVolumePathNameW(encoded.as_ptr(), mount.as_mut_ptr(), mount.len() as u32) == 0 { return Err(io::Error::last_os_error().into()); }
        let mut volume = vec![0u16; 128];
        if GetVolumeNameForVolumeMountPointW(mount.as_ptr(), volume.as_mut_ptr(), volume.len() as u32) == 0 { return Err(io::Error::last_os_error().into()); }
        Ok(String::from_utf16(&volume[..volume.iter().position(|value| *value == 0).ok_or("卷名未终止")?])?)
    }
}
/// 登记必须先持久化，再允许普通用户 helper 修改目录 ACL。
pub fn register(user: &str, request: &Value, owner: &Value) -> Result<Value, Box<dyn std::error::Error>> {
    let path = registration_path(user, request)?;
    if path.exists() || path.with_extension("done").exists() { return Err("受限任务身份已经登记，不能复用".into()); }
    let roots = request.get("roots").and_then(Value::as_array).filter(|roots| !roots.is_empty() && roots.len() <= 256).ok_or("登记目录数量无效")?;
    let mut names = Vec::new();
    for root in roots { names.push(volume_for(root.as_str().ok_or("登记目录无效")?)?); }
    names.sort(); names.dedup();
    let mut volumes = Vec::new();
    for volume in names {
        let journal = query(&open_volume(&volume)?)?;
        volumes.push(VolumeCheckpoint { volume, journal: journal.UsnJournalID, start: journal.NextUsn });
    }
    let registration = Registration { user: user.into(), generation: request["generation"].as_str().unwrap().into(), owner: owner.clone(), volumes };
    crate::sandbox::write_private_json(&path, &registration)?;
    Ok(json!({"registered":true}))
}
/// 服务独立确认该账号的固定命名 Job 已无进程，不信任客户端的退出声明。
fn job_active(registration: &Registration, caller: Option<&Value>) -> Result<bool, Box<dyn std::error::Error>> {
    // helper 在创建子进程前也持有空 Job；只有其自身清理或已确认退出后才能撤权。
    let pid = registration.owner.get("pid").and_then(Value::as_u64).and_then(|pid| u32::try_from(pid).ok()).filter(|pid| *pid > 0).ok_or("登记的 helper 身份无效")?;
    let birth = registration.owner.get("creationTime").and_then(Value::as_str).ok_or("登记缺少 helper 出生身份")?;
    unsafe {
        let raw = windows_sys::Win32::System::Threading::OpenProcess(windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid);
        if raw.is_null() {
            if GetLastError() != ERROR_INVALID_PARAMETER { return Err(io::Error::last_os_error().into()); }
        } else {
            let handle = own(raw)?;
            let actual = crate::process::identity_from_handle(pid, &handle)?;
            if actual["creationTime"].as_str() == Some(birth) {
                match windows_sys::Win32::System::Threading::WaitForSingleObject(handle.as_raw_handle(), 0) {
                    WAIT_OBJECT_0 => {},
                    WAIT_TIMEOUT => if !caller.is_some_and(|caller| caller["pid"] == registration.owner["pid"] && caller["creationTime"] == registration.owner["creationTime"]) { return Ok(true); },
                    _ => return Err(io::Error::last_os_error().into()),
                }
            }
        }
    }
    let name = wide(format!("Global\\Zeus.RuntimeJob.{}.{}", registration.user, registration.generation))?;
    unsafe {
        let raw = OpenJobObjectW(JOB_OBJECT_QUERY, 0, name.as_ptr());
        if raw.is_null() { return if GetLastError() == ERROR_FILE_NOT_FOUND { Ok(false) } else { Err(io::Error::last_os_error().into()) }; }
        let handle = own(raw)?;
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = zeroed();
        if QueryInformationJobObject(handle.as_raw_handle(), JobObjectBasicAccountingInformation, (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(), size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32, null_mut()) == 0 { return Err(io::Error::last_os_error().into()); }
        Ok(accounting.ActiveProcesses != 0)
    }
}
/// 先以元数据权限识别目标 SID，无关文件不申请修改权限；未确认的错误仍保留登记。
unsafe fn revoke_record(volume: &OwnedHandle, descriptor: FILE_ID_DESCRIPTOR, sid: PSID) -> Result<bool, Box<dyn std::error::Error>> {
    let raw = OpenFileById(volume.as_raw_handle(), &descriptor, READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, null(), FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    if raw == INVALID_HANDLE_VALUE { return if GetLastError() == ERROR_FILE_NOT_FOUND { Ok(false) } else { Err(io::Error::last_os_error().into()) }; }
    let probe = own(raw)?;
    if !crate::sandbox::has_package_sid(&probe, sid)? { return Ok(false); }
    // 再次按同一文件 ID 打开，只增加 WRITE_DAC，不与业务文件的数据或删除共享模式冲突。
    let raw = OpenFileById(volume.as_raw_handle(), &descriptor, READ_CONTROL | FILE_READ_ATTRIBUTES | WRITE_DAC, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, null(), FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    if raw == INVALID_HANDLE_VALUE { return if GetLastError() == ERROR_FILE_NOT_FOUND { Ok(false) } else { Err(io::Error::last_os_error().into()) }; }
    let handle = own(raw)?;
    let mut information: BY_HANDLE_FILE_INFORMATION = zeroed();
    if GetFileInformationByHandle(handle.as_raw_handle(), &mut information) == 0 { return Err(io::Error::last_os_error().into()); }
    let directory = information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    let changed = crate::sandbox::edit_acl(&handle, sid, None, directory, false)?;
    Ok(changed && directory)
}
/// 遍历冻结起点之后的所有元数据变化，包括已经移出原授权树的新建对象。
fn recover_volume(checkpoint: &VolumeCheckpoint, sid: PSID, deadline: Instant) -> Result<(), Box<dyn std::error::Error>> {
    let volume = open_volume(&checkpoint.volume)?;
    let mut cursor = checkpoint.start;
    loop {
        let state = query(&volume)?;
        if state.UsnJournalID != checkpoint.journal || cursor < state.FirstUsn.max(state.LowestValidUsn) { return Err("卷变更日志已经截断或换代，无法证明所有继承授权已撤销；登记已保留".into()); }
        let end = state.NextUsn;
        let mut changed_directory = false;
        while cursor < end {
            if Instant::now() >= deadline { return Err("卷授权恢复尚未完成，登记已保留，请稍后重试清理".into()); }
            let input = READ_USN_JOURNAL_DATA_V1 { StartUsn: cursor, ReasonMask: u32::MAX, ReturnOnlyOnClose: 0, Timeout: 0, BytesToWaitFor: 0, UsnJournalID: checkpoint.journal, MinMajorVersion: 2, MaxMajorVersion: 3 };
            let mut buffer = vec![0u8; 1024 * 1024];
            let mut returned = 0;
            unsafe {
                if DeviceIoControl(volume.as_raw_handle(), FSCTL_READ_USN_JOURNAL, (&input as *const READ_USN_JOURNAL_DATA_V1).cast(), size_of::<READ_USN_JOURNAL_DATA_V1>() as u32, buffer.as_mut_ptr().cast(), buffer.len() as u32, &mut returned, null_mut()) == 0 { return Err(io::Error::last_os_error().into()); }
                buffer.truncate(returned as usize);
                if buffer.len() < 8 { return Err("卷变更日志响应不完整".into()); }
                let next = i64::from_le_bytes(buffer[..8].try_into()?);
                if next <= cursor { return Err("卷变更日志没有向前推进，登记已保留".into()); }
                let mut offset = 8;
                while offset < buffer.len() {
                    if buffer.len() - offset < size_of::<USN_RECORD_COMMON_HEADER>() { return Err("卷变更记录头不完整".into()); }
                    let header = std::ptr::read_unaligned(buffer.as_ptr().add(offset).cast::<USN_RECORD_COMMON_HEADER>());
                    let length = header.RecordLength as usize;
                    if length < size_of::<USN_RECORD_COMMON_HEADER>() || length > buffer.len() - offset { return Err("卷变更记录长度无效".into()); }
                    let descriptor = match header.MajorVersion {
                        2 if length >= size_of::<USN_RECORD_V2>() => { let record = std::ptr::read_unaligned(buffer.as_ptr().add(offset).cast::<USN_RECORD_V2>()); FILE_ID_DESCRIPTOR { dwSize: size_of::<FILE_ID_DESCRIPTOR>() as u32, Type: FileIdType, Anonymous: FILE_ID_DESCRIPTOR_0 { FileId: record.FileReferenceNumber as i64 } } },
                        3 if length >= size_of::<USN_RECORD_V3>() => { let record = std::ptr::read_unaligned(buffer.as_ptr().add(offset).cast::<USN_RECORD_V3>()); FILE_ID_DESCRIPTOR { dwSize: size_of::<FILE_ID_DESCRIPTOR>() as u32, Type: ExtendedFileIdType, Anonymous: FILE_ID_DESCRIPTOR_0 { ExtendedFileId: record.FileReferenceNumber } } },
                        _ => return Err("卷返回了未支持的变更记录，登记已保留".into()),
                    };
                    changed_directory |= revoke_record(&volume, descriptor, sid)?;
                    offset += length;
                }
                cursor = next;
            }
        }
        // 已移出的目录也可能在扫描期间创建后代；撤去最后一批目录继承 ACE 后再追一轮。
        if !changed_directory { return Ok(()); }
    }
}
/// 完整撤权后持久标记完成；重复恢复只能复用同一真实登记结果。
pub fn recover(user: &str, request: &Value, caller: Option<&Value>) -> Result<Value, Box<dyn std::error::Error>> {
    let path = registration_path(user, request)?;
    if path.with_extension("done").exists() { return Ok(json!({"recovered":true})); }
    let encoded = fs::read(&path)?;
    if encoded.len() > 64 * 1024 { return Err("卷恢复登记超出限制".into()); }
    let registration: Registration = serde_json::from_slice(&encoded)?;
    if registration.user != user || registration.generation != request["generation"].as_str().unwrap_or("") { return Err("卷恢复登记身份不匹配".into()); }
    if job_active(&registration, caller)? { return Err("受限任务仍有活动进程，系统组件未撤权".into()); }
    // 与普通 helper 的 grant 使用同一账号锁；RPC 调用方不会持有它等待服务。
    let _lock = crate::sandbox::AclLock::for_user(&registration.user)?;
    let sid = crate::sandbox::derive_sid_for_user(&registration.user, &registration.generation)?;
    let result = (|| {
        let deadline = Instant::now() + Duration::from_secs(120);
        for checkpoint in &registration.volumes { recover_volume(checkpoint, sid, deadline)?; }
        let source = wide(&path)?;
        let destination = wide(path.with_extension("done"))?;
        unsafe { if MoveFileExW(source.as_ptr(), destination.as_ptr(), MOVEFILE_WRITE_THROUGH) == 0 { return Err(io::Error::last_os_error().into()); } }
        Ok(json!({"recovered":true}))
    })();
    unsafe { FreeSid(sid); }
    result
}
/// 只有全部登记都完成撤权时才允许卸载固定服务；完成标记不代表活动授权。
pub fn can_uninstall() -> Result<bool, Box<dyn std::error::Error>> {
    for entry in fs::read_dir(crate::broker::state_directory()?)? { if entry?.path().extension().is_some_and(|extension| extension == "json") { return Ok(false); } }
    Ok(true)
}
/// 活跃授权与待恢复登记分开报告，正常执行不能被标为恢复失败。
pub fn status() -> Result<Value, Box<dyn std::error::Error>> {
    let mut count = 0;
    let mut pending = false;
    for entry in fs::read_dir(crate::broker::state_directory()?)? {
        let path = entry?.path();
        if path.extension().is_some_and(|extension| extension == "json") {
            let encoded = fs::read(&path)?;
            if encoded.len() > 64 * 1024 { return Err("卷恢复登记超出限制".into()); }
            let registration: Registration = serde_json::from_slice(&encoded)?;
            count += 1;
            pending |= !job_active(&registration, None)?;
        }
    }
    Ok(json!({"registeredSessions":count,"pendingRecovery":pending}))
}
/// 卸载前恢复本实例的孤儿登记；登记成功后客户端崩溃也不能遗留未追踪 SID。
pub fn recover_all() -> Result<(), Box<dyn std::error::Error>> {
    for entry in fs::read_dir(crate::broker::state_directory()?)? {
        let path = entry?.path();
        if path.extension().is_some_and(|extension| extension == "json") {
            let encoded = fs::read(&path)?;
            if encoded.len() > 64 * 1024 { return Err("卷恢复登记超出限制".into()); }
            let registration: Registration = serde_json::from_slice(&encoded)?;
            recover(&registration.user, &json!({"generation":registration.generation}), None)?;
        }
    }
    Ok(())
}
