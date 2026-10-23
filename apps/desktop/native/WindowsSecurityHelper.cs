using System.ComponentModel;
using System.Diagnostics;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace Zeus.Platform;

/// <summary>普通用户权限的 Windows 安全边界；秘密只经标准输入输出传输。</summary>
internal static class WindowsSecurityHelper
{
    // 请求和返回均有上限，避免原生桥无限分配内存。
    private const int MaximumRequestCharacters = 4 * 1024 * 1024;
    // 当前用户 SID 是文件 ACL 和 DPAPI 的共同归属边界。
    private static readonly SecurityIdentifier CurrentSid = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("缺少 Windows 用户 SID。");
    // 管理员启动的进程可以默认以此组拥有新对象；它不能单独证明当前用户归属。
    private const string AdministratorsSid = "S-1-5-32-544";
    // SYSTEM 和管理员拥有操作系统级权限；不把它们误述为可由应用隔离的主体。
    private static readonly HashSet<string> TrustedSids = new(StringComparer.Ordinal) { CurrentSid.Value, "S-1-5-18", AdministratorsSid };

    /// <summary>桌面桥先按明确入口分流，安全请求只处理一条 JSON。</summary>
    [STAThread]
    private static int Main(string[] args)
    {
        // 重定向管道固定 UTF-8，不依赖 Windows 控制台代码页。
        Console.InputEncoding = new UTF8Encoding(false, true);
        Console.OutputEncoding = new UTF8Encoding(false, true);
        if (WindowsDesktopBridge.TryRun(args, out int bridgeExitCode)) return bridgeExitCode;
        try
        {
            using JsonDocument request = JsonDocument.Parse(ReadRequest());
            JsonElement value = request.RootElement;
            string operation = RequiredString(value, "operation");
            object? result = operation switch
            {
                "ensure-private" => EnsurePrivate(value),
                "assert-private" => AssertPrivate(value),
                "assert-owned" => AssertOwned(value),
                "inspect-path" => new { canonicalPath = CanonicalPath(RequiredString(value, "path")) },
                "read-private" => new { bytes = Convert.ToBase64String(ReadPrivateFile(RequiredString(value, "path"), value.GetProperty("maximumBytes").GetInt32())) },
                "publish-file" => Publish(value),
                "move-entry" => MoveEntry(value),
                "secret-set" => SetSecret(value),
                "secret-get" => GetSecret(value),
                "secret-delete" => DeleteSecret(value),
                "offline-check" => CheckOffline(value),
                "verify-authenticode" => VerifyAuthenticode(RequiredString(value, "path")),
                "open-wechat-application" => WindowsDesktopBridge.OpenWechatApplication(value),
                "token-status" => ReadTokenStatus(),
                _ => throw new ArgumentException("未知 Windows 安全操作。"),
            };
            Console.WriteLine(JsonSerializer.Serialize(new { ok = true, result }));
            return 0;
        }
        catch (Exception error)
        {
            // 不输出请求、参数或异常堆栈，避免凭据流入日志。
            Console.WriteLine(JsonSerializer.Serialize(new { ok = false, error = new { code = ErrorCode(error), message = error.Message } }));
            return 1;
        }
    }

    /// <summary>保留既有 Node 文件错误语义，冲突和占用不能误报为成功。</summary>
    private static string ErrorCode(Exception error) => error switch
    {
        FileNotFoundException or DirectoryNotFoundException => "ENOENT",
        UnauthorizedAccessException => "EACCES",
        Win32Exception native => native.NativeErrorCode switch { 2 or 3 => "ENOENT", 80 or 183 => "EEXIST", 5 => "EACCES", 32 or 33 => "EBUSY", _ => $"WIN32_{native.NativeErrorCode}" },
        _ => "ZEUS_WINDOWS_SECURITY_FAILED",
    };

    /// <summary>有界读取单行请求，不接受尾随第二条命令。</summary>
    private static string ReadRequest()
    {
        StringBuilder builder = new();
        for (int character; (character = Console.In.Read()) >= 0 && character != '\n';)
        {
            if (builder.Length >= MaximumRequestCharacters) throw new ArgumentException("安全请求超出大小上限。");
            builder.Append((char)character);
        }
        if (builder.Length == 0) throw new ArgumentException("安全请求为空。");
        return builder.ToString();
    }

    /// <summary>读取不可为空的字符串字段。</summary>
    private static string RequiredString(JsonElement value, string name)
    {
        string? text = value.GetProperty(name).GetString();
        if (string.IsNullOrEmpty(text) || text.Contains('\0')) throw new ArgumentException($"字段 {name} 无效。");
        return text;
    }

    /// <summary>只接纳本机绝对文件路径，拒绝设备命名空间、ADS 和网络卷。</summary>
    internal static string CanonicalPath(string path)
    {
        if (!Path.IsPathFullyQualified(path) || path.StartsWith("\\\\", StringComparison.Ordinal) || path.AsSpan(2).Contains(':')) throw new ArgumentException("安全文件必须位于本机绝对路径，不能使用网络卷、设备路径或 ADS。");
        string canonical = Path.GetFullPath(path);
        // 盘符也可能映射到 SMB；只看 UNC 前缀无法证明文件在本机卷上。
        uint driveType = GetDriveType(Path.GetPathRoot(canonical)!);
        if (driveType != 2 && driveType != 3 && driveType != 6) throw new IOException("安全文件必须位于本机固定盘、移动盘或内存盘。");
        for (string? current = canonical; !string.IsNullOrEmpty(current); current = Path.GetDirectoryName(current))
        {
            if (!File.Exists(current) && !Directory.Exists(current)) continue;
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new IOException("安全路径不能经过符号链接、junction 或其他 reparse point。");
        }
        return canonical;
    }

    /// <summary>取得文件或目录的 ACL。</summary>
    private static FileSystemSecurity ReadSecurity(string path, bool directory) => directory
        ? new DirectoryInfo(path).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access)
        : new FileInfo(path).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access);

    /// <summary>验证用户归属；管理员组所有的对象还必须以私有 DACL 单独授予当前用户完全控制。</summary>
    internal static void AssertOwnedPath(string path, bool directory)
    {
        path = CanonicalPath(path);
        if (directory ? !Directory.Exists(path) : !File.Exists(path)) throw new FileNotFoundException("安全文件或目录不存在。");
        // 只扩大已证实的管理员组所有者场景；其他普通用户和 SYSTEM 所有者继续拒绝。
        FileSystemSecurity security = ReadSecurity(path, directory);
        // 所有者和个人授权来自同一份安全描述符，避免混合两次读取的归属信息。
        IdentityReference? owner = security.GetOwner(typeof(SecurityIdentifier));
        if (CurrentSid.Equals(owner)) return;
        if (owner?.Value != AdministratorsSid) throw new UnauthorizedAccessException("安全文件或目录不属于当前 Windows 用户。");
        AssertPrivateAccess(security, true);
    }

    /// <summary>校验 DACL，只允许当前用户和操作系统特权主体获得访问权限。</summary>
    internal static void AssertPrivatePath(string path, bool directory)
    {
        AssertOwnedPath(path, directory);
        AssertPrivateAccess(ReadSecurity(path, directory), false);
    }

    /// <summary>共用私有 ACL 校验；管理员组所有者另需完整的个人授权，不能仅靠组成员身份认领。</summary>
    private static void AssertPrivateAccess(FileSystemSecurity security, bool requireUserFullControl)
    {
        // 读取校验有效 ACL（包含继承规则）；创建时另行关闭继承，不改动只读验证源。
        // 个人授权必须直接写明当前用户 SID；允许从私有父目录继承，禁止拼接组权限。
        FileSystemRights requiredRights = requireUserFullControl ? FileSystemRights.FullControl : FileSystemRights.ReadData;
        // 任一适用于当前对象的个人授权必须单独覆盖全部所需权限。
        bool userHasRequiredAccess = false;
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            // 仅向子项继承的规则不授予当前对象访问权；子项在读取时单独校验。
            if ((rule.PropagationFlags & PropagationFlags.InheritOnly) != 0) continue;
            if (rule.AccessControlType != AccessControlType.Allow)
            {
                // 拒绝规则可能命中用户所属的组；不猜测组成员和 ACE 顺序产生的有效控制权。
                if (requireUserFullControl && rule.FileSystemRights != 0) throw new UnauthorizedAccessException("管理员组所有的安全文件或目录包含拒绝规则，无法确认当前用户的完全控制权限。");
                continue;
            }
            string sid = ((SecurityIdentifier)rule.IdentityReference).Value;
            if (!TrustedSids.Contains(sid) && rule.FileSystemRights != 0) throw new UnauthorizedAccessException("安全文件或目录向其他 Windows 用户开放。");
            if (sid == CurrentSid.Value && (rule.FileSystemRights & requiredRights) == requiredRights) userHasRequiredAccess = true;
        }
        if (!userHasRequiredAccess) throw new UnauthorizedAccessException(requireUserFullControl
            ? "管理员组所有的安全文件或目录未单独授予当前 Windows 用户完全控制权限。"
            : "当前 Windows 用户没有读取安全文件的权限。");
    }

    /// <summary>以当前用户独占 DACL 保护已有对象；不修改其他用户的归属。</summary>
    internal static void EnsurePrivatePath(string path, bool directory)
    {
        path = CanonicalPath(path);
        if (directory) Directory.CreateDirectory(path);
        AssertOwnedPath(path, directory);
        FileSystemSecurity security = directory ? new DirectorySecurity() : new FileSecurity();
        security.SetOwner(CurrentSid);
        security.SetAccessRuleProtection(true, false);
        InheritanceFlags inheritance = directory ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None;
        foreach (string sid in TrustedSids) security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
        if (directory) new DirectoryInfo(path).SetAccessControl((DirectorySecurity)security);
        else new FileInfo(path).SetAccessControl((FileSecurity)security);
        AssertPrivatePath(path, directory);
    }

    /// <summary>持有拒绝写入/删除的句柄读取，防止检查后替换目标。</summary>
    internal static byte[] ReadPrivateFile(string path, int maximumBytes)
    {
        if (maximumBytes <= 0 || maximumBytes > 4 * 1024 * 1024) throw new ArgumentException("读取上限无效。");
        path = CanonicalPath(path);
        using SafeFileHandle handle = CreateFile(path, 0x80000000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
        ThrowIfInvalid(handle);
        AssertHandleOrdinary(handle);
        AssertPrivatePath(path, false);
        using FileStream stream = new(handle, FileAccess.Read);
        if (stream.Length <= 0 || stream.Length > maximumBytes) throw new IOException("安全文件大小超出允许范围。");
        byte[] bytes = new byte[checked((int)stream.Length)];
        stream.ReadExactly(bytes);
        if (stream.ReadByte() != -1) throw new IOException("安全文件读取期间发生变化。");
        return bytes;
    }

    /// <summary>文件内容先刷新，再用 WRITE_THROUGH 原生移动完成不可覆盖或替换发布。</summary>
    internal static void PublishFile(string source, string target, bool replace)
    {
        source = CanonicalPath(source);
        target = CanonicalPath(target);
        if (!string.Equals(Path.GetPathRoot(source), Path.GetPathRoot(target), StringComparison.OrdinalIgnoreCase)) throw new IOException("安全发布必须在同一卷内完成。");
        FileAttributes attributes = File.GetAttributes(source);
        bool readOnly = (attributes & FileAttributes.ReadOnly) != 0;
        bool moved = false;
        try
        {
            // 不可变副本可能已有只读属性；只在刷新暂存项时解除，发布后立即恢复。
            if (readOnly) File.SetAttributes(source, attributes & ~FileAttributes.ReadOnly);
            using (FileStream file = new(source, FileMode.Open, FileAccess.ReadWrite, FileShare.Read, 4096, FileOptions.WriteThrough)) file.Flush(true);
            if (!MoveFileEx(source, target, 8u | (replace ? 1u : 0u))) throw new Win32Exception(Marshal.GetLastWin32Error());
            moved = true;
        }
        finally { if (readOnly) File.SetAttributes(moved ? target : source, attributes); }
    }

    /// <summary>生成不包含 account 明文的凭据文件路径。</summary>
    private static string SecretPath(JsonElement value)
    {
        string directory = CanonicalPath(RequiredString(value, "directory"));
        if (Directory.Exists(directory)) AssertPrivatePath(directory, true);
        string identity = RequiredString(value, "service") + "\0" + RequiredString(value, "account");
        return Path.Combine(directory, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity))).ToLowerInvariant() + ".dpapi");
    }

    /// <summary>DPAPI 附加数据绑定 service/account，防止密文被换到另一个凭据位置。</summary>
    private static byte[] SecretEntropy(JsonElement value) => SHA256.HashData(Encoding.UTF8.GetBytes(RequiredString(value, "service") + "\0" + RequiredString(value, "account")));

    /// <summary>通过 CurrentUser DPAPI 保护或解开凭据；禁止 LocalMachine 范围。</summary>
    private static byte[] TransformSecret(byte[] bytes, byte[] entropy, bool protect)
    {
        GCHandle sourcePin = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        GCHandle entropyPin = GCHandle.Alloc(entropy, GCHandleType.Pinned);
        DataBlob output = default;
        try
        {
            DataBlob source = new() { Length = bytes.Length, Data = sourcePin.AddrOfPinnedObject() };
            DataBlob additional = new() { Length = entropy.Length, Data = entropyPin.AddrOfPinnedObject() };
            bool succeeded = protect ? CryptProtectData(ref source, null, ref additional, IntPtr.Zero, IntPtr.Zero, 1, out output) : CryptUnprotectData(ref source, IntPtr.Zero, ref additional, IntPtr.Zero, IntPtr.Zero, 1, out output);
            if (!succeeded) throw new Win32Exception(Marshal.GetLastWin32Error());
            byte[] result = new byte[output.Length];
            Marshal.Copy(output.Data, result, 0, result.Length);
            return result;
        }
        finally
        {
            if (output.Data != IntPtr.Zero) LocalFree(output.Data);
            sourcePin.Free();
            entropyPin.Free();
        }
    }

    /// <summary>以私有临时文件和原生原子发布更新凭据，不写入明文文件。</summary>
    private static object SetSecret(JsonElement value)
    {
        EnsurePrivatePath(RequiredString(value, "directory"), true);
        string path = SecretPath(value);
        byte[] secret = Encoding.UTF8.GetBytes(RequiredString(value, "value"));
        byte[] payload = new byte[secret.Length + 1];
        payload[0] = 1;
        secret.CopyTo(payload, 1);
        try { WriteSecretPayload(path, payload, SecretEntropy(value)); return new { saved = true }; }
        finally { CryptographicOperations.ZeroMemory(secret); CryptographicOperations.ZeroMemory(payload); }
    }

    /// <summary>密文更新和删除标记共用耐久发布，避免崩溃后恢复已删除的凭据。</summary>
    private static void WriteSecretPayload(string path, byte[] payload, byte[] entropy)
    {
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            byte[] protectedBytes = TransformSecret(payload, entropy, true);
            using (FileStream file = new(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { file.Write(protectedBytes); file.Flush(true); }
            EnsurePrivatePath(temporary, false);
            PublishFile(temporary, path, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    /// <summary>只把系统确认不存在视为缺项，权限和 I/O 错误不能伪装成未配置。</summary>
    private static bool SecretExists(string path)
    {
        try { File.GetAttributes(path); return true; }
        catch (FileNotFoundException) { return false; }
        catch (DirectoryNotFoundException) { return false; }
    }

    /// <summary>只有真正不存在时返回缺项，解密或 ACL 错误均保留失败。</summary>
    private static object GetSecret(JsonElement value)
    {
        string path = SecretPath(value);
        if (!SecretExists(path)) return new { value = (string?)null };
        byte[] secret = TransformSecret(ReadPrivateFile(path, 1024 * 1024), SecretEntropy(value), false);
        try
        {
            if (secret.Length == 1 && secret[0] == 0) return new { value = (string?)null };
            if (secret.Length < 2 || secret[0] != 1) throw new IOException("Windows 凭据密文内容格式无效。");
            return new { value = Encoding.UTF8.GetString(secret, 1, secret.Length - 1) };
        }
        finally { CryptographicOperations.ZeroMemory(secret); }
    }

    /// <summary>发布已删除标记，不保留秘密内容；该标记让删除与写入具有相同的耐久保证。</summary>
    private static object DeleteSecret(JsonElement value)
    {
        string path = SecretPath(value);
        if (SecretExists(path)) { AssertPrivatePath(path, false); WriteSecretPayload(path, new byte[] { 0 }, SecretEntropy(value)); }
        return new { deleted = true };
    }

    /// <summary>离线认领前独占打开全部文件，拒绝正在使用的资源和 reparse point。</summary>
    private static object CheckOffline(JsonElement value)
    {
        string root = CanonicalPath(RequiredString(value, "path"));
        List<SafeFileHandle> handles = new();
        try
        {
            Stack<string> directories = new();
            directories.Push(root);
            while (directories.TryPop(out string? directory))
            {
                foreach (string path in Directory.EnumerateFileSystemEntries(directory))
                {
                    CanonicalPath(path);
                    if (Directory.Exists(path)) { directories.Push(path); continue; }
                    SafeFileHandle handle = CreateFile(path, 0x80000000, 0, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
                    ThrowIfInvalid(handle);
                    handles.Add(handle);
                    AssertHandleOrdinary(handle);
                }
            }
            return new { files = handles.Count, noObservableFileUsers = true };
        }
        finally { foreach (SafeFileHandle handle in handles) handle.Dispose(); }
    }

    /// <summary>读取当前进程的实际提升状态，不使用管理员组成员关系推断 UAC 状态。</summary>
    private static object ReadTokenStatus()
    {
        // TOKEN_QUERY 只读打开进程 token；TokenElevation 返回单个 DWORD。
        if (!OpenProcessToken(GetCurrentProcess(), 0x0008, out SafeAccessTokenHandle token)) throw new Win32Exception(Marshal.GetLastWin32Error());
        using (token)
        {
            if (!GetTokenInformation(token, 20, out uint elevation, sizeof(uint), out uint returnedBytes)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (returnedBytes != sizeof(uint)) throw new InvalidDataException("Windows token 提升状态格式无效。");
            return new { elevated = elevation != 0 };
        }
    }

    /// <summary>校验文件签名链和文件内容，返回发行者供调用方匹配固定产品策略。</summary>
    internal static object VerifyAuthenticode(string path)
    {
        path = CanonicalPath(path);
        using FileStream signatureLock = new(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        IntPtr filePath = Marshal.StringToCoTaskMemUni(path);
        IntPtr fileInfoPointer = IntPtr.Zero;
        try
        {
            WinTrustFileInfo fileInfo = new() { Size = (uint)Marshal.SizeOf<WinTrustFileInfo>(), FilePath = filePath };
            fileInfoPointer = Marshal.AllocHGlobal(Marshal.SizeOf<WinTrustFileInfo>());
            Marshal.StructureToPtr(fileInfo, fileInfoPointer, false);
            WinTrustData data = new() { Size = (uint)Marshal.SizeOf<WinTrustData>(), UiChoice = 2, RevocationChecks = 1, UnionChoice = 1, FileInfo = fileInfoPointer, StateAction = 1, ProviderFlags = 0x80 };
            Guid policy = new("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");
            int status = WinVerifyTrust(new IntPtr(-1), ref policy, ref data);
            data.StateAction = 2;
            WinVerifyTrust(new IntPtr(-1), ref policy, ref data);
            if (status != 0)
            {
                // 仅无签名且 PE 证书表为空时返回不可信版本字段，损坏或不可信签名不能降级。
                FileVersionInfo? unsignedIdentity = null;
                if (status == unchecked((int)0x800B0100))
                {
                    try
                    {
                        // 复用已锁定的文件流读取 PE 头，期间不允许替换或修改文件。
                        using PEReader executable = new(signatureLock, PEStreamOptions.LeaveOpen);
                        if (executable.PEHeaders.PEHeader is { CertificateTableDirectory: { Size: 0, RelativeVirtualAddress: 0 } }) unsignedIdentity = FileVersionInfo.GetVersionInfo(path);
                    }
                    catch (BadImageFormatException)
                    {
                        // 非法 PE 保持 valid=false，不能让坏文件进入内部包身份或中断候选发现。
                        unsignedIdentity = null;
                    }
                }
                return new { valid = false, status, subject = (string?)null, thumbprint = (string?)null, productName = unsignedIdentity?.ProductName, originalFilename = unsignedIdentity?.OriginalFilename };
            }
            using X509Certificate2 certificate = new(X509Certificate.CreateFromSignedFile(path));
            FileVersionInfo identity = FileVersionInfo.GetVersionInfo(path);
            return new { valid = true, status, subject = certificate.Subject, thumbprint = certificate.Thumbprint, productName = identity.ProductName, originalFilename = identity.OriginalFilename };
        }
        finally { if (fileInfoPointer != IntPtr.Zero) Marshal.FreeHGlobal(fileInfoPointer); Marshal.FreeCoTaskMem(filePath); }
    }

    /// <summary>适配 JSON 创建请求。</summary>
    private static object EnsurePrivate(JsonElement value) { EnsurePrivatePath(RequiredString(value, "path"), value.GetProperty("kind").GetString() == "directory"); return new { secured = true }; }
    /// <summary>适配 JSON 私有权限校验。</summary>
    private static object AssertPrivate(JsonElement value) { AssertPrivatePath(RequiredString(value, "path"), value.GetProperty("kind").GetString() == "directory"); return new { verified = true }; }
    /// <summary>适配 JSON 归属校验。</summary>
    private static object AssertOwned(JsonElement value) { AssertOwnedPath(RequiredString(value, "path"), value.GetProperty("kind").GetString() == "directory"); return new { verified = true }; }
    /// <summary>适配 JSON 文件发布请求。</summary>
    private static object Publish(JsonElement value) { PublishFile(RequiredString(value, "source"), RequiredString(value, "target"), value.GetProperty("replace").GetBoolean()); return new { published = true }; }

    /// <summary>同卷写穿透移动文件或目录，禁止覆盖；链接只移动目录项，不访问链接目标。</summary>
    private static object MoveEntry(JsonElement value)
    {
        // 只允许末级对象为链接，父目录仍拒绝重解析路径和网络卷。
        string source = RequiredString(value, "source");
        if (!Path.IsPathFullyQualified(source) || source.StartsWith("\\\\", StringComparison.Ordinal) || source.AsSpan(2).Contains(':')) throw new ArgumentException("来源必须是本机绝对路径，不能使用设备路径或 ADS。");
        source = Path.GetFullPath(source);
        // 目标路径使用安全组件已有的规范化和重解析点检查。
        string target = CanonicalPath(RequiredString(value, "target"));
        CanonicalPath(Path.GetDirectoryName(source) ?? throw new ArgumentException("来源目录无效。"));
        if (!string.Equals(Path.GetPathRoot(source), Path.GetPathRoot(target), StringComparison.OrdinalIgnoreCase)) throw new IOException("文件移动必须在同一卷内完成。");
        if (!MoveFileEx(source, target, 8u)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return new { moved = true };
    }
    /// <summary>拒绝错误句柄，保留 Windows 错误码。</summary>
    private static void ThrowIfInvalid(SafeFileHandle handle) { if (handle.IsInvalid) { int code = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(code); } }
    /// <summary>在已打开句柄上拒绝目录、reparse point 和硬链接复用。</summary>
    private static void AssertHandleOrdinary(SafeFileHandle handle) { if (!GetFileInformationByHandle(handle, out ByHandleFileInformation info)) throw new Win32Exception(Marshal.GetLastWin32Error()); if ((info.Attributes & (0x10 | 0x400)) != 0 || info.NumberOfLinks != 1) throw new IOException("安全文件不能是目录、reparse point 或硬链接。"); }

    /// <summary>DPAPI 的字节缓冲区。</summary>
    [StructLayout(LayoutKind.Sequential)] private struct DataBlob { public int Length; public IntPtr Data; }
    /// <summary>文件句柄稳定身份。</summary>
    [StructLayout(LayoutKind.Sequential)] private struct ByHandleFileInformation { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime, LastAccessTime, LastWriteTime; public uint VolumeSerial, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow; }
    /// <summary>WinTrust 文件输入。</summary>
    [StructLayout(LayoutKind.Sequential)] private struct WinTrustFileInfo { public uint Size; public IntPtr FilePath, FileHandle, KnownSubject; }
    /// <summary>WinTrust 签名策略结构。</summary>
    [StructLayout(LayoutKind.Sequential)] private struct WinTrustData { public uint Size; public IntPtr PolicyCallbackData, SipClientData; public uint UiChoice, RevocationChecks, UnionChoice; public IntPtr FileInfo; public uint StateAction; public IntPtr StateData, UrlReference; public uint ProviderFlags, UiContext; public IntPtr SignatureSettings; }
    /// <summary>Windows 只打开指定目录项的文件句柄。</summary>
    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    /// <summary>Windows 句柄身份查询。</summary>
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out ByHandleFileInformation information);
    /// <summary>Windows 写穿透发布。</summary>
    [DllImport("kernel32.dll", EntryPoint = "MoveFileExW", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool MoveFileEx(string source, string target, uint flags);
    /// <summary>由操作系统判断本机卷，拒绝映射网络盘与未知设备。</summary>
    [DllImport("kernel32.dll", EntryPoint = "GetDriveTypeW", CharSet = CharSet.Unicode)] private static extern uint GetDriveType(string root);
    /// <summary>按当前用户加密。</summary>
    [DllImport("crypt32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CryptProtectData(ref DataBlob input, string? description, ref DataBlob entropy, IntPtr reserved, IntPtr prompt, uint flags, out DataBlob output);
    /// <summary>按当前用户解密。</summary>
    [DllImport("crypt32.dll", SetLastError = true)] private static extern bool CryptUnprotectData(ref DataBlob input, IntPtr description, ref DataBlob entropy, IntPtr reserved, IntPtr prompt, uint flags, out DataBlob output);
    /// <summary>释放系统分配的 DPAPI 缓冲区。</summary>
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    /// <summary>Windows 官方 Authenticode 信任验证。</summary>
    [DllImport("wintrust.dll", ExactSpelling = true)] private static extern int WinVerifyTrust(IntPtr window, ref Guid action, ref WinTrustData data);
    /// <summary>取得当前进程的伪句柄，不需要关闭。</summary>
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    /// <summary>只读打开指定进程的真实访问 token，安全句柄负责释放。</summary>
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool OpenProcessToken(IntPtr process, uint access, out SafeAccessTokenHandle token);
    /// <summary>读取 TokenElevation 的 DWORD 结果及实际长度。</summary>
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetTokenInformation(SafeAccessTokenHandle token, int informationClass, out uint information, uint length, out uint returnedLength);
}
