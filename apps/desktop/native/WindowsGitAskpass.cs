using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

/// <summary>Git 与模型共用系统凭据提示；仅保存通过本地私钥校验的 SSH 口令。</summary>
internal static class WindowsGitAskpass
{
    // OpenSSH askpass 单行缓冲区需要预留换行与结束字符。
    private const int MaximumSecretBytes = 1022;

    /// <summary>只接受一条有界提示；内部校验只读取匿名管道，不访问凭据库。</summary>
    internal static int Run(string[] args)
    {
        try { return RunPrompt(args); }
        catch
        {
            // 原生错误只显示非敏感说明，不把进程参数或系统凭据传到模型日志。
            MessageBoxW(IntPtr.Zero, "无法完成系统认证。请检查系统凭据管理器和 SSH 密钥文件，然后重试。", "Zeus · SSH 认证", 0);
            return 1;
        }
    }

    /// <summary>解析调用模式并按密钥串行执行，取消不触发再次提示。</summary>
    private static int RunPrompt(string[] args)
    {
        if (args.Length != 1 || string.IsNullOrWhiteSpace(args[0]) || args[0].Length > 8192) return 1;
        if (Environment.GetEnvironmentVariable("ZEUS_GIT_ASKPASS_STDIN") == "1")
        {
            // 管道有界读取，重复请求只会遇到 EOF，不会再弹出密码框。
            char[] buffer = new char[MaximumSecretBytes + 1];
            int count = Console.In.ReadBlock(buffer, 0, buffer.Length);
            string secret = new(buffer, 0, count);
            Array.Clear(buffer);
            if (!ValidSecret(secret)) return 1;
            Console.WriteLine(secret);
            return 0;
        }
        // 路径只从标准 SSH 提示中读取；未知提示保留当次输入能力。
        string prompt = args[0].Trim();
        string? key = PrivateKeyPath(prompt);
        string? service = Environment.GetEnvironmentVariable("ZEUS_GIT_ASKPASS_SERVICE");
        // 凭据目标按产品身份和密钥路径隔离，不按可变的仓库名缓存。
        string? target = key is not null && !string.IsNullOrEmpty(service)
            ? "Zeus.Git.SSH:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(service + "\0" + key.ToUpperInvariant())))
            : null;
        if (target is null) return Prompt(prompt, null, null);
        // 命名锁只覆盖同一 Windows 用户和同一密钥；不包含口令。
        using Mutex mutex = new(false, @"Local\ZeusGitAskpass-" + WindowsIdentity.GetCurrent().User!.Value + "-" + target["Zeus.Git.SSH:".Length..]);
        bool locked = false;
        try
        {
            try { locked = mutex.WaitOne(TimeSpan.FromSeconds(90)); }
            catch (AbandonedMutexException) { locked = true; }
            if (!locked) return 1;
            // 获锁后再读取，前一个并发操作保存成功时不重复询问。
            string? saved = ReadSecret(target);
            if (saved is not null)
            {
                if (Accepts(saved, key!))
                {
                    Console.Write(saved);
                    return 0;
                }
                if (!CredDeleteW(target, 1, 0) && Marshal.GetLastWin32Error() != 1168) throw new Win32Exception();
            }
            return Prompt(prompt, key, target);
        }
        finally { if (locked) mutex.ReleaseMutex(); }
    }

    /// <summary>识别 SSH 与 ssh-add 的完整路径提示，非密钥提示不能保存。</summary>
    private static string? PrivateKeyPath(string prompt)
    {
        // 提示必须覆盖完整字段；引号中的内容不会拼接为命令。
        string path;
        if (prompt.StartsWith("Enter passphrase for key '", StringComparison.Ordinal) && prompt.EndsWith("':", StringComparison.Ordinal))
            path = prompt["Enter passphrase for key '".Length..^2];
        else if (prompt.StartsWith("Enter passphrase for ", StringComparison.Ordinal) && prompt.EndsWith(':'))
            path = prompt["Enter passphrase for ".Length..^1];
        else return null;
        // Git for Windows 的 OpenSSH 可能使用 /c/Users 形式，统一为 Windows 绝对路径。
        if (path.Length > 3 && path[0] == '/' && char.IsAsciiLetter(path[1]) && path[2] == '/')
            path = path[1] + ":" + path[2..];
        if (!Path.IsPathFullyQualified(path) || path.IndexOfAny(['\0', '\r', '\n']) >= 0 || !File.Exists(path)) return null;
        // 链接指向同一密钥时复用同一凭据；口令变化另由本地校验识别。
        FileInfo file = new(Path.GetFullPath(path));
        return file.ResolveLinkTarget(true)?.FullName ?? file.FullName;
    }

    /// <summary>拒绝换行、空口令与超限值，不静默截断或缓存。</summary>
    private static bool ValidSecret(string value) =>
        value.Length > 0 && Encoding.UTF8.GetByteCount(value) <= MaximumSecretBytes && value.IndexOfAny(['\0', '\r', '\n']) < 0;

    /// <summary>复用 Windows 原生凭据窗口；保存勾选仅对已识别的 SSH 私钥开放。</summary>
    private static int Prompt(string prompt, string? key, string? target)
    {
        if (prompt.Contains("yes/no", StringComparison.OrdinalIgnoreCase))
        {
            // 服务器指纹仍独立确认且默认拒绝，记住口令不会扩大服务器信任。
            int answer = MessageBoxW(IntPtr.Zero, prompt, "Zeus · 核对 Git 服务器指纹", 0x00000004 | 0x00000030 | 0x00000100);
            if (answer != 6) return 1;
            Console.Write("yes");
            return 0;
        }
        // 校验失败后的再次输入保留用户刚选择的保存状态。
        bool save = false;
        for (int attempt = 0; attempt < 3; attempt++)
        {
            // 用户名继续显示为普通输入；密码使用系统遮蔽控件。
            bool usernameRequested = prompt.Contains("Username", StringComparison.OrdinalIgnoreCase);
            CredentialUiInfo info = new() { Size = Marshal.SizeOf<CredentialUiInfo>(), Message = prompt, Caption = "Zeus · Git 凭据" };
            StringBuilder username = new(513);
            StringBuilder password = new(513);
            if (!usernameRequested) username.Append("Git");
            // 系统窗口只返回勾选结果；本地密钥验证通过后才显式写入凭据管理器。
            uint flags = 0x00040000 | 0x00000080 | 0x00000002 | (target is null ? 0u : 0x00000040);
            uint status = CredUIPromptForCredentialsW(ref info, key is null ? "Zeus Git" : "Zeus SSH · " + Path.GetFileName(key), IntPtr.Zero, 0, username, username.Capacity, password, password.Capacity, ref save, flags);
            if (status != 0) return 1;
            string secret = usernameRequested ? username.ToString() : password.ToString();
            username.Clear();
            password.Clear();
            if (!ValidSecret(secret))
            {
                MessageBoxW(IntPtr.Zero, "输入过长或包含换行，请重新输入。", "Zeus · SSH 认证", 0);
                continue;
            }
            if (save && target is not null && key is not null)
            {
                if (!Accepts(secret, key))
                {
                    MessageBoxW(IntPtr.Zero, "口令未通过这把密钥的校验，未保存。请重新输入。", "Zeus · SSH 认证", 0);
                    continue;
                }
                try { SaveSecret(target, secret, key); }
                catch
                {
                    // 保存失败必须告知用户；只有明确选择后才继续当前操作。
                    if (MessageBoxW(IntPtr.Zero, "系统凭据管理器未能保存口令。是否仅用于本次操作？下次仍可能询问。", "Zeus · 口令未能保存", 0x00000004 | 0x00000100) != 6) return 1;
                }
            }
            Console.Write(secret);
            return 0;
        }
        return 1;
    }

    /// <summary>使用现有 OpenSSH 工具只读验证私钥，口令仅写入匿名标准输入管道。</summary>
    private static bool Accepts(string secret, string key)
    {
        // 优先使用系统 OpenSSH；没有安装时沿用 Git 环境中的 ssh-keygen。
        string systemKeygen = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "OpenSSH", "ssh-keygen.exe");
        ProcessStartInfo start = new(File.Exists(systemKeygen) ? systemKeygen : "ssh-keygen.exe")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false)
        };
        start.ArgumentList.Add("-y");
        start.ArgumentList.Add("-f");
        start.ArgumentList.Add(key);
        start.Environment["SSH_ASKPASS"] = Environment.ProcessPath!;
        start.Environment["SSH_ASKPASS_REQUIRE"] = "force";
        start.Environment["DISPLAY"] = "zeus";
        start.Environment["ZEUS_GIT_ASKPASS_STDIN"] = "1";
        using Process process = Process.Start(start) ?? throw new InvalidOperationException();
        // 输出直接丢弃，公钥和错误正文不进入模型日志；同时排空两条管道防止阻塞。
        Task output = process.StandardOutput.BaseStream.CopyToAsync(Stream.Null);
        Task error = process.StandardError.BaseStream.CopyToAsync(Stream.Null);
        process.StandardInput.Write(secret);
        process.StandardInput.Close();
        if (!process.WaitForExit(15_000))
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
            throw new TimeoutException();
        }
        Task.WaitAll(output, error);
        return process.ExitCode == 0;
    }

    /// <summary>只读取当前产品和当前密钥的系统凭据，未保存与读取失败分别处理。</summary>
    private static string? ReadSecret(string target)
    {
        if (!CredReadW(target, 1, 0, out IntPtr pointer))
        {
            if (Marshal.GetLastWin32Error() == 1168) return null;
            throw new Win32Exception();
        }
        try
        {
            // 系统返回的缓冲区只在当前进程使用，随后交回系统释放。
            Credential credential = Marshal.PtrToStructure<Credential>(pointer);
            if (credential.CredentialBlobSize > MaximumSecretBytes * 2 || credential.CredentialBlobSize % 2 != 0) throw new InvalidDataException();
            return Marshal.PtrToStringUni(credential.CredentialBlob, (int)credential.CredentialBlobSize / 2);
        }
        finally { CredFree(pointer); }
    }

    /// <summary>让 Windows 凭据管理器负责持久保存，不写 Zeus 数据库或普通文件。</summary>
    private static void SaveSecret(string target, string secret, string key)
    {
        // Windows 通用凭据按当前用户加密保存，程序命令行不携带口令。
        byte[] bytes = Encoding.Unicode.GetBytes(secret);
        IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            Credential credential = new() { Type = 1, TargetName = target, Comment = "Zeus SSH · " + key, CredentialBlobSize = (uint)bytes.Length, CredentialBlob = blob, Persist = 2, UserName = "Git" };
            if (!CredWriteW(ref credential, 0)) throw new Win32Exception();
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            Marshal.FreeHGlobal(blob);
        }
    }

    /// <summary>Windows 原生凭据窗口的系统结构。</summary>
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CredentialUiInfo
    {
        /** 系统结构长度。 */ public int Size;
        /** 当前提示的父窗口。 */ public IntPtr Parent;
        /** 原始 Git 提示。 */ public string Message;
        /** 窗口标题。 */ public string Caption;
        /** 未使用的系统横幅。 */ public IntPtr Banner;
    }

    /// <summary>Windows 通用凭据结构，仅用于系统 API 调用。</summary>
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        /** 系统标志。 */ public uint Flags;
        /** 通用凭据类型。 */ public uint Type;
        /** 隔离后的凭据身份。 */ public string TargetName;
        /** 可选系统说明。 */ public string? Comment;
        /** 系统维护的写入时间。 */ public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        /** 口令缓冲区字节数。 */ public uint CredentialBlobSize;
        /** 当前进程的口令缓冲区。 */ public IntPtr CredentialBlob;
        /** 当前 Windows 用户的本机持久保存。 */ public uint Persist;
        /** 未使用的属性数量。 */ public uint AttributeCount;
        /** 未使用的属性地址。 */ public IntPtr Attributes;
        /** 未使用的目标别名。 */ public string? TargetAlias;
        /** 固定的 Git 用户标识。 */ public string UserName;
    }

    /// <summary>打开系统安全输入窗口。</summary>
    [DllImport("credui.dll", CharSet = CharSet.Unicode)]
    private static extern uint CredUIPromptForCredentialsW(ref CredentialUiInfo info, string target, IntPtr reserved, uint error, StringBuilder username, int usernameLength, StringBuilder password, int passwordLength, [MarshalAs(UnmanagedType.Bool)] ref bool save, uint flags);
    /// <summary>显示非敏感的确认或错误说明。</summary>
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(IntPtr window, string text, string caption, uint type);
    /// <summary>读取当前用户的系统凭据。</summary>
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
    /// <summary>写入当前用户的系统凭据。</summary>
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredWriteW(ref Credential credential, uint flags);
    /// <summary>移除已确认失效的单项凭据。</summary>
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredDeleteW(string target, uint type, uint flags);
    /// <summary>释放系统凭据返回的内存。</summary>
    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr pointer);
}
