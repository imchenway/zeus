//! LPAC 使用每命令独立的包 SID；目录授权可恢复，网络能力始终为空。
use crate::{process::{current_user_sid, own, valid_generation, wide}, SandboxPolicy};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs::{self, File, OpenOptions}, io::{self, Read, Write}, mem::{size_of, zeroed}, os::windows::io::{AsRawHandle, OwnedHandle}, path::{Path, PathBuf}, ptr::{null, null_mut}};
use windows_sys::{Wdk::Storage::FileSystem::NtSetSecurityObject, Win32::{Foundation::*, Security::{*, Authorization::*, Isolation::*}, Storage::FileSystem::*, System::{Threading::*, JobObjects::*, SystemServices::{ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE, SECURITY_DESCRIPTOR_REVISION, JOB_OBJECT_QUERY, JOB_OBJECT_TERMINATE}}}};

/// 每次授权独占一个确定的包名称；随机 generation 不从外部文本推导。
fn profile_name(generation: &str) -> Result<String, Box<dyn std::error::Error>> {
    profile_name_for_user(&current_user_sid()?, generation)
}
/// 包身份同时绑定实际账号和本次任务；系统恢复服务不能跨账号撤销其他会话的 SID。
pub(crate) fn profile_name_for_user(user: &str, generation: &str) -> Result<String, Box<dyn std::error::Error>> {
    use windows_sys::Win32::Security::Cryptography::{BCryptCloseAlgorithmProvider, BCryptHash, BCryptOpenAlgorithmProvider, BCRYPT_SHA256_ALGORITHM};
    if !valid_generation(generation) || user.len() > 184 || !user.starts_with("S-1-") || !user.bytes().all(|byte| byte.is_ascii_digit() || matches!(byte, b'S' | b'-')) { return Err("隔离包的用户或任务身份无效".into()); }
    let input = format!("{}\0{}", user, generation.to_ascii_lowercase());
    unsafe {
        let mut algorithm = null_mut();
        let opened = BCryptOpenAlgorithmProvider(&mut algorithm, BCRYPT_SHA256_ALGORITHM, null(), 0);
        if opened < 0 { return Err(io::Error::from_raw_os_error(opened).into()); }
        let mut digest = [0u8; 32];
        let hashed = BCryptHash(algorithm, null(), 0, input.as_ptr(), input.len() as u32, digest.as_mut_ptr(), digest.len() as u32);
        BCryptCloseAlgorithmProvider(algorithm, 0);
        if hashed < 0 { return Err(io::Error::from_raw_os_error(hashed).into()); }
        // 63 个 ASCII 字符满足系统名称上限；保留 232 位摘要，不截短账号或任务文本。
        Ok(format!("Zeus.{}", digest[..29].iter().map(|byte| format!("{byte:02x}")).collect::<String>()))
    }
}
/// Windows 的 LPAC 属性值；排除 ALL_APPLICATION_PACKAGES 的默认访问。
const ALL_APPLICATION_PACKAGES_OPT_OUT: u32 = 1;
/// 单份恢复日志只保存授权根，不保存命令或环境凭据。
const MAX_JOURNAL_BYTES: u64 = 1024 * 1024;

/// 恢复只删除本次包 SID，绝不回滚整份 DACL 覆盖其他会话或用户修改。
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    /// 控制通道与包 SID 的共同身份。
    generation: String,
    /// 授权树的真实根路径，读写权限均在清理时按 SID 删除。
    roots: Vec<GrantedRoot>,
    /// 挂起业务进程在运行前登记，崩溃恢复不能只凭管道消失撤权。
    process: Option<Value>,
    /// 卷日志登记成功并持久化后才允许追加任何包 SID 权限。
    broker_registered: bool,
}
/// 路径只是定位信息，恢复还必须匹配同一个卷和文件对象。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GrantedRoot {
    /// 冻结时的规范路径。
    path: PathBuf,
    /// Windows 卷序列号。
    volume: u32,
    /// 文件对象标识的高位和低位。
    index: u64,
    /// 创建时间仅用于诊断；该属性可修改，不能作为撤权身份判断。
    birth: u64,
}
/// 从真实句柄取得冻结身份，不信任路径字符串本身。
fn granted_root(path: PathBuf, info: &BY_HANDLE_FILE_INFORMATION) -> GrantedRoot {
    GrantedRoot { path, volume: info.dwVolumeSerialNumber, index: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64, birth: ((info.ftCreationTime.dwHighDateTime as u64) << 32) | info.ftCreationTime.dwLowDateTime as u64 }
}
/// 进程内核互斥量只覆盖 ACL 的读改写，避免并行会话丢失对方 ACE。
pub(crate) struct AclLock(OwnedHandle);
impl AclLock {
    /// ponytail: 当前账号的 ACL 修改串行；目录规模需要时再改为按文件身份排序的锁。
    fn acquire() -> Result<Self, Box<dyn std::error::Error>> { Self::for_user(&current_user_sid()?) }
    /// 服务按已认证账号使用同一个锁，不能改锁为 SYSTEM 自身的账号。
    pub(crate) fn for_user(user: &str) -> Result<Self, Box<dyn std::error::Error>> {
        unsafe {
            let name = wide(format!("Global\\Zeus.LpacAcl.{user}"))?;
            let descriptor = security_descriptor_for_user(user)?;
            let security = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: descriptor.0, bInheritHandle: 0 };
            let handle = own(CreateMutexW(&security, 0, name.as_ptr()))?;
            let result = WaitForSingleObject(handle.as_raw_handle(), 120_000);
            if result != WAIT_OBJECT_0 && result != WAIT_ABANDONED { return Err("目录授权正由其他操作占用，请核对状态后重试".into()); }
            Ok(Self(handle))
        }
    }
}
impl Drop for AclLock { /// 失败和提前返回同样释放锁。
    fn drop(&mut self) { unsafe { ReleaseMutex(self.0.as_raw_handle()); } }
}
/// Windows 返回的安全描述符由 LocalFree 释放。
pub(crate) struct LocalDescriptor(pub(crate) PSECURITY_DESCRIPTOR);
impl Drop for LocalDescriptor { /// 安全描述符不能跨调用泄漏。
    fn drop(&mut self) { unsafe { LocalFree(self.0); } }
}
/// 恢复日志按当前账号隔离，SYSTEM 和管理员保留操作系统恢复权限。
pub(crate) fn security_descriptor() -> Result<LocalDescriptor, Box<dyn std::error::Error>> { security_descriptor_for_user(&current_user_sid()?) }
/// 固定账号 DACL 允许 SYSTEM 和管理员恢复，不开放给其他普通账号。
fn security_descriptor_for_user(user: &str) -> Result<LocalDescriptor, Box<dyn std::error::Error>> {
    let sddl = wide(format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{user})"))?;
    unsafe {
        let mut descriptor = null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut descriptor, null_mut()) == 0 { return Err(io::Error::last_os_error().into()); }
        Ok(LocalDescriptor(descriptor))
    }
}
/// 打开对象本身，不跟随最终重解析点，也不允许路径在当前操作中被改名替换。
fn open_path(path: &Path, mutate: bool) -> Result<(OwnedHandle, BY_HANDLE_FILE_INFORMATION), Box<dyn std::error::Error>> {
    let encoded = wide(path)?;
    unsafe {
        // ACL 操作不申请数据写入或 DELETE，避免与本次及并行任务的防改名句柄冲突。
        let access = READ_CONTROL | FILE_READ_ATTRIBUTES | if mutate { WRITE_DAC } else { FILE_GENERIC_READ };
        let handle = own(CreateFileW(encoded.as_ptr(), access, FILE_SHARE_READ | FILE_SHARE_WRITE, null(), OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()))?;
        let mut info: BY_HANDLE_FILE_INFORMATION = zeroed();
        if GetFileInformationByHandle(handle.as_raw_handle(), &mut info) == 0 { return Err(io::Error::last_os_error().into()); }
        // 从已打开的句柄复验路径，拒绝授权前祖先目录被重解析或替换。
        let mut final_path = vec![0u16; 32768];
        let length = GetFinalPathNameByHandleW(handle.as_raw_handle(), final_path.as_mut_ptr(), final_path.len() as u32, FILE_NAME_NORMALIZED);
        if length == 0 || length as usize >= final_path.len() { return Err(io::Error::last_os_error().into()); }
        let actual = String::from_utf16_lossy(&final_path[..length as usize]);
        let expected = path.to_string_lossy().replace('/', "\\");
        if !actual.strip_prefix("\\\\?\\").unwrap_or(&actual).eq_ignore_ascii_case(expected.strip_prefix("\\\\?\\").unwrap_or(&expected)) { return Err("隔离目录的真实路径已变化，未授权目录访问".into()); }
        Ok((handle, info))
    }
}
/// 配置目录必须为本地真实目录；UNC、盘符根和重解析点不进入隔离配置。
fn home(request: &Value) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let path = request.get("home").and_then(Value::as_str).map(PathBuf::from).or_else(|| std::env::var_os("ZEUS_WINDOWS_SANDBOX_HOME").map(PathBuf::from)).ok_or("Windows 受限执行目录尚未配置")?;
    validate_local_path(&path)?;
    Ok(path)
}
/// 只接受本地磁盘上的绝对路径，防止把网络文件系统当作本地 ACL 边界。
pub(crate) fn validate_local_path(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let text = path.to_string_lossy();
    let regular = text.strip_prefix("\\\\?\\").unwrap_or(&text);
    if !path.is_absolute() || regular.len() < 4 || regular.as_bytes()[1] != b':' || !regular.as_bytes()[0].is_ascii_alphabetic() || !matches!(regular.as_bytes()[2], b'\\' | b'/') || regular.contains('\0') { return Err("隔离目录必须是本地磁盘上的明确目录，不能使用网络路径或磁盘根".into()); }
    Ok(())
}
/// 首次初始化创建私有配置目录；已有重解析点绝不跟随。
fn ensure_home(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(path)?;
    let (handle, info) = open_path(path, true)?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 { return Err("隔离配置目录不是普通目录".into()); }
    let descriptor = security_descriptor()?;
    unsafe {
        let (mut present, mut defaulted, mut acl) = (0, 0, null_mut());
        if GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut acl, &mut defaulted) == 0 || present == 0 || acl.is_null() { return Err("私有目录安全描述无效".into()); }
        set_object_dacl(&handle, acl, SE_DACL_PROTECTED)?;
    }
    Ok(())
}
/// 持久化日志先落盘，再触及用户目录 ACL；create_new 避免覆写已有会话。
pub(crate) fn write_private_json(path: &Path, value: &impl Serialize) -> Result<(), Box<dyn std::error::Error>> {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos();
    let temporary = path.with_extension(format!("publishing.{}.{}", std::process::id(), stamp));
    let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary)?;
    file.write_all(&serde_json::to_vec(value)?)?;
    file.sync_all()?;
    drop(file);
    unsafe {
        let source = wide(&temporary)?;
        let destination = wide(path)?;
        if MoveFileExW(source.as_ptr(), destination.as_ptr(), MOVEFILE_WRITE_THROUGH) == 0 { let error = io::Error::last_os_error(); let _ = fs::remove_file(&temporary); return Err(error.into()); }
    }
    Ok(())
}
/// 状态变更使用同目录持久发布，原日志在新内容完整落盘前始终可恢复。
fn replace_private_json(path: &Path, value: &impl Serialize) -> Result<(), Box<dyn std::error::Error>> {
    let pending = path.with_extension("pending");
    if pending.exists() { fs::remove_file(&pending)?; }
    write_private_json(&pending, value)?;
    unsafe { if MoveFileExW(wide(&pending)?.as_ptr(), wide(path)?.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) == 0 { return Err(io::Error::last_os_error().into()); } }
    Ok(())
}
/// 路径比较仅消除 Windows 规范前缀和盘符大小写，不扩大真实句柄校验范围。
fn normalized_path(path: &Path) -> String { path.to_string_lossy().replace('/', "\\").trim_start_matches("\\\\?\\").trim_end_matches('\\').to_ascii_lowercase() }
/// 判断冻结路径是否在边界本身或其后代，避免字符串前缀误命中同名目录。
fn within(path: &Path, root: &Path) -> bool { let path = normalized_path(path); let root = normalized_path(root); path == root || path.starts_with(&(root + "\\")) }
/// 读取恢复文件前拒绝重解析点并限制体积。
fn read_journal(path: &Path) -> Result<Journal, Box<dyn std::error::Error>> {
    let (handle, info) = open_path(path, false)?;
    if info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0 { return Err("恢复日志不是普通文件".into()); }
    let mut file = File::from(handle);
    let mut buffer = Vec::new();
    std::io::Read::by_ref(&mut file).take(MAX_JOURNAL_BYTES + 1).read_to_end(&mut buffer)?;
    if buffer.len() as u64 > MAX_JOURNAL_BYTES { return Err("恢复日志超出大小限制".into()); }
    let journal: Journal = serde_json::from_slice(&buffer)?;
    if !valid_generation(&journal.generation) || journal.roots.is_empty() { return Err("恢复日志身份无效".into()); }
    for root in &journal.roots { validate_local_path(&root.path)?; }
    Ok(journal)
}
/// 查询受限任务只看本账号私有管道，不使用可复用 PID 判断是否存活。
fn active(generation: &str) -> Result<bool, Box<dyn std::error::Error>> {
    let result = crate::control::request(&json!({"token":generation,"action":"inspect"}))?;
    match result["state"].as_str() { Some("verified") => Ok(true), Some("not_found") => Ok(false), _ => Err("受限任务身份暂时无法确认，未撤销权限".into()) }
}
/// 枚举所有旧日志，但不因文件名猜测或跳过异常恢复状态。
fn journals(home: &Path) -> Result<Vec<PathBuf>, Box<dyn std::error::Error>> {
    if !home.exists() { return Ok(Vec::new()); }
    let mut result = Vec::new();
    for entry in fs::read_dir(home)? { let path = entry?.path(); if path.extension().is_some_and(|value| value == "json") && path.file_name().is_some_and(|value| value != "configured.json") { result.push(path); } }
    Ok(result)
}
/// 只设置当前句柄的 DACL；原生对象接口不递归传播，后代由显式遍历和 USN 恢复处理。
unsafe fn set_object_dacl(handle: &OwnedHandle, acl: *mut ACL, control: SECURITY_DESCRIPTOR_CONTROL) -> Result<(), Box<dyn std::error::Error>> {
    // NtSetSecurityObject 是文档规定的用户态入口，只需 WRITE_DAC，不申请 DELETE 或借路径重开对象。
    let mut descriptor: SECURITY_DESCRIPTOR = zeroed();
    let pointer = (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast();
    if InitializeSecurityDescriptor(pointer, SECURITY_DESCRIPTOR_REVISION) == 0 || SetSecurityDescriptorDacl(pointer, 1, acl, 0) == 0 { return Err(io::Error::last_os_error().into()); }
    // 保留原对象的保护和自动继承状态；不引入新的自动继承请求，也不修改 owner、SACL。
    let preserved = SE_DACL_PROTECTED | SE_DACL_AUTO_INHERITED;
    if SetSecurityDescriptorControl(pointer, preserved, control & preserved) == 0 { return Err(io::Error::last_os_error().into()); }
    let status = NtSetSecurityObject(handle.as_raw_handle(), DACL_SECURITY_INFORMATION, pointer);
    if status < 0 { return Err(format!("文件对象 DACL 更新失败，NTSTATUS=0x{:08X}", status as u32).into()); }
    Ok(())
}
/// 元数据探查只识别本次包 SID，不要求读取文件内容或修改无关对象。
pub(crate) unsafe fn has_package_sid(handle: &OwnedHandle, sid: PSID) -> Result<bool, Box<dyn std::error::Error>> {
    let mut acl = null_mut();
    let mut descriptor = null_mut();
    let result = GetSecurityInfo(handle.as_raw_handle(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), &mut acl, null_mut(), &mut descriptor);
    if result != ERROR_SUCCESS { return Err(io::Error::from_raw_os_error(result as i32).into()); }
    let _descriptor = LocalDescriptor(descriptor);
    if acl.is_null() { return Ok(false); }
    for index in 0..(*acl).AceCount as u32 {
        let mut pointer = null_mut();
        if GetAce(acl, index, &mut pointer) == 0 { return Err(io::Error::last_os_error().into()); }
        if matches_package_sid(pointer, sid) { return Ok(true); }
    }
    Ok(false)
}
/// 只匹配本组件写入及继承的标准 allow/deny ACE，其他会话和其他 ACE 原样保留。
unsafe fn matches_package_sid(pointer: *const std::ffi::c_void, sid: PSID) -> bool {
    let header = &*(pointer as *const ACE_HEADER);
    (header.AceType == ACCESS_ALLOWED_ACE_TYPE as u8 || header.AceType == ACCESS_DENIED_ACE_TYPE as u8) && EqualSid((&(*(pointer as *const ACCESS_ALLOWED_ACE)).SidStart as *const u32).cast_mut().cast(), sid) != 0
}
/// 按当前 DACL 合并本次 SID，再以对象级接口更新，避免系统沿未核验的后代传播权限。
pub(crate) unsafe fn edit_acl(handle: &OwnedHandle, sid: PSID, mask: Option<u32>, directory: bool, denied: bool) -> Result<bool, Box<dyn std::error::Error>> {
    let mut old_acl = null_mut();
    let mut raw_descriptor = null_mut();
    let result = GetSecurityInfo(handle.as_raw_handle(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), &mut old_acl, null_mut(), &mut raw_descriptor);
    if result != ERROR_SUCCESS { return Err(io::Error::from_raw_os_error(result as i32).into()); }
    let _descriptor = LocalDescriptor(raw_descriptor);
    if old_acl.is_null() { return Err("目录包含不受限的空 DACL，不能安全追加隔离授权".into()); }
    let mut information: ACL_SIZE_INFORMATION = zeroed();
    if GetAclInformation(old_acl, (&mut information as *mut ACL_SIZE_INFORMATION).cast(), size_of::<ACL_SIZE_INFORMATION>() as u32, AclSizeInformation) == 0 { return Err(io::Error::last_os_error().into()); }
    let size = information.AclBytesInUse as usize + size_of::<ACCESS_ALLOWED_ACE>() + GetLengthSid(sid) as usize + 16;
    let mut storage = vec![0usize; (size + size_of::<usize>() - 1) / size_of::<usize>()];
    let acl = storage.as_mut_ptr().cast::<ACL>();
    if InitializeAcl(acl, size as u32, ACL_REVISION) == 0 { return Err(io::Error::last_os_error().into()); }
    let mut found = false;
    let mut inserted = false;
    if denied { if let Some(mask) = mask { if AddAccessDeniedAceEx(acl, ACL_REVISION, if directory { OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE } else { 0 }, mask, sid) == 0 { return Err(io::Error::last_os_error().into()); } inserted = true; } }
    for index in 0..information.AceCount {
        let mut pointer = null_mut();
        if GetAce(old_acl, index, &mut pointer) == 0 { return Err(io::Error::last_os_error().into()); }
        let header = &*(pointer as *const ACE_HEADER);
        if matches_package_sid(pointer, sid) { found = true; continue; }
        if header.AceFlags & INHERITED_ACE as u8 != 0 && !inserted {
            if let Some(mask) = mask { if AddAccessAllowedAceEx(acl, ACL_REVISION, if directory { OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE } else { 0 }, mask, sid) == 0 { return Err(io::Error::last_os_error().into()); } }
            inserted = true;
        }
        if AddAce(acl, ACL_REVISION, u32::MAX, pointer, header.AceSize as u32) == 0 { return Err(io::Error::last_os_error().into()); }
    }
    if mask.is_none() && !found { return Ok(false); }
    if !inserted { if let Some(mask) = mask { if AddAccessAllowedAceEx(acl, ACL_REVISION, if directory { OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE } else { 0 }, mask, sid) == 0 { return Err(io::Error::last_os_error().into()); } } }
    let (mut control, mut revision) = (0, 0);
    if GetSecurityDescriptorControl(raw_descriptor, &mut control, &mut revision) == 0 { return Err(io::Error::last_os_error().into()); }
    set_object_dacl(handle, acl, control)?;
    Ok(true)
}
/// 父目录句柄在递归期间不允许删除或替换，最终分量始终按重解析对象自身打开。
fn visit(path: &Path, sid: PSID, write: Option<bool>, depth: usize, denied: bool, mut ledger: Option<&mut File>, excluded: &[PathBuf]) -> Result<(), Box<dyn std::error::Error>> {
    if write.is_some() && !denied {
        if excluded.iter().any(|root| normalized_path(root) == normalized_path(path)) { return Ok(()); }
        if let Some(home) = std::env::var_os("ZEUS_WINDOWS_SANDBOX_HOME") {
            if fs::canonicalize(PathBuf::from(home)).ok().as_deref() == Some(path) { return Ok(()); }
        }
    }
    if depth > 256 { return Err("隔离目录层级过深，尚未启动命令".into()); }
    let (handle, info) = open_path(path, true)?;
    // 链接自身不授予目标权限；目标只有独立落在冻结根内才可访问。
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        // 新增授权不触碰链接目标；撤权仍删除链接对象自身继承的本次 SID。
        if write.is_none() { unsafe { edit_acl(&handle, sid, None, false, false)?; } }
        return Ok(());
    }
    let directory = info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    let mask = write.map(|write| {
        if denied { return FILE_ALL_ACCESS; }
        let readable = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
        // 多硬链接文件保持只读，禁止通过同一文件身份修改授权根之外的别名。
        if write && (directory || info.nNumberOfLinks <= 1) { readable | FILE_GENERIC_WRITE | if directory { FILE_DELETE_CHILD } else { 0 } } else { readable }
    });
    if let Some(ledger) = ledger.as_deref_mut() {
        // 先落对象身份，再改 ACL；对象后来改名也能按文件编号撤销本 SID。
        serde_json::to_writer(&mut *ledger, &granted_root(path.to_owned(), &info))?;
        ledger.write_all(b"\n")?;
        ledger.sync_all()?;
    }
    unsafe { edit_acl(&handle, sid, mask, directory, denied)?; }
    if directory { for entry in fs::read_dir(path)? { visit(&entry?.path(), sid, write, depth + 1, denied, ledger.as_deref_mut(), excluded)?; } }
    Ok(())
}
/// 从 profile 名称派生唯一 SID，不通过缓存或其他会话借用身份。
pub(crate) fn derive_sid(generation: &str) -> Result<PSID, Box<dyn std::error::Error>> {
    derive_sid_for_user(&current_user_sid()?, generation)
}
/// 系统服务显式使用经过管道令牌认证的用户，不能误用服务自身的 SYSTEM 身份。
pub(crate) fn derive_sid_for_user(user: &str, generation: &str) -> Result<PSID, Box<dyn std::error::Error>> {
    let name = wide(profile_name_for_user(user, generation)?)?;
    unsafe { let mut sid = null_mut(); let result = DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid); if result < 0 { return Err(io::Error::from_raw_os_error(result).into()); } Ok(sid) }
}
/// 已无活跃 Job 后撤销该 SID；部分失败保留完整日志，禁止假报清理成功。
fn revoke(path: &Path, journal: &Journal) -> Result<(), Box<dyn std::error::Error>> {
    // helper 句柄消失只触发 KILL_ON_JOB_CLOSE；仍须查询可能尚在退出的同名内核 Job。
    unsafe {
        let name = crate::process::job_name(&journal.generation)?;
        let raw = OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, 0, name.as_ptr());
        if raw.is_null() {
            if GetLastError() != ERROR_FILE_NOT_FOUND { return Err(io::Error::last_os_error().into()); }
        } else { crate::process::terminate_job(&own(raw)?)?; }
    }
    if let Some(process) = &journal.process {
        let pid = process.get("pid").and_then(Value::as_u64).and_then(|value| u32::try_from(value).ok()).ok_or("恢复进程身份无效")?;
        unsafe {
            let raw = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid);
            if raw.is_null() {
                if GetLastError() != ERROR_INVALID_PARAMETER { return Err(io::Error::last_os_error().into()); }
            } else {
                let handle = own(raw)?;
                let identity = crate::process::identity_from_handle(pid, &handle)?;
                if identity["creationTime"] == process["creationTime"] && WaitForSingleObject(handle.as_raw_handle(), 30_000) != WAIT_OBJECT_0 { return Err("原受限进程仍在退出，尚未撤销目录权限".into()); }
            }
        }
    }
    let sid = derive_sid(&journal.generation)?;
    let result = (|| {
        if journal.broker_registered {
            let result = crate::broker::request(path.parent().ok_or("恢复目录无效")?, "recover", &json!({"generation":journal.generation}))?;
            if result["recovered"] != true { return Err("卷授权恢复未确认，日志已保留".into()); }
        }
        let name = wide(profile_name(&journal.generation)?)?;
        let status = unsafe { DeleteAppContainerProfile(name.as_ptr()) };
        if status < 0 && status as u32 != 0x80070002 { return Err(io::Error::from_raw_os_error(status).into()); }
        if path.with_extension("objects").exists() { fs::remove_file(path.with_extension("objects"))?; }
        fs::remove_file(path)?;
        if path.with_extension("pending").exists() { fs::remove_file(path.with_extension("pending"))?; }
        Ok(())
    })();
    unsafe { FreeSid(sid); }
    result
}
/// 恢复仅处理已确认不再存活的任务；活跃任务保留各自独立授权。
fn recover(home: &Path, reject_active: bool) -> Result<usize, Box<dyn std::error::Error>> {
    let mut live = 0;
    for path in journals(home)? {
        let journal = read_journal(&path)?;
        if active(&journal.generation)? { live += 1; if reject_active { return Err("仍有受限任务运行，不能清理隔离环境".into()); } }
        else { revoke(&path, &journal)?; }
    }
    Ok(live)
}
/// 返回 UI 需要的真实状态，不把日志存在当作成功初始化。
fn state(home: &Path) -> Result<Value, Box<dyn std::error::Error>> {
    let mut live = 0;
    let mut pending = false;
    for path in journals(home)? { let journal = read_journal(&path)?; if active(&journal.generation)? { live += 1; } else { pending = true; } }
    let service = crate::broker::request(home, "status", &json!({}));
    let available = service.as_ref().is_ok_and(|value| value["configured"] == true);
    if let Ok(service) = &service { pending |= service["pendingRecovery"] == true; }
    let marker = home.join("configured.json").is_file();
    pending |= marker && !available;
    let mut result = crate::broker::description(home)?;
    result.as_object_mut().ok_or("系统服务说明格式无效")?.extend(json!({"configured":marker && available,"backend":"windows-lpac","network":"blocked","activeSessions":live,"recoveryPending":pending,"detail":if pending {"检测到未完成或尚未确认的目录授权恢复，请核对系统服务状态。"} else if !available {"系统日志服务尚未配置；初始化会请求 UAC 并安装固定 LocalSystem 服务。"} else {"受限命令使用独立 LPAC 身份；可写本次 scratch 与 AppContainer 私有临时存储，网络关闭。"}}).as_object().unwrap().clone());
    Ok(result)
}
/// 配置状态查询不创建目录，也不触发权限修改。
pub fn status(request: &Value) -> Result<Value, Box<dyn std::error::Error>> { state(&home(request)?) }
/// 用户确认后初始化；只有 profile 创建和删除均成功才落配置标记。
pub fn initialize(request: &Value) -> Result<Value, Box<dyn std::error::Error>> {
    let root = home(request)?;
    // UAC 由固定安装入口显示，普通命令不会持续提权；取消时不写初始化标记。
    ensure_home(&root)?;
    crate::broker::ensure_installed(&root)?;
    recover(&root, false)?;
    let generation = request.get("generation").and_then(Value::as_str).filter(|value| valid_generation(value)).ok_or("初始化身份无效")?;
    let (_, information) = open_path(&root, true)?;
    let probe = root.join(format!("{generation}.json"));
    write_private_json(&probe, &Journal { generation: generation.into(), roots: vec![granted_root(root.clone(), &information)], process: None, broker_registered: false })?;
    let name = wide(profile_name(generation)?)?;
    unsafe {
        let mut sid = null_mut();
        let created = CreateAppContainerProfile(name.as_ptr(), name.as_ptr(), name.as_ptr(), null(), 0, &mut sid);
        if created < 0 { return Err(io::Error::from_raw_os_error(created).into()); }
        FreeSid(sid);
        let deleted = DeleteAppContainerProfile(name.as_ptr());
        if deleted < 0 { return Err(io::Error::from_raw_os_error(deleted).into()); }
    }
    fs::remove_file(probe)?;
    let marker = root.join("configured.json");
    if !marker.exists() { write_private_json(&marker, &json!({"backend":"windows-lpac","userSid":current_user_sid()?}))?; }
    state(&root)
}
/// 显式清理拒绝活跃任务，恢复旧授权后删除初始化标记。
pub fn cleanup(request: &Value) -> Result<Value, Box<dyn std::error::Error>> {
    let root = home(request)?;
    for path in journals(&root)? { if active(&read_journal(&path)?.generation)? { return Err("仍有受限任务运行，不能清理隔离环境".into()); } }
    recover(&root, true)?;
    crate::broker::uninstall(&root)?;
    if root.join("configured.json").exists() { fs::remove_file(root.join("configured.json"))?; }
    state(&root)
}
/// 此对象覆盖从 ACL 授权到进程树退出后的撤权；子进程持有它时不能卸载隔离配置。
pub struct PreparedSandbox {
    /// 每个任务唯一的安全能力结构，明确不授予任何网络能力。
    security: SECURITY_CAPABILITIES,
    /// LPAC 排除普通 AppContainer 的广泛默认 ACL。
    opt_out: u32,
    /// 完整恢复日志在任何目录授权前持久化。
    journal_path: PathBuf,
    /// 只含冻结根的恢复信息。
    journal: Journal,
    /// 根目录句柄防止运行期间根路径被改名替换。
    _roots: Vec<OwnedHandle>,
    /// 不确定进程树已结束时只留恢复日志，不撤销仍可能被持有的授权。
    cleanup_enabled: bool,
}
impl PreparedSandbox {
    /// 仅在已经证明整个 Job 退出后调用；失败保留日志供恢复处理。
    pub fn cleanup(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        self.cleanup_enabled = false;
        revoke(&self.journal_path, &self.journal)
    }
    /// 终止结果未知时保留全部恢复证据。
    pub fn retain_for_recovery(&mut self) { self.cleanup_enabled = false; }
    /// 创建进程后、恢复主线程前将不可复用出生身份原子持久化。
    pub fn record_process(&self, pid: u32, handle: &OwnedHandle) -> Result<(), Box<dyn std::error::Error>> {
        let journal = Journal { generation: self.journal.generation.clone(), roots: self.journal.roots.clone(), process: Some(crate::process::identity_from_handle(pid, handle)?), broker_registered: self.journal.broker_registered };
        replace_private_json(&self.journal_path, &journal)?;
        Ok(())
    }
    /// 属性存储由本对象持有，直到挂起子进程创建完成才可释放。
    pub unsafe fn apply_attributes(&self, attributes: LPPROC_THREAD_ATTRIBUTE_LIST) -> Result<(), Box<dyn std::error::Error>> {
        if UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize, (&self.security as *const SECURITY_CAPABILITIES).cast(), size_of::<SECURITY_CAPABILITIES>(), null_mut(), null_mut()) == 0 || UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY as usize, (&self.opt_out as *const u32).cast(), size_of::<u32>(), null_mut(), null_mut()) == 0 { return Err(io::Error::last_os_error().into()); }
        Ok(())
    }
}
impl Drop for PreparedSandbox {
    /// 撤权失败保留日志和未配置状态，由下一次明确操作恢复，不输出伪成功。
    fn drop(&mut self) {
        let result = if self.cleanup_enabled { revoke(&self.journal_path, &self.journal) } else { Ok(()) };
        if result.is_err() { eprintln!("Zeus Windows 隔离目录授权尚未完全清理；恢复日志已保留。"); }
        unsafe { FreeSid(self.security.AppContainerSid); }
    }
}
/// 完整预检后创建独立 LPAC 身份，所有授权成功后才允许创建业务进程。
pub fn prepare(policy: &SandboxPolicy, generation: &str, cwd: &Path) -> Result<PreparedSandbox, Box<dyn std::error::Error>> {
    if !valid_generation(generation) || policy.network != "blocked" || !matches!(policy.mode.as_str(), "read-only" | "workspace-write") { return Err("受限执行策略无效".into()); }
    let root = home(&json!({}))?;
    if !root.join("configured.json").is_file() { return Err("Windows 受限执行尚未初始化，命令未启动".into()); }
    ensure_home(&root)?;
    recover(&root, false)?;
    let mut readable = policy.readable_roots.clone();
    readable.extend(policy.writable_roots.iter().cloned());
    readable.sort(); readable.dedup();
    if readable.is_empty() || !readable.iter().any(|path| cwd.starts_with(path)) || !policy.writable_roots.iter().any(|path| policy.scratch_directory.starts_with(path)) { return Err("受限执行工作目录或临时目录未获授权".into()); }
    if policy.mode == "read-only" && policy.writable_roots.iter().any(|path| path != &policy.scratch_directory) { return Err("只读执行只能写入独占临时目录".into()); }
    let mut roots = Vec::new();
    let mut journal_roots = Vec::new();
    let mut excluded = policy.excluded_roots.clone();
    // 私有树必须真实存在；否则祖先目录的未来继承可能使新凭据意外可读。
    for path in &excluded {
        validate_local_path(path)?;
        let (handle, information) = open_path(path, true)?;
        if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 { return Err("宿主私有边界不是普通目录，命令未启动".into()); }
        roots.push(handle);
    }
    for path in &readable {
        if policy.excluded_roots.iter().any(|private| within(path, private)) && policy.denied_roots.iter().any(|denied| within(denied, path)) { return Err("受限命令不能将宿主凭据的祖先目录作为授权根".into()); }
    }
    excluded.extend(policy.denied_roots.iter().cloned());
    for path in &readable {
        validate_local_path(path)?;
        let (handle, info) = open_path(path, true)?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 { return Err("冻结授权根不是普通目录".into()); }
        journal_roots.push(granted_root(path.clone(), &info));
        roots.push(handle);
    }
    for path in &policy.denied_roots {
        validate_local_path(path)?;
        // 私有排除树从未获得本 SID，未来创建的禁止文件同样不会继承授权。
        if !path.exists() && policy.excluded_roots.iter().any(|private| within(path, private)) { continue; }
        let (handle, info) = open_path(path, true)?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 { return Err("禁止路径不能是重解析点".into()); }
        journal_roots.push(granted_root(path.clone(), &info));
        roots.push(handle);
    }
    // 宿主恢复目录永远不可授权，即使用户工作区包含其祖先目录。
    let internal_root = fs::canonicalize(&root)?;
    let (internal_handle, internal_info) = open_path(&internal_root, true)?;
    journal_roots.push(granted_root(internal_root.clone(), &internal_info));
    roots.push(internal_handle);
    let mut journal = Journal { generation: generation.into(), roots: journal_roots, process: None, broker_registered: false };
    let journal_path = root.join(format!("{generation}.json"));
    write_private_json(&journal_path, &journal)?;
    let registered = crate::broker::request(&root, "register", &json!({"generation":generation,"roots":journal.roots.iter().map(|root| &root.path).collect::<Vec<_>>()}))?;
    if registered["registered"] != true { return Err("卷变更追踪尚未登记，命令未启动".into()); }
    journal.broker_registered = true;
    replace_private_json(&journal_path, &journal)?;
    let name = wide(profile_name(generation)?)?;
    let mut sid = null_mut();
    let created = unsafe { CreateAppContainerProfile(name.as_ptr(), name.as_ptr(), name.as_ptr(), null(), 0, &mut sid) };
    if created < 0 { return Err(io::Error::from_raw_os_error(created).into()); }
    write_private_json(&journal_path.with_extension("objects"), &json!(null))?;
    let mut ledger = OpenOptions::new().write(true).truncate(true).open(journal_path.with_extension("objects"))?;
    ledger.sync_all()?;
    let prepared = PreparedSandbox { security: SECURITY_CAPABILITIES { AppContainerSid: sid, Capabilities: null_mut(), CapabilityCount: 0, Reserved: 0 }, opt_out: ALL_APPLICATION_PACKAGES_OPT_OUT, journal_path, journal, _roots: roots, cleanup_enabled: true };
    // 服务登记和恢复在锁外；仅实际 ACL 修改持锁，错误清理也必须先释放此锁。
    let grants = (|| -> Result<(), Box<dyn std::error::Error>> {
        let _lock = AclLock::acquire()?;
    // 读授权先建立，写授权后覆盖本会话自己的 ACE；重叠根不覆盖其他会话 SID。
    for path in &readable { visit(path, sid, Some(false), 0, false, Some(&mut ledger), &excluded)?; }
    for path in &policy.writable_roots { visit(path, sid, Some(true), 0, false, Some(&mut ledger), &excluded)?; }
    for path in &policy.denied_roots { if path.exists() { visit(path, sid, Some(false), 0, true, Some(&mut ledger), &[])?; } }
    visit(&internal_root, sid, Some(false), 0, true, Some(&mut ledger), &[])?;
        Ok(())
    })();
    grants?;
    Ok(prepared)
}
