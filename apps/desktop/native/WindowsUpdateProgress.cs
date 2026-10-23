using System.Drawing;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;

namespace Zeus.Platform;

/// <summary>承载既有更新协议的 Windows 原生窗口；不下载、不安装，也不决定重试策略。</summary>
internal sealed class WindowsUpdateProgress : Form
{
    // 所有显示内容和动作都来自主进程的既有状态机。
    private readonly Label heading = new() { AutoSize = true, Dock = DockStyle.Fill };
    private readonly Label detail = new() { AutoSize = true, Dock = DockStyle.Fill };
    private readonly Label progressCaption = new() { AutoSize = true, Dock = DockStyle.Fill };
    private readonly Label progressText = new() { AutoSize = true, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleRight };
    private readonly ProgressBar progress = new() { Dock = DockStyle.Fill, Maximum = 1000, Height = 18 };
    private readonly TextBox technical = new() { ReadOnly = true, Multiline = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, Height = 120 };
    private readonly Button primary = new() { AutoSize = true, MinimumSize = new Size(80, 32) };
    private readonly Button secondary = new() { AutoSize = true, MinimumSize = new Size(80, 32) };
    private readonly Button detailsToggle = new() { AutoSize = true, FlatStyle = FlatStyle.Flat };
    private readonly Button copyDetails = new() { AutoSize = true, FlatStyle = FlatStyle.Flat };
    private readonly TableLayoutPanel layout = new() { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Dock = DockStyle.Top, ColumnCount = 1, Padding = new Padding(20), GrowStyle = TableLayoutPanelGrowStyle.AddRows };
    private readonly TableLayoutPanel progressRow = new() { AutoSize = true, Dock = DockStyle.Fill, ColumnCount = 2 };
    private readonly FlowLayoutPanel actions = new() { AutoSize = true, Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, WrapContents = true };
    private readonly FlowLayoutPanel detailActions = new() { AutoSize = true, Dock = DockStyle.Fill, WrapContents = true };
    // 可见性与语言只影响显示，不能产生新的业务操作。
    private bool english;
    private bool quitting;
    private bool expanded;
    private string currentState = "checking";
    private string primaryAction = "close";
    private string secondaryAction = "later";

    /// <summary>后台状态刷新显示窗口时不抢焦点；用户显式 show 才调用 Activate。</summary>
    protected override bool ShowWithoutActivation => true;

    /// <summary>为系统控件建立单独 STA 消息线程，不改变安全程序的控制台入口。</summary>
    internal static void Run()
    {
        // 保留线程失败，避免界面崩溃仍向主进程报告正常退出。
        Exception? failure = null;
        Thread thread = new(() =>
        {
            try
            {
                Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using WindowsUpdateProgress window = new();
                _ = window.Handle;
                _ = Task.Run(window.ReadCommands);
                // 消息循环实际处理回调后才确认就绪，主进程不会把进程创建当作窗口可用。
                window.BeginInvoke(() => Emit("ready"));
                // 无主窗口启动消息循环，避免 Application.Run(form) 自动激活窗口。
                Application.Run();
            }
            catch (Exception error) { failure = error; }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (failure is not null) throw new InvalidOperationException("Windows update window failed.", failure);
    }

    /// <summary>复用系统控件的键盘、屏幕阅读器、高对比度及 DPI 布局行为。</summary>
    private WindowsUpdateProgress()
    {
        Text = "Zeus";
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(480, 260);
        MinimumSize = new Size(360, 230);
        StartPosition = FormStartPosition.CenterScreen;
        MaximizeBox = false;
        AutoScroll = true;
        heading.Font = new Font(SystemFonts.MessageBoxFont ?? SystemFonts.DefaultFont, FontStyle.Bold);
        heading.Margin = new Padding(0, 0, 0, 12);
        detail.Margin = new Padding(0, 0, 0, 16);
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        progressRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 65));
        progressRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 35));
        progressRow.Controls.Add(progressCaption, 0, 0);
        progressRow.Controls.Add(progressText, 1, 0);
        detailActions.Controls.AddRange([detailsToggle, copyDetails]);
        actions.Controls.AddRange([primary, secondary]);
        layout.Controls.Add(heading);
        layout.Controls.Add(detail);
        layout.Controls.Add(progressRow);
        layout.Controls.Add(progress);
        layout.Controls.Add(detailActions);
        layout.Controls.Add(technical);
        layout.Controls.Add(actions);
        Controls.Add(layout);
        primary.Click += (_, _) => PerformAction(primaryAction);
        secondary.Click += (_, _) => PerformAction(secondaryAction);
        detailsToggle.Click += (_, _) => { expanded = !expanded; RefreshDetails(); FitContent(); };
        copyDetails.Click += (_, _) =>
        {
            // 只在用户点击时写剪贴板；剪贴板被其他程序占用时保留可选中文本。
            try { if (technical.TextLength > 0) Clipboard.SetText(technical.Text); }
            catch (System.Runtime.InteropServices.ExternalException) { technical.Focus(); technical.SelectAll(); }
        };
        FormClosing += (_, eventArgs) =>
        {
            if (quitting) return;
            eventArgs.Cancel = true;
            Hide();
            Emit("closed");
        };
        technical.Visible = detailActions.Visible = primary.Visible = secondary.Visible = false;
    }

    /// <summary>Esc 与关闭按钮都只隐藏窗口，下载和安装状态仍由主进程维护。</summary>
    protected override bool ProcessCmdKey(ref Message message, Keys keyData)
    {
        if (keyData != Keys.Escape) return base.ProcessCmdKey(ref message, keyData);
        Hide();
        Emit("closed");
        return true;
    }

    /// <summary>标准输入关闭时释放窗口与程序，防止旧安装目录的 exe 被进度窗口占用。</summary>
    private async Task ReadCommands()
    {
        try
        {
            // 主进程协议按行传输；逐字符限制避免无界行输入占满辅助程序内存。
            using StreamReader input = new(Console.OpenStandardInput(), Encoding.UTF8);
            StringBuilder line = new();
            char[] character = new char[1];
            while (await input.ReadAsync(character, 0, 1) > 0)
            {
                if (character[0] != '\n')
                {
                    if (line.Length >= 128 * 1024) throw new InvalidDataException();
                    line.Append(character[0]);
                    continue;
                }
                using JsonDocument document = JsonDocument.Parse(line.ToString());
                JsonElement command = document.RootElement.Clone();
                line.Clear();
                BeginInvoke(() => HandleCommand(command));
            }
        }
        catch (Exception error) when (error is IOException or JsonException or InvalidDataException or InvalidOperationException)
        {
            Console.Error.WriteLine("Windows update window input closed or invalid.");
        }
        finally
        {
            if (!IsDisposed) try { BeginInvoke(Quit); } catch (InvalidOperationException) { /* 窗口已结束。 */ }
        }
    }

    /// <summary>严格按既有协议分派显示命令；Windows 重启由独立 NSIS 安装器负责。</summary>
    private void HandleCommand(JsonElement command)
    {
        if (command.ValueKind != JsonValueKind.Object) return;
        english = GetText(command, "language") == "en-US";
        ApplyAppearance(GetText(command, "appearance") == "dark");
        switch (GetText(command, "type"))
        {
            case "show":
                if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
                Show();
                Activate();
                break;
            case "hide": Hide(); break;
            case "quit": Quit(); break;
            case "state": ApplyState(command); break;
            // 不接受路径或 PID 启动程序：Windows 安装接力不经过界面助手。
            case "relaunch": Console.Error.WriteLine("Windows update relaunch requires the installer."); break;
        }
    }

    /// <summary>将状态映射到系统控件；失败是否允许重试只能使用主进程明确授权。</summary>
    private void ApplyState(JsonElement command)
    {
        currentState = GetText(command, "state");
        Text = english ? "Zeus Software Update" : "Zeus 软件更新";
        heading.Text = GetText(command, "title");
        detail.Text = GetText(command, "detail");
        progressCaption.Text = GetText(command, "progressCaption");
        progressText.Text = GetText(command, "progressText");
        if (technical.Text != GetText(command, "technicalDetail")) expanded = false;
        technical.Text = GetText(command, "technicalDetail");
        if (command.TryGetProperty("progress", out JsonElement value) && value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out double fraction) && double.IsFinite(fraction))
        {
            progress.Style = ProgressBarStyle.Continuous;
            progress.Value = (int)(Math.Clamp(fraction, 0, 1) * progress.Maximum);
        }
        else progress.Style = ProgressBarStyle.Marquee;
        progress.Visible = progressRow.Visible = currentState is "checking" or "updating" or "downloading" or "verifying" or "installing";
        (primaryAction, secondaryAction) = currentState switch
        {
            "available" => ("download", "later"),
            "manual" => ("open_download_page", "later"),
            "downloaded" => ("open_installer", "later"),
            "ready" => ("restart", "later"),
            "upToDate" => ("close", ""),
            "failed" => (IsTrue(command, "canRetry") ? "retry" : "check", "close"),
            "downloading" => ("", IsTrue(command, "canReconnect") ? "reconnect" : ""),
            _ => ("", ""),
        };
        primary.Visible = primaryAction.Length > 0;
        secondary.Visible = secondaryAction.Length > 0;
        primary.Enabled = secondary.Enabled = true;
        primary.Text = Localized(primaryAction);
        secondary.Text = Localized(secondaryAction);
        AcceptButton = primary.Visible ? primary : null;
        RefreshDetails();
        FitContent();
        if ((!command.TryGetProperty("present", out JsonElement present) || present.ValueKind != JsonValueKind.False) && !Visible && WindowState != FormWindowState.Minimized) Show();
    }

    /// <summary>详情只在失败状态出现，文本可选择复制，按钮提供键盘访问。</summary>
    private void RefreshDetails()
    {
        detailActions.Visible = currentState == "failed" && technical.TextLength > 0;
        technical.Visible = detailActions.Visible && expanded;
        copyDetails.Visible = expanded;
        detailsToggle.Text = english ? expanded ? "Hide Details" : "Show Details" : expanded ? "收起详情" : "查看详情";
        copyDetails.Text = english ? "Copy Details" : "复制详情";
    }

    /// <summary>保持用户当前宽度；高度随换行和详情变化，超过屏幕时由滚动容器承载。</summary>
    private void FitContent()
    {
        layout.PerformLayout();
        ClientSize = new Size(ClientSize.Width, Math.Clamp(layout.PreferredSize.Height, 210, Math.Max(210, Screen.FromControl(this).WorkingArea.Height - 100)));
    }

    /// <summary>高对比度始终使用系统颜色；普通主题只修改内容颜色。</summary>
    private void ApplyAppearance(bool dark)
    {
        // 系统绘制按钮、进度条和标题栏，避免替换原生焦点与无障碍行为。
        Color background = SystemInformation.HighContrast ? SystemColors.Window : dark ? Color.FromArgb(36, 36, 36) : SystemColors.Window;
        Color foreground = SystemInformation.HighContrast ? SystemColors.WindowText : dark ? Color.WhiteSmoke : SystemColors.WindowText;
        BackColor = layout.BackColor = technical.BackColor = background;
        ForeColor = technical.ForeColor = foreground;
        // 系统绘制按钮继续使用系统文字色，避免深色内容区继承白字导致浅色按钮不可读。
        primary.ForeColor = secondary.ForeColor = SystemColors.ControlText;
        detailsToggle.ForeColor = copyDetails.ForeColor = SystemColors.ControlText;
        detailsToggle.BackColor = copyDetails.BackColor = SystemColors.Control;
    }

    /// <summary>发送用户动作；隐藏类动作先隐藏窗口，业务按钮等待主进程返回状态。</summary>
    private void PerformAction(string action)
    {
        if (action.Length == 0) return;
        if (action is "later" or "close") Hide();
        else primary.Enabled = secondary.Enabled = false;
        Emit(action);
    }

    /// <summary>退出消息循环以释放安装目录文件；不会在此处执行应用重启。</summary>
    private void Quit()
    {
        quitting = true;
        Close();
        Application.ExitThread();
    }

    /// <summary>动作名保持与 AppKit 辅助程序相同，按钮文字不参与业务分派。</summary>
    private string Localized(string action) => action switch
    {
        "download" => english ? "Download Update" : "下载更新",
        "check" => english ? "Check for Updates" : "重新检查更新",
        "open_download_page" => english ? "Download New Version" : "下载新版",
        "open_installer" => english ? "Open Installer" : "打开安装包",
        "restart" => english ? "Restart Now" : "立即重启",
        "retry" => english ? "Try Again" : "重试",
        "reconnect" => english ? "Reconnect" : "重新连接",
        "later" => english ? "Later" : "稍后",
        "close" => english ? "Close" : "关闭",
        _ => "",
    };

    /// <summary>限制协议字段类型，缺失字段使用空文本。</summary>
    private static string GetText(JsonElement command, string name) => command.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";

    /// <summary>仅 JSON true 表示允许可选操作，不把字符串转换为授权。</summary>
    private static bool IsTrue(JsonElement command, string name) => command.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.True;

    /// <summary>标准输出只包含逐行 JSON 动作，错误信息使用标准错误。</summary>
    private static void Emit(string action)
    {
        Console.WriteLine(JsonSerializer.Serialize(new { action }));
        Console.Out.Flush();
    }
}
