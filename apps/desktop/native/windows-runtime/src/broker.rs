//! 固定系统服务只为本用户、本数据根登记卷日志和撤回唯一包 SID，不接受任意命令或文件读写。
use crate::process::{current_user_sid, own, wide};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs::{self, File, OpenOptions}, io::{self, Read, Write}, mem::{size_of, zeroed}, os::windows::{ffi::OsStringExt, fs::OpenOptionsExt, io::{AsRawHandle, OwnedHandle}}, path::{Path, PathBuf}, ptr::{null, null_mut}, sync::{Mutex, OnceLock, atomic::{AtomicBool, AtomicPtr, Ordering}}, thread, time::{Duration, Instant}};
use windows_sys::{core::GUID, Win32::{Foundation::*, Security::{*, Authorization::*, Cryptography::*}, Storage::FileSystem::*, System::{Com::CoTaskMemFree, Pipes::*, Services::*, SystemServices::ACCESS_ALLOWED_ACE_TYPE, Threading::*}, UI::{Shell::*, WindowsAndMessaging::SW_HIDE}}};

/// 所有普通错误都交给调用者保留未配置或待恢复状态。
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
/// 固定控制消息上限，卷登记不能夹带文件内容。
const MESSAGE_LIMIT: usize = 64 * 1024;
/// 服务实例在 SCM 启动前冻结，不从客户端覆盖。
static INSTANCE: OnceLock<Instance> = OnceLock::new();
/// 服务控制与请求共用锁，避免检查空闲后又接受新登记。
static REQUEST_GATE: Mutex<()> = Mutex::new(());
/// 停止只阻止新请求，当前撤权完成后再报告停止。
static STOPPING: AtomicBool = AtomicBool::new(false);
/// SCM 状态句柄只在当前服务进程中使用。
static STATUS_HANDLE: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(null_mut());

/// 稳定实例身份不包含版本或 helper 安装路径，升级不会改变授权边界。
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Instance {
    /// 真实普通用户 SID，服务从客户端 token 再次验证。
    user: String,
    /// 已规范化的数据根内 sandboxHome，只用来计算身份，不由 SYSTEM 读取其内容。
    home: String,
    /// 目录卷序列号与 file ID 避免大小写和 Unicode 折叠导致不同根共用服务。
    root_identity: String,
    /// SHA-256 固定派生值用于服务名、管道和受保护目录。
    id: String,
}

/// 使用操作系统 SHA-256，避免增加独立密码库。
fn digest(bytes: &[u8]) -> Result<String> {
    unsafe {
        let mut algorithm = null_mut();
        if BCryptOpenAlgorithmProvider(&mut algorithm, BCRYPT_SHA256_ALGORITHM, null(), 0) < 0 { return Err("无法打开系统摘要算法".into()); }
        let mut output = [0u8; 32];
        let status = BCryptHash(algorithm, null(), 0, bytes.as_ptr(), u32::try_from(bytes.len())?, output.as_mut_ptr(), 32);
        BCryptCloseAlgorithmProvider(algorithm, 0);
        if status < 0 { return Err("系统摘要计算失败".into()); }
        Ok(hex(&output))
    }
}
/// 参数使用纯十六进制，UAC 命令行不解释路径引号或控制字符。
fn hex(bytes: &[u8]) -> String { bytes.iter().map(|byte| format!("{byte:02x}")).collect() }
/// 只解码有限、完整的十六进制实例描述。
fn unhex(value: &str) -> Result<Vec<u8>> {
    if value.len() > MESSAGE_LIMIT || value.len() % 2 != 0 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err("服务实例编码无效".into()); }
    (0..value.len()).step_by(2).map(|index| u8::from_str_radix(&value[index..index + 2], 16).map_err(Into::into)).collect()
}
/// UTF-16 系统字符串按真实终止位置读取。
unsafe fn text(pointer: *const u16) -> String {
    let mut length = 0;
    while *pointer.add(length) != 0 { length += 1; }
    String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length))
}
/// 系统目录来自 Known Folder，不能由进程环境变量改变特权目标。
fn known_folder(id: &GUID) -> Result<PathBuf> {
    unsafe {
        let mut path = null_mut();
        if SHGetKnownFolderPath(id, 0, null_mut(), &mut path) < 0 { return Err("无法定位系统服务目录".into()); }
        let result = PathBuf::from(text(path));
        CoTaskMemFree(path.cast());
        Ok(result)
    }
}
impl Instance {
    /// 普通 helper 以自身用户和真实 home 计算稳定身份。
    fn for_home(home: &Path) -> Result<Self> {
        let canonical = fs::canonicalize(home)?;
        let mut home = canonical.to_string_lossy().to_string();
        if let Some(value) = home.strip_prefix(r"\\?\") { home = value.to_owned(); }
        if home.starts_with(r"\\") || !Path::new(&home).is_absolute() { return Err("服务数据根必须位于本机卷".into()); }
        let user = current_user_sid()?;
        let root_identity = directory_identity(Path::new(&home))?;
        let id = digest(format!("{user}\0{root_identity}").as_bytes())?;
        Ok(Self { user, home, root_identity, id })
    }
    /// UAC 参数不能指定任意服务名、系统路径或 SID 派生值。
    fn decode(value: &str) -> Result<Self> {
        let instance: Self = serde_json::from_slice(&unhex(value)?)?;
        if instance.id != digest(format!("{}\0{}", instance.user, instance.root_identity).as_bytes())? || !instance.user.starts_with("S-1-") || !instance.user.bytes().all(|byte| byte.is_ascii_digit() || matches!(byte, b'S' | b'-')) || instance.home.starts_with(r"\\") || !Path::new(&instance.home).is_absolute() || instance.root_identity != directory_identity(Path::new(&instance.home))? { return Err("服务实例身份无效".into()); }
        Ok(instance)
    }
    /// 固定前缀和摘要不会出现命令行或 SCM 名称注入。
    fn service(&self) -> String { format!("ZeusRuntimeBroker.{}", self.id) }
    /// 管道以实例身份隔离，不允许其他数据根串用登记。
    fn pipe(&self) -> Result<Vec<u16>> { wide(format!(r"\\.\pipe\Zeus.RuntimeBroker.{}", self.id)) }
    /// 二进制目录只允许系统和管理员写，注册用户只读执行。
    fn binary_directory(&self) -> Result<PathBuf> { Ok(known_folder(&FOLDERID_ProgramFiles)?.join("ZeusRuntimeBroker").join(&self.id)) }
    /// 服务端日志和配置不向普通用户开放。
    fn data_directory(&self) -> Result<PathBuf> { Ok(known_folder(&FOLDERID_ProgramData)?.join("ZeusRuntimeBroker").join(&self.id)) }
    /// 服务只运行自己的固定组件，不允许请求提供可执行文件。
    fn executable(&self) -> Result<PathBuf> { Ok(self.binary_directory()?.join("ZeusWindowsRuntime.exe")) }
    /// SCM 命令行只包含受保护的固定路径和纯十六进制摘要。
    fn command(&self) -> Result<String> { Ok(format!("\"{}\" broker-service {}", self.executable()?.display(), self.id)) }
}

/// 固定目录的内核身份只读取元数据，不读取数据根中的文件内容。
fn directory_identity(path: &Path) -> Result<String> {
    unsafe {
        let handle = own(CreateFileW(wide(path)?.as_ptr(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, null(), OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()))?;
        let mut info = zeroed();
        if GetFileInformationByHandle(handle.as_raw_handle(), &mut info) == 0 { return Err(io::Error::last_os_error().into()); }
        if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 { return Err("服务数据根必须是固定普通目录".into()); }
        Ok(format!("{:08x}.{:08x}{:08x}", info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow))
    }
}

/// SCM 句柄必须使用专属关闭 API。
struct ServiceHandle(SC_HANDLE);
impl Drop for ServiceHandle { /// 所有错误路径均释放 SCM 句柄。
    fn drop(&mut self) { unsafe { CloseServiceHandle(self.0); } }
}
/// 接管成功打开的 SCM 句柄。
fn service_handle(handle: SC_HANDLE) -> Result<ServiceHandle> {
    if handle.is_null() { Err(io::Error::last_os_error().into()) } else { Ok(ServiceHandle(handle)) }
}
/// 普通调用只请求查询和启动权限，不请求配置或停止服务的权限。
fn open_service(instance: &Instance, access: u32) -> Result<ServiceHandle> {
    unsafe {
        let manager = service_handle(OpenSCManagerW(null(), null(), SC_MANAGER_CONNECT))?;
        service_handle(OpenServiceW(manager.0, wide(instance.service())?.as_ptr(), access))
    }
}
/// 核对 SCM 配置，不能把同名的另一个 SYSTEM 程序当成本服务。
fn verify_service(instance: &Instance, service: &ServiceHandle) -> Result<()> {
    unsafe {
        let mut required = 0;
        QueryServiceConfigW(service.0, null_mut(), 0, &mut required);
        if required == 0 || required > MESSAGE_LIMIT as u32 { return Err("系统服务配置无效".into()); }
        let mut bytes = vec![0usize; (required as usize + size_of::<usize>() - 1) / size_of::<usize>()];
        let config = bytes.as_mut_ptr().cast::<QUERY_SERVICE_CONFIGW>();
        if QueryServiceConfigW(service.0, config, required, &mut required) == 0 { return Err(io::Error::last_os_error().into()); }
        if text((*config).lpBinaryPathName) != instance.command()? || !text((*config).lpServiceStartName).eq_ignore_ascii_case("LocalSystem") || (*config).dwServiceType != SERVICE_WIN32_OWN_PROCESS { return Err("已安装服务的固定身份不符".into()); }
    }
    Ok(())
}
/// SCM 给出本次真实服务 PID，供命名管道双向身份校验。
fn service_status(service: &ServiceHandle) -> Result<SERVICE_STATUS_PROCESS> {
    unsafe {
        let mut status = zeroed();
        let mut required = 0;
        if QueryServiceStatusEx(service.0, SC_STATUS_PROCESS_INFO, &mut status as *mut _ as *mut u8, size_of::<SERVICE_STATUS_PROCESS>() as u32, &mut required) == 0 { return Err(io::Error::last_os_error().into()); }
        Ok(status)
    }
}
/// 持有禁止写入和删除的文件句柄，校验与复制不重新按可替换路径打开。
fn locked_file(path: &Path) -> Result<File> {
    let file = OpenOptions::new().read(true).share_mode(FILE_SHARE_READ).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(path)?;
    let mut information = unsafe { zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 { return Err(io::Error::last_os_error().into()); }
    if information.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != 0 || information.nNumberOfLinks != 1 { return Err("服务二进制不是独立普通文件".into()); }
    Ok(file)
}
/// helper 产物大小有界；只读取自身代码，服务协议不能选取其他文件。
fn file_digest(file: &File) -> Result<String> {
    use std::io::{Seek, SeekFrom};
    let mut handle = file.try_clone()?;
    handle.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    handle.take(64 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 64 * 1024 * 1024 { return Err("原生服务组件大小无效".into()); }
    digest(&bytes)
}
/// 仅当前同一套 helper 可使用本服务，升级不静默替换运行中的代码。
fn verify_current_binary(instance: &Instance) -> Result<()> {
    if file_digest(&locked_file(&std::env::current_exe()?)?)? != file_digest(&locked_file(&instance.executable()?)?)? { return Err("系统服务版本不匹配，请从安全执行环境设置明确升级".into()); }
    Ok(())
}
/// 当前实例对应的 SYSTEM 私有 USN 状态目录。
pub fn state_directory() -> Result<PathBuf> { Ok(INSTANCE.get().ok_or("服务实例尚未初始化")?.data_directory()?.join("usn")) }

/// 设置界面在安装前即可展示准确的服务名与系统目标路径。
pub fn description(home: &Path) -> Result<Value> {
    // 首次打开设置时私有目录尚未创建；状态查询不写目录，也不伪造文件身份。
    if !home.exists() { return Ok(json!({"serviceName":null,"serviceBinaryPath":null,"serviceDataPath":null})); }
    let instance = Instance::for_home(home)?;
    Ok(json!({"serviceName":instance.service(),"serviceBinaryPath":instance.executable()?,"serviceDataPath":instance.data_directory()?}))
}

/// 安全描述符内存由 Windows 分配和释放。
struct Descriptor(PSECURITY_DESCRIPTOR);
impl Drop for Descriptor { /// 释放操作系统描述符。
    fn drop(&mut self) { unsafe { LocalFree(self.0); } }
}
/// 固定 SDDL 不接纳请求指定的 ACL。
fn descriptor(sddl: &str) -> Result<Descriptor> {
    unsafe {
        let mut value = null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(sddl)?.as_ptr(), SDDL_REVISION_1, &mut value, null_mut()) == 0 { return Err(io::Error::last_os_error().into()); }
        Ok(Descriptor(value))
    }
}
/// 创建系统受保护目录；预先占用或 reparse 目录不能被默默接管。
fn secure_directory(path: &Path, readable_user: Option<&str>) -> Result<()> {
    let read = readable_user.map(|sid| format!("(A;OICI;GRGX;;;{sid})")).unwrap_or_default();
    let security = descriptor(&format!("O:SYG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA){read}"))?;
    unsafe {
        let attributes = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: security.0, bInheritHandle: 0 };
        let name = wide(path)?;
        if CreateDirectoryW(name.as_ptr(), &attributes) == 0 && GetLastError() != ERROR_ALREADY_EXISTS { return Err(io::Error::last_os_error().into()); }
        let handle = own(CreateFileW(name.as_ptr(), READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE, null(), OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()))?;
        let mut info = zeroed();
        if GetFileInformationByHandle(handle.as_raw_handle(), &mut info) == 0 || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 { return Err("系统服务目录不是固定普通目录".into()); }
        let mut owner = null_mut(); let mut dacl = null_mut(); let mut actual = null_mut();
        let status = GetSecurityInfo(handle.as_raw_handle(), SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &mut owner, null_mut(), &mut dacl, null_mut(), &mut actual);
        if status != ERROR_SUCCESS { return Err(io::Error::from_raw_os_error(status as i32).into()); }
        let actual = Descriptor(actual);
        let owner = sid_string(owner)?;
        if !matches!(owner.as_str(), "S-1-5-18" | "S-1-5-32-544") || dacl.is_null() { return Err("系统服务目录已被非系统主体占用".into()); }
        for index in 0..(*dacl).AceCount as u32 {
            let mut ace = null_mut();
            if GetAce(dacl, index, &mut ace) == 0 { return Err(io::Error::last_os_error().into()); }
            let header = &*(ace as *const ACE_HEADER);
            if header.AceType != ACCESS_ALLOWED_ACE_TYPE as u8 { continue; }
            let allowed = &*(ace as *const ACCESS_ALLOWED_ACE);
            let sid = sid_string((&allowed.SidStart as *const u32).cast_mut().cast())?;
            if !matches!(sid.as_str(), "S-1-5-18" | "S-1-5-32-544") && (Some(sid.as_str()) != readable_user || allowed.Mask & !(FILE_GENERIC_READ | FILE_GENERIC_EXECUTE) != 0) { return Err("系统服务目录存在宽权限".into()); }
        }
        drop(actual);
    }
    Ok(())
}
/// 已验证的内核 SID 转字符串，不采用客户端声明。
unsafe fn sid_string(sid: PSID) -> Result<String> {
    let mut pointer = null_mut();
    if ConvertSidToStringSidW(sid, &mut pointer) == 0 { return Err(io::Error::last_os_error().into()); }
    let value = text(pointer); LocalFree(pointer.cast()); Ok(value)
}
/// 系统日志枚举和 ACL 恢复需要明确启用备份/恢复特权，不使用任意进程入口。
fn enable_privileges() -> Result<()> {
    unsafe {
        let mut token = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES, &mut token) == 0 { return Err(io::Error::last_os_error().into()); }
        let token = own(token)?;
        for name in ["SeBackupPrivilege", "SeRestorePrivilege"] {
            let mut luid = zeroed();
            if LookupPrivilegeValueW(null(), wide(name)?.as_ptr(), &mut luid) == 0 { return Err(io::Error::last_os_error().into()); }
            let privileges = TOKEN_PRIVILEGES { PrivilegeCount: 1, Privileges: [LUID_AND_ATTRIBUTES { Luid: luid, Attributes: SE_PRIVILEGE_ENABLED }] };
            SetLastError(ERROR_SUCCESS);
            if AdjustTokenPrivileges(token.as_raw_handle(), 0, &privileges, 0, null_mut(), null_mut()) == 0 || GetLastError() != ERROR_SUCCESS { return Err(io::Error::last_os_error().into()); }
        }
    }
    Ok(())
}

/// 启动已核实的系统服务，允许查询但不自动安装或升级。
fn ready(instance: &Instance, allow_start: bool) -> Result<ServiceHandle> {
    let service = open_service(instance, SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS | if allow_start { SERVICE_START } else { 0 })?;
    verify_service(instance, &service)?;
    verify_current_binary(instance)?;
    // 状态查询不启动服务，也不等待其他操作的启动结果。
    if !allow_start && service_status(&service)?.dwCurrentState != SERVICE_RUNNING { return Err("系统服务尚未运行".into()); }
    if service_status(&service)?.dwCurrentState == SERVICE_STOPPED {
        if unsafe { StartServiceW(service.0, 0, null()) } == 0 && unsafe { GetLastError() } != ERROR_SERVICE_ALREADY_RUNNING { return Err(io::Error::last_os_error().into()); }
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    while service_status(&service)?.dwCurrentState != SERVICE_RUNNING {
        if Instant::now() >= deadline { return Err("系统服务启动结果未知，请重新查询状态".into()); }
        thread::sleep(Duration::from_millis(100));
    }
    Ok(service)
}
/// 仅设置入口可触发 UAC；取消或未知结果不写入已配置标志。
pub fn ensure_installed(home: &Path) -> Result<()> {
    let instance = Instance::for_home(home)?;
    if ready(&instance, true).is_ok() { return Ok(()); }
    elevate(&instance, "broker-install")?;
    ready(&instance, true)?;
    Ok(())
}
/// 只有系统明确报告 ERROR_CANCELLED 才标记用户取消，超时和其他失败不能混用。
pub fn is_cancelled(error: &(dyn std::error::Error + 'static)) -> bool {
    error.downcast_ref::<io::Error>().and_then(io::Error::raw_os_error) == Some(ERROR_CANCELLED as i32)
}
/// 固定系统变更入口以当前 helper 执行，不接收程序路径或任意参数。
fn elevate(instance: &Instance, action: &str) -> Result<()> {
    let executable = std::env::current_exe()?;
    let _source = locked_file(&executable)?;
    let file = wide(executable)?;
    let verb = wide("runas")?;
    let arguments = wide(format!("{action} {}", hex(&serde_json::to_vec(instance)?)))?;
    unsafe {
        let mut execution: SHELLEXECUTEINFOW = zeroed();
        execution.cbSize = size_of::<SHELLEXECUTEINFOW>() as u32;
        execution.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
        execution.lpVerb = verb.as_ptr(); execution.lpFile = file.as_ptr(); execution.lpParameters = arguments.as_ptr(); execution.nShow = SW_HIDE;
        if ShellExecuteExW(&mut execution) == 0 { return Err(io::Error::last_os_error().into()); }
        let process = own(execution.hProcess)?;
        if WaitForSingleObject(process.as_raw_handle(), 180_000) != WAIT_OBJECT_0 { return Err("系统服务安装或清理结果未知，请重新查询状态".into()); }
        let mut code = 0;
        if GetExitCodeProcess(process.as_raw_handle(), &mut code) == 0 || code != 0 { return Err("系统服务安装或清理未完成，保持未配置或待恢复状态".into()); }
    }
    Ok(())
}
/// 普通 helper 只可请求固定登记、撤权和状态操作。
pub fn request(home: &Path, action: &str, input: &Value) -> Result<Value> {
    if !matches!(action, "register" | "recover" | "recover-all" | "status") { return Err("未知系统日志操作".into()); }
    if !matches!(action, "register" | "recover" | "recover-all" | "status") { return Err("不支持的系统服务操作".into()); }
    let instance = Instance::for_home(home)?;
    let service = ready(&instance, action != "status")?;
    let encoded = serde_json::to_vec(&json!({"action":action,"instance":instance.id,"input":input}))?;
    if encoded.len() > MESSAGE_LIMIT { return Err("系统服务请求过大".into()); }
    let name = instance.pipe()?;
    let deadline = Instant::now() + Duration::from_secs(150);
    let pipe = loop {
        let handle = unsafe { CreateFileW(name.as_ptr(), GENERIC_READ | GENERIC_WRITE, 0, null(), OPEN_EXISTING, SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, null_mut()) };
        if handle != INVALID_HANDLE_VALUE { break unsafe { own(handle)? }; }
        if Instant::now() >= deadline { return Err("无法连接系统日志服务".into()); }
        thread::sleep(Duration::from_millis(50));
    };
    unsafe {
        let mut server = 0;
        if GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut server) == 0 || server == 0 || server != service_status(&service)?.dwProcessId { return Err("系统日志服务管道身份不符".into()); }
        let mut mode = PIPE_READMODE_MESSAGE | PIPE_NOWAIT;
        if SetNamedPipeHandleState(pipe.as_raw_handle(), &mut mode, null_mut(), null_mut()) == 0 { return Err(io::Error::last_os_error().into()); }
        let mut written = 0;
        if WriteFile(pipe.as_raw_handle(), encoded.as_ptr(), encoded.len() as u32, &mut written, null_mut()) == 0 || written as usize != encoded.len() { return Err("系统服务登记结果未知".into()); }
    }
    let reply = read_message(&pipe, deadline)?;
    let result: Value = serde_json::from_slice(&reply)?;
    if result.get("ok").and_then(Value::as_bool) != Some(true) { return Err("系统日志操作未完成，恢复记录已保留".into()); }
    Ok(result["result"].clone())
}
/// 有界消息读取；超时不能杀服务或把未知登记当成功。
fn read_message(pipe: &OwnedHandle, deadline: Instant) -> Result<Vec<u8>> {
    let mut bytes = vec![0u8; MESSAGE_LIMIT + 1];
    loop {
        let mut count = 0;
        let ok = unsafe { ReadFile(pipe.as_raw_handle(), bytes.as_mut_ptr(), bytes.len() as u32, &mut count, null_mut()) };
        if ok != 0 && count > 0 { bytes.truncate(count as usize); if bytes.len() > MESSAGE_LIMIT { return Err("系统服务消息过大".into()); } return Ok(bytes); }
        let error = unsafe { GetLastError() };
        if !matches!(error, ERROR_NO_DATA | ERROR_PIPE_LISTENING) || Instant::now() >= deadline { return Err(io::Error::from_raw_os_error(error as i32).into()); }
        thread::sleep(Duration::from_millis(20));
    }
}
/// 每次请求从真实管道 token 取身份，并拒绝所有 AppContainer 和 restricted token。
fn client_identity(pipe: &OwnedHandle, instance: &Instance) -> Result<(String, Value)> {
    unsafe {
        if ImpersonateNamedPipeClient(pipe.as_raw_handle()) == 0 { return Err(io::Error::last_os_error().into()); }
        let inspected = (|| -> Result<String> {
            let mut token = null_mut();
            if OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut token) == 0 { return Err(io::Error::last_os_error().into()); }
            let token = own(token)?;
            let mut container = 0u32; let mut size = 0;
            if GetTokenInformation(token.as_raw_handle(), TokenIsAppContainer, &mut container as *mut _ as *mut _, 4, &mut size) == 0 || container != 0 || IsTokenRestricted(token.as_raw_handle()) != 0 { return Err("受限进程不能调用系统日志服务".into()); }
            GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut size);
            let mut buffer = vec![0usize; (size as usize + size_of::<usize>() - 1) / size_of::<usize>()];
            if GetTokenInformation(token.as_raw_handle(), TokenUser, buffer.as_mut_ptr().cast(), size, &mut size) == 0 { return Err(io::Error::last_os_error().into()); }
            sid_string((*(buffer.as_ptr() as *const TOKEN_USER)).User.Sid)
        })();
        if RevertToSelf() == 0 { std::process::abort(); }
        let user = inspected?;
        if user != instance.user { return Err("系统日志服务不属于当前用户".into()); }
        let mut pid = 0;
        if GetNamedPipeClientProcessId(pipe.as_raw_handle(), &mut pid) == 0 { return Err(io::Error::last_os_error().into()); }
        let process = own(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid))?;
        let mut path = vec![0u16; 32768]; let mut length = path.len() as u32;
        if QueryFullProcessImageNameW(process.as_raw_handle(), 0, path.as_mut_ptr(), &mut length) == 0 || WaitForSingleObject(process.as_raw_handle(), 0) != WAIT_TIMEOUT { return Err("系统服务客户端已经改变".into()); }
        let path = PathBuf::from(std::ffi::OsString::from_wide(&path[..length as usize]));
        if file_digest(&locked_file(&path)?)? != file_digest(&locked_file(&instance.executable()?)?)? { return Err("只有当前固定 helper 可以调用系统日志服务".into()); }
        Ok((user, crate::process::identity_from_handle(pid, &process)?))
    }
}

/// 服务端序列执行固定元数据操作，错误只返回失败，不泄漏目录或安全描述符。
fn dispatch(pipe: &OwnedHandle, instance: &Instance, bytes: &[u8]) -> Result<Value> {
    let (user, caller) = client_identity(pipe, instance)?;
    let value: Value = serde_json::from_slice(bytes)?;
    if value["instance"].as_str() != Some(instance.id.as_str()) { return Err("系统服务数据根身份不符".into()); }
    let _gate = REQUEST_GATE.lock().map_err(|_| "服务请求锁失效")?;
    if STOPPING.load(Ordering::SeqCst) { return Err("系统服务正在停止".into()); }
    match value["action"].as_str() {
        Some("register") => crate::usn::register(&user, &value["input"], &caller),
        Some("recover") => crate::usn::recover(&user, &value["input"], Some(&caller)),
        Some("recover-all") => { crate::usn::recover_all()?; Ok(json!({"recovered":true})) },
        Some("status") => { let mut status = crate::usn::status()?; status["configured"] = Value::Bool(true); Ok(status) },
        _ => Err("未知系统日志操作".into()),
    }
}
/// 启动固定本地管道；显式拒绝 AppContainer，允许注册用户交换有界消息。
fn serve(instance: &Instance) -> Result<()> {
    let security = descriptor(&format!("D:P(D;;GA;;;AC)(D;;GA;;;S-1-15-2-2)(A;;GA;;;SY)(A;;GRGW;;;{})", instance.user))?;
    let attributes = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: security.0, bInheritHandle: 0 };
    let pipe = unsafe { own(CreateNamedPipeW(instance.pipe()?.as_ptr(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, MESSAGE_LIMIT as u32, MESSAGE_LIMIT as u32, 0, &attributes))? };
    report_status(SERVICE_RUNNING, ERROR_SUCCESS);
    loop {
        if STOPPING.load(Ordering::SeqCst) {
            let _gate = REQUEST_GATE.lock().map_err(|_| "服务请求锁失效")?;
            if crate::usn::recover_all().is_ok() && crate::usn::can_uninstall()? { break; }
            // 活动任务或日志缺口阻止停止；保留服务和证据，不能假报安全卸载。
            STOPPING.store(false, Ordering::SeqCst);
            report_status(SERVICE_RUNNING, ERROR_SUCCESS);
        }
        if unsafe { ConnectNamedPipe(pipe.as_raw_handle(), null_mut()) } == 0 && unsafe { GetLastError() } != ERROR_PIPE_CONNECTED { thread::sleep(Duration::from_millis(20)); continue; }
        let result = read_message(&pipe, Instant::now() + Duration::from_secs(5)).and_then(|bytes| dispatch(&pipe, instance, &bytes));
        let message = match result { Ok(value) => json!({"ok":true,"result":value}), Err(_) => json!({"ok":false}) };
        let encoded = serde_json::to_vec(&message)?;
        let mut written = 0;
        unsafe { WriteFile(pipe.as_raw_handle(), encoded.as_ptr(), encoded.len() as u32, &mut written, null_mut()); }
        // 等待客户端取走短响应，避免 Disconnect 丢弃尚未读取的消息；不让失联客户端永久阻塞。
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            let mut available = 0;
            if unsafe { PeekNamedPipe(pipe.as_raw_handle(), null_mut(), 0, null_mut(), &mut available, null_mut()) } == 0 { break; }
            thread::sleep(Duration::from_millis(20));
        }
        unsafe { DisconnectNamedPipe(pipe.as_raw_handle()); }
    }
    Ok(())
}
/// 服务停止控制与登记互斥；仍有待恢复记录时拒绝停止，避免升级丢失证据。
unsafe extern "system" fn service_control(control: u32, _: u32, _: *mut std::ffi::c_void, _: *mut std::ffi::c_void) -> u32 {
    if control == SERVICE_CONTROL_INTERROGATE { return ERROR_SUCCESS; }
    if control != SERVICE_CONTROL_STOP { return ERROR_CALL_NOT_IMPLEMENTED; }
    // 控制回调立即返回；主循环在当前请求完成后持锁恢复，避免长扫描阻塞 SCM 控制线程。
    STOPPING.store(true, Ordering::SeqCst);
    report_status(SERVICE_STOP_PENDING, ERROR_SUCCESS);
    ERROR_SUCCESS
}
/// 向 SCM 报告真实状态，启动失败不会被标记为可用。
fn report_status(state: u32, error: u32) {
    let mut status = SERVICE_STATUS { dwServiceType: SERVICE_WIN32_OWN_PROCESS, dwCurrentState: state, dwControlsAccepted: if state == SERVICE_RUNNING { SERVICE_ACCEPT_STOP } else { 0 }, dwWin32ExitCode: error, dwServiceSpecificExitCode: 0, dwCheckPoint: 0, dwWaitHint: if state == SERVICE_START_PENDING || state == SERVICE_STOP_PENDING { 20_000 } else { 0 } };
    unsafe { SetServiceStatus(STATUS_HANDLE.load(Ordering::SeqCst), &mut status); }
}
/// SCM 唯一服务入口，先启用固定特权，再打开日志服务。
unsafe extern "system" fn service_main(_: u32, _: *mut *mut u16) {
    let Some(instance) = INSTANCE.get() else { return; };
    let Ok(name) = wide(instance.service()) else { return; };
    let handle = RegisterServiceCtrlHandlerExW(name.as_ptr(), Some(service_control), null());
    if handle.is_null() { return; }
    STATUS_HANDLE.store(handle, Ordering::SeqCst);
    report_status(SERVICE_START_PENDING, ERROR_SUCCESS);
    let result = enable_privileges().and_then(|_| serve(instance));
    report_status(SERVICE_STOPPED, if result.is_ok() { ERROR_SUCCESS } else { ERROR_SERVICE_SPECIFIC_ERROR });
}

/// 只在固定已安装目录内写文件，并在原子发布前把内容刷新到介质。
fn publish(path: &Path, bytes: &[u8]) -> Result<()> {
    let temporary = path.with_extension("pending");
    if temporary.exists() { fs::remove_file(&temporary)?; }
    let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary)?;
    file.write_all(bytes)?; file.sync_all()?; drop(file);
    if unsafe { MoveFileExW(wide(&temporary)?.as_ptr(), wide(path)?.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) } == 0 { return Err(io::Error::last_os_error().into()); }
    Ok(())
}
/// 固定服务安装/升级只在 UAC 后运行；不接受其他可执行文件、命令或配置。
fn install(instance: &Instance) -> Result<()> {
    enable_privileges()?;
    let binary_parent = known_folder(&FOLDERID_ProgramFiles)?.join("ZeusRuntimeBroker");
    let data_parent = known_folder(&FOLDERID_ProgramData)?.join("ZeusRuntimeBroker");
    secure_directory(&binary_parent, Some("S-1-5-32-545"))?;
    secure_directory(&data_parent, None)?;
    secure_directory(&instance.binary_directory()?, Some(&instance.user))?;
    secure_directory(&instance.data_directory()?, None)?;
    secure_directory(&instance.data_directory()?.join("usn"), None)?;
    let existing = match open_service(instance, SERVICE_ALL_ACCESS) {
        Ok(service) => Some(service),
        Err(error) if error.downcast_ref::<io::Error>().and_then(io::Error::raw_os_error) == Some(ERROR_SERVICE_DOES_NOT_EXIST as i32) => None,
        Err(error) => return Err(error),
    };
    if let Some(service) = &existing {
        verify_service(instance, service)?;
        INSTANCE.set(instance.clone()).map_err(|_| "服务实例重复初始化")?;
        stop_for_change(service, instance)?;
        crate::usn::recover_all()?;
        if !crate::usn::can_uninstall()? { return Err("仍有活动或待恢复任务，不能升级系统服务".into()); }
    }
    // UAC 已运行当前 helper；只复制该进程自己的固定映像，源锁保持到目标摘要复核结束。
    let source = locked_file(&std::env::current_exe()?)?;
    let source_hash = file_digest(&source)?;
    let mut bytes = Vec::new(); let mut source_reader = source.try_clone()?;
    use std::io::{Seek, SeekFrom};
    source_reader.seek(SeekFrom::Start(0))?; source_reader.take(64 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 64 * 1024 * 1024 || digest(&bytes)? != source_hash { return Err("安装来源在复制期间发生变化".into()); }
    publish(&instance.executable()?, &bytes)?;
    if file_digest(&locked_file(&instance.executable()?)?)? != source_hash { return Err("已安装服务摘要不符".into()); }
    publish(&instance.data_directory()?.join("instance.json"), &serde_json::to_vec(instance)?)?;
    let service = if let Some(service) = existing { service } else {
        unsafe {
            let manager = service_handle(OpenSCManagerW(null(), null(), SC_MANAGER_CREATE_SERVICE))?;
            service_handle(CreateServiceW(manager.0, wide(instance.service())?.as_ptr(), wide(format!("Zeus runtime journal ({})", &instance.id[..12]))?.as_ptr(), SERVICE_ALL_ACCESS, SERVICE_WIN32_OWN_PROCESS, SERVICE_DEMAND_START, SERVICE_ERROR_NORMAL, wide(instance.command()?)?.as_ptr(), null(), null_mut(), null(), null(), null()))?
        }
    };
    unsafe {
        let acl = descriptor(&format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;CCLCRP;;;{})", instance.user))?;
        if SetServiceObjectSecurity(service.0, DACL_SECURITY_INFORMATION, acl.0) == 0 || ChangeServiceConfigW(service.0, SERVICE_NO_CHANGE, SERVICE_DEMAND_START, SERVICE_NO_CHANGE, null(), null(), null_mut(), null(), null(), null(), null()) == 0 { return Err(io::Error::last_os_error().into()); }
        if StartServiceW(service.0, 0, null()) == 0 && GetLastError() != ERROR_SERVICE_ALREADY_RUNNING { return Err(io::Error::last_os_error().into()); }
    }
    Ok(())
}
/// 修改前先禁止普通用户重新启动，再等待旧服务真实停止。
fn stop_for_change(service: &ServiceHandle, instance: &Instance) -> Result<()> {
    let result = (|| -> Result<()> {
    // SCM 的 stopped 回执早于进程句柄退出；先固定实际映像对应的进程句柄。
    let expected = instance.executable()?;
    let before = service_status(service)?;
    let process = if before.dwProcessId == 0 { None } else { unsafe {
        let raw = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, before.dwProcessId);
        if raw.is_null() {
            // 查询 SCM 状态前保存 OpenProcess 的错误，避免后续系统调用覆盖原始失败原因。
            let failure = io::Error::last_os_error();
            if failure.raw_os_error() != Some(ERROR_INVALID_PARAMETER as i32) || service_status(service)?.dwCurrentState != SERVICE_STOPPED { return Err(failure.into()); }
            None
        } else {
            let process = own(raw)?;
            let identity = crate::process::identity_from_handle(before.dwProcessId, &process)?;
            if !identity["imagePath"].as_str().is_some_and(|path| path.eq_ignore_ascii_case(&expected.to_string_lossy())) { return Err("系统服务进程映像不符，未修改服务".into()); }
            let current = service_status(service)?;
            if current.dwProcessId != before.dwProcessId && current.dwCurrentState != SERVICE_STOPPED { return Err("系统服务进程已变化，未替换代码".into()); }
            Some(process)
        }
    }};
    unsafe {
        if ChangeServiceConfigW(service.0, SERVICE_NO_CHANGE, SERVICE_DISABLED, SERVICE_NO_CHANGE, null(), null(), null_mut(), null(), null(), null(), null()) == 0 { return Err(io::Error::last_os_error().into()); }
        if service_status(service)?.dwCurrentState != SERVICE_STOPPED {
            let mut status = zeroed();
            if ControlService(service.0, SERVICE_CONTROL_STOP, &mut status) == 0 { return Err(io::Error::last_os_error().into()); }
        }
    }
    let deadline = Instant::now() + Duration::from_secs(150);
    while service_status(service)?.dwCurrentState != SERVICE_STOPPED {
        if service_status(service)?.dwCurrentState == SERVICE_RUNNING { return Err("仍有活动或待恢复任务，系统服务拒绝停止".into()); }
        if Instant::now() >= deadline { return Err("旧系统服务停止结果未知，未替换代码".into()); }
        thread::sleep(Duration::from_millis(100));
    }
    if let Some(process) = process {
        if unsafe { WaitForSingleObject(process.as_raw_handle(), 30_000) } != WAIT_OBJECT_0 { return Err("系统服务进程尚未退出，未替换或删除代码".into()); }
    }
    Ok(())
    })();
    if result.is_err() {
        // 失败保留旧服务可再次恢复；不让一次被拒绝的清理永久禁用服务。
        unsafe { ChangeServiceConfigW(service.0, SERVICE_NO_CHANGE, SERVICE_DEMAND_START, SERVICE_NO_CHANGE, null(), null(), null_mut(), null(), null(), null(), null()); }
    }
    result
}
/// 普通清理入口先恢复服务端孤儿登记，再明确请求系统授权卸载。
pub fn uninstall(home: &Path) -> Result<()> {
    let instance = Instance::for_home(home)?;
    request(home, "recover-all", &json!({}))?;
    elevate(&instance, "broker-uninstall")
}
/// 特权删除仅限固定实例且没有活跃/待恢复任务，绝不递归删除用户数据根。
fn remove(instance: &Instance) -> Result<()> {
    enable_privileges()?;
    INSTANCE.set(instance.clone()).map_err(|_| "服务实例重复初始化")?;
    let service = open_service(instance, SERVICE_ALL_ACCESS)?;
    verify_service(instance, &service)?;
    stop_for_change(&service, instance)?;
    crate::usn::recover_all()?;
    if !crate::usn::can_uninstall()? { return Err("仍有活动或待恢复任务，不能卸载系统服务".into()); }
    if unsafe { DeleteService(service.0) } == 0 { return Err(io::Error::last_os_error().into()); }
    drop(service);
    fs::remove_dir_all(instance.binary_directory()?)?;
    fs::remove_dir_all(instance.data_directory()?)?;
    Ok(())
}
/// 固定三个原生入口在读取普通 stdin 协议前处理。
pub fn entry(action: &str) -> Result<()> {
    let argument = std::env::args().nth(2).ok_or("缺少固定服务实例")?;
    if std::env::args().nth(3).is_some() { return Err("系统服务入口不接收额外参数".into()); }
    if action == "broker-service" {
        if argument.len() != 64 || !argument.bytes().all(|byte| byte.is_ascii_hexdigit()) || current_user_sid()? != "S-1-5-18" { return Err("系统服务启动身份无效".into()); }
        let path = known_folder(&FOLDERID_ProgramData)?.join("ZeusRuntimeBroker").join(&argument).join("instance.json");
        let mut bytes = Vec::new(); locked_file(&path)?.take(MESSAGE_LIMIT as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > MESSAGE_LIMIT { return Err("系统服务配置过大".into()); }
        let instance: Instance = serde_json::from_slice(&bytes)?;
        if instance.id != argument || instance.id != digest(format!("{}\0{}", instance.user, instance.root_identity).as_bytes())? { return Err("系统服务持久身份不符".into()); }
        verify_current_binary(&instance)?;
        let mut name = wide(instance.service())?;
        INSTANCE.set(instance).map_err(|_| "系统服务实例重复初始化")?;
        let table = [SERVICE_TABLE_ENTRYW { lpServiceName: name.as_mut_ptr(), lpServiceProc: Some(service_main) }, SERVICE_TABLE_ENTRYW { lpServiceName: null_mut(), lpServiceProc: None }];
        if unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) } == 0 { return Err(io::Error::last_os_error().into()); }
        return Ok(());
    }
    let instance = Instance::decode(&argument)?;
    match action { "broker-install" => install(&instance), "broker-uninstall" => remove(&instance), _ => Err("未知特权服务入口".into()) }
}
