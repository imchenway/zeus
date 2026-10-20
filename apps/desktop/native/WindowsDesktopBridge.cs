using System.Buffers.Binary;
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace Zeus.Platform;

/// <summary>普通用户权限下的浏览器通信、Git 授权提示及系统文件剪贴板入口。</summary>
internal static class WindowsDesktopBridge
{
    // 浏览器传入帧沿用现有上限，返回帧遵守 Chrome Native Messaging 的一兆限制。
    private const int MaximumInputBytes = 16 * 1024 * 1024;
    private const int MaximumOutputBytes = 1024 * 1024;
    // Windows 标准文件列表剪贴板格式。
    private const uint FileDropFormat = 15;

    /// <summary>只识别明确的桌面入口，其余参数交给安全组件处理。</summary>
    internal static bool TryRun(string[] args, out int exitCode)
    {
        exitCode = 0;
        // 浏览器只能登记程序路径，复制后的文件名选择专用标准输入输出协议。
        bool browser = string.Equals(Path.GetFileNameWithoutExtension(Environment.ProcessPath), "ZeusBrowserNativeHost", StringComparison.OrdinalIgnoreCase);
        bool askpass = string.Equals(Path.GetFileNameWithoutExtension(Environment.ProcessPath), "ZeusGitAskpass", StringComparison.OrdinalIgnoreCase)
            || Environment.GetEnvironmentVariable("ZEUS_WINDOWS_DESKTOP_MODE") == "git-askpass";
        bool clipboard = args.Length == 1 && args[0] == "--clipboard-files";
        bool discover = args.Length > 1 && args[0] == "--find-application";
        // 更新窗口使用独立入口，避免把原生消息或凭据协议解释成界面命令。
        bool updateProgress = args.Length == 1 && args[0] == "--update-progress";
        if (!browser && !askpass && !clipboard && !discover && !updateProgress) return false;
        try
        {
            if (browser) RunBrowser(args);
            else if (askpass) exitCode = WindowsGitAskpass.Run(args);
            else if (clipboard) Console.Write(JsonSerializer.Serialize(ReadClipboardFiles()));
            else if (updateProgress) WindowsUpdateProgress.Run();
            else Console.Write(JsonSerializer.Serialize(FindInstalledApplications(args[1..])));
        }
        catch
        {
            // 不把凭据、令牌、剪贴板内容或本机路径写入错误日志。
            if (browser)
            {
                try { WriteFrame(Console.OpenStandardOutput(), "{\"type\":\"host_error\",\"code\":\"ZEUS_BROWSER_NATIVE_HOST_FAILED\",\"message\":\"Zeus rejected the Native Messaging rendezvous.\"}"u8.ToArray()); }
                catch { /* 浏览器关闭管道后无需再次写入。 */ }
            }
            Console.Error.WriteLine("Zeus Windows desktop operation failed.");
            exitCode = 1;
        }
        return true;
    }

    /// <summary>只读取标准应用注册位置，不执行注册表中的任何命令。</summary>
    private static string[] FindInstalledApplications(string[] names)
    {
        if (names.Length > 16 || names.Any(name => name.Length > 120 || name != Path.GetFileName(name) || name.Contains(':') || !name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))) throw new InvalidDataException();
        HashSet<string> paths = new(StringComparer.OrdinalIgnoreCase);
        foreach (RegistryHive hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        {
            foreach (RegistryView view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
            {
                using RegistryKey root = RegistryKey.OpenBaseKey(hive, view);
                foreach (string name in names)
                {
                    using RegistryKey? entry = root.OpenSubKey($"Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{name}");
                    if (entry?.GetValue(null) is not string value) continue;
                    string path = Environment.ExpandEnvironmentVariables(value).Trim().Trim('"');
                    if (Path.IsPathFullyQualified(path) && File.Exists(path)) paths.Add(Path.GetFullPath(path));
                }
            }
        }
        return paths.ToArray();
    }

    /// <summary>只打开签名属于腾讯的固定微信开发者工具；调用方不能提交命令、参数或环境。</summary>
    internal static object OpenWechatApplication(JsonElement request)
    {
        // 提示只用于发现同一安装目录；绝不执行提示中的批处理文件。
        HashSet<string> candidates = new(StringComparer.OrdinalIgnoreCase);
        if (request.TryGetProperty("cliPathHint", out JsonElement hint))
        {
            string cli = hint.GetString() ?? throw new ArgumentException("微信 CLI 路径提示无效。");
            cli = WindowsSecurityHelper.CanonicalPath(cli);
            if (!string.Equals(Path.GetFileName(cli), "cli.bat", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("微信 CLI 路径提示必须指向 cli.bat。");
            candidates.Add(Path.Combine(Path.GetDirectoryName(cli)!, "wechatdevtools.exe"));
        }
        foreach (string application in FindInstalledApplications(["wechatdevtools.exe"])) candidates.Add(application);
        foreach (Environment.SpecialFolder location in new[] { Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86, Environment.SpecialFolder.LocalApplicationData })
        {
            string root = Environment.GetFolderPath(location);
            if (string.IsNullOrEmpty(root)) continue;
            foreach (string installation in new[] { "Tencent\\微信web开发者工具", "Tencent\\微信开发者工具", "Tencent\\WeChat DevTools", "微信web开发者工具", "WeChat DevTools", "Programs\\WeChat DevTools" })
                candidates.Add(Path.Combine(root, installation, "wechatdevtools.exe"));
        }

        // 所有验证失败均发生在启动前；只有确定产品身份的第一个候选可以产生一次启动。
        foreach (string candidate in candidates)
        {
            if (!File.Exists(candidate)) continue;
            string applicationPath = WindowsSecurityHelper.CanonicalPath(candidate);
            if (!string.Equals(Path.GetFileName(applicationPath), "wechatdevtools.exe", StringComparison.OrdinalIgnoreCase)) continue;
            string directory = Path.GetDirectoryName(applicationPath)!;
            string cliPath = WindowsSecurityHelper.CanonicalPath(Path.Combine(directory, "cli.bat"));
            if (!File.Exists(cliPath)) continue;
            using FileStream applicationLock = new(applicationPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            using FileStream cliLock = new(cliPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            JsonElement signature = JsonSerializer.SerializeToElement(WindowsSecurityHelper.VerifyAuthenticode(applicationPath));
            if (!signature.GetProperty("valid").GetBoolean() || !IsWechatProduct(signature.GetProperty("productName").GetString()) || !IsTencentPublisher(signature.GetProperty("subject").GetString())) continue;
            if (HasRunningWechatApplication(applicationPath)) return new { applicationPath, cliPath };

            // 原生进程启动不解释 shell，不继承 Zeus 的授权令牌或运行时配置变量。
            ProcessStartInfo start = new(applicationPath) { UseShellExecute = false, WorkingDirectory = directory };
            start.Environment.Clear();
            foreach (string name in new[] { "SystemRoot", "WINDIR", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "COMSPEC", "USERNAME", "USERDOMAIN" })
                if (Environment.GetEnvironmentVariable(name) is string value) start.Environment[name] = value;
            start.Environment["PATH"] = Environment.GetFolderPath(Environment.SpecialFolder.System);
            using Process launched = Process.Start(start) ?? throw new InvalidOperationException("微信开发者工具启动结果未知，请核对应用后再操作。");
            // 真实进程句柄和映像文件锁保留到启动确认结束，拒绝把 PID 复用当成同一程序。
            _ = launched.SafeHandle;
            if (!SameProcessImage(launched, applicationPath) || !launched.WaitForInputIdle(10_000) || launched.HasExited)
                throw new InvalidOperationException("微信开发者工具已收到启动请求，但未能确认就绪；结果未知，不自动重试。");
            return new { applicationPath, cliPath };
        }
        throw new FileNotFoundException("未找到签名及产品身份可验证的微信开发者工具安装，请检查安装位置和签名。");
    }

    /// <summary>产品名来自通过签名校验的 PE 资源，只接纳明确的微信开发者工具名称。</summary>
    private static bool IsWechatProduct(string? product) => new[] { "微信开发者工具", "微信web开发者工具", "wechatdevtools", "WeChat DevTools" }.Contains(product?.Trim(), StringComparer.OrdinalIgnoreCase);

    /// <summary>签名主体的 CN 或 O 必须使用明确腾讯公司名，不能只匹配任意子串。</summary>
    private static bool IsTencentPublisher(string? subject) => subject is not null && Regex.IsMatch(subject, "(?:^|,\\s*)(?:CN|O)=\"?(?:Tencent Technology ?\\(Shenzhen\\) Company Limited|Tencent Technology ?\\(Shenzhen\\) Co\\.,? Ltd\\.?|腾讯科技[（(]深圳[）)]有限公司)\"?(?:,|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>只复用有 GUI 窗口且真实句柄仍对应同一签名映像的进程，不激活其他窗口。</summary>
    private static bool HasRunningWechatApplication(string applicationPath)
    {
        foreach (Process process in Process.GetProcessesByName("wechatdevtools"))
        {
            using (process)
            {
                try { if (SameProcessImage(process, applicationPath) && !process.HasExited && process.MainWindowHandle != IntPtr.Zero) return true; }
                catch (System.ComponentModel.Win32Exception) { /* 其他用户的进程不可查询，不把它当成可复用窗口。 */ }
                catch (InvalidOperationException) { /* 查询期间退出的进程不能证明应用已就绪。 */ }
            }
        }
        return false;
    }

    /// <summary>通过已持有的真实进程句柄读取完整映像路径，避免仅按进程名或 PID 判断身份。</summary>
    private static bool SameProcessImage(Process process, string applicationPath)
    {
        StringBuilder imagePath = new(32768);
        int characters = imagePath.Capacity;
        if (!QueryFullProcessImageNameW(process.SafeHandle, 0, imagePath, ref characters)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        return string.Equals(WindowsSecurityHelper.CanonicalPath(imagePath.ToString()), applicationPath, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Windows 提供的句柄级进程映像查询，不依赖 WMI 或可复用的 PID 快照。</summary>
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageNameW(SafeProcessHandle process, uint flags, StringBuilder path, ref int characters);

    /// <summary>校验私有会合文件和扩展身份后，把原生消息转发到固定本机端点。</summary>
    private static void RunBrowser(string[] args)
    {
        string executable = Environment.ProcessPath ?? throw new InvalidOperationException();
        string root = Path.GetDirectoryName(executable) ?? throw new InvalidOperationException();
        WindowsSecurityHelper.AssertPrivatePath(root, true);
        using JsonDocument configuration = JsonDocument.Parse(WindowsSecurityHelper.ReadPrivateFile(Path.Combine(root, "rendezvous.json"), 64 * 1024));
        JsonElement config = configuration.RootElement;
        string endpoint = config.GetProperty("endpoint").GetString() ?? "";
        string token = config.GetProperty("token").GetString() ?? "";
        string surface = config.GetProperty("surface").GetString() ?? "";
        string extensionId = config.GetProperty("extensionId").GetString() ?? "";
        int pid = config.GetProperty("pid").GetInt32();
        if (surface is not ("chrome" or "edge") || !Regex.IsMatch(token, "^[A-Za-z0-9_-]{43,128}$", RegexOptions.CultureInvariant) || !Regex.IsMatch(extensionId, "^[a-p]{32}$", RegexOptions.CultureInvariant) || pid <= 1)
            throw new InvalidDataException();
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out Uri? uri) || uri.Scheme != "http" || uri.Host != "127.0.0.1" || uri.Port is < 1 or > 65535 || uri.AbsolutePath != "/native" || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0)
            throw new InvalidDataException();
        if (args.Length == 0 || args[0] != $"chrome-extension://{extensionId}/") throw new InvalidDataException();
        // 持有真实进程句柄，避免运行途中把复用的 PID 当成原宿主。
        using Process host = Process.GetProcessById(pid);
        _ = host.Handle;
        // 宿主退出时立即释放浏览器桥程序，即使扩展尚未关闭输入管道也不占用升级文件。
        host.EnableRaisingEvents = true;
        host.Exited += (_, _) => Environment.Exit(0);
        using HttpClientHandler handler = new() { UseProxy = false, AllowAutoRedirect = false };
        using HttpClient client = new(handler) { Timeout = TimeSpan.FromSeconds(25) };
        using Stream input = Console.OpenStandardInput();
        using Stream output = Console.OpenStandardOutput();
        while (ReadFrame(input) is byte[] message)
        {
            if (host.HasExited) throw new InvalidOperationException();
            using HttpRequestMessage request = new(HttpMethod.Post, uri);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            request.Headers.Add("X-Zeus-Browser-Surface", surface);
            request.Content = new ByteArrayContent(message);
            request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
            using HttpResponseMessage response = client.Send(request, HttpCompletionOption.ResponseHeadersRead);
            if (response.StatusCode != System.Net.HttpStatusCode.OK || response.Content.Headers.ContentLength > MaximumOutputBytes) throw new InvalidDataException();
            using Stream body = response.Content.ReadAsStream();
            using MemoryStream result = new();
            byte[] buffer = new byte[8192];
            int count;
            while ((count = body.Read(buffer)) > 0)
            {
                if (result.Length + count > MaximumOutputBytes) throw new InvalidDataException();
                result.Write(buffer, 0, count);
            }
            WriteFrame(output, result.Length == 0 ? "{\"type\":\"noop\"}"u8.ToArray() : result.ToArray());
        }
    }

    /// <summary>完整读取小端长度帧；断裂消息失败，不接受部分 JSON。</summary>
    private static byte[]? ReadFrame(Stream input)
    {
        byte[] header = new byte[4];
        int first = input.ReadByte();
        if (first == -1) return null;
        header[0] = (byte)first;
        input.ReadExactly(header.AsSpan(1));
        uint length = BinaryPrimitives.ReadUInt32LittleEndian(header);
        if (length == 0 || length > MaximumInputBytes) throw new InvalidDataException();
        byte[] message = new byte[(int)length];
        input.ReadExactly(message);
        return message;
    }

    /// <summary>按浏览器原生协议写出完整响应并立即刷新管道。</summary>
    private static void WriteFrame(Stream output, byte[] message)
    {
        if (message.Length > MaximumOutputBytes) throw new InvalidDataException();
        byte[] header = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(header, (uint)message.Length);
        output.Write(header);
        output.Write(message);
        output.Flush();
    }

    /// <summary>从 Windows 文件列表读取路径，不把文件图标误当成图片附件。</summary>
    private static string[] ReadClipboardFiles()
    {
        if (!OpenClipboard(IntPtr.Zero)) throw new InvalidOperationException();
        try
        {
            IntPtr handle = GetClipboardData(FileDropFormat);
            if (handle == IntPtr.Zero) return [];
            uint count = DragQueryFileW(handle, uint.MaxValue, null, 0);
            if (count > 128) throw new InvalidDataException();
            List<string> paths = new();
            for (uint index = 0; index < count; index++)
            {
                uint length = DragQueryFileW(handle, index, null, 0);
                if (length is 0 or > 32767) throw new InvalidDataException();
                StringBuilder path = new((int)length + 1);
                if (DragQueryFileW(handle, index, path, (uint)path.Capacity) != length) throw new InvalidDataException();
                string value = path.ToString();
                if (!Path.IsPathFullyQualified(value)) throw new InvalidDataException();
                paths.Add(value);
            }
            return paths.ToArray();
        }
        finally { CloseClipboard(); }
    }

    /// <summary>在当前用户会话中读取剪贴板。</summary>
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenClipboard(IntPtr owner);
    /// <summary>释放剪贴板，避免影响用户后续复制操作。</summary>
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseClipboard();
    /// <summary>取得系统托管的文件列表句柄。</summary>
    [DllImport("user32.dll")]
    private static extern IntPtr GetClipboardData(uint format);
    /// <summary>按索引读取 Unicode 文件路径。</summary>
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern uint DragQueryFileW(IntPtr drop, uint index, StringBuilder? file, uint characters);
}
