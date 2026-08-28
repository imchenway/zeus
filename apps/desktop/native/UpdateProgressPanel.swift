import AppKit
import Foundation

private final class UpdateProgressPanelController: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let panel: NSPanel
    private let titleLabel = NSTextField(labelWithString: "")
    private let detailLabel = NSTextField(wrappingLabelWithString: "")
    private let progressCaptionLabel = NSTextField(labelWithString: "")
    private let progressIndicator = NSProgressIndicator()
    private let progressLabel = NSTextField(labelWithString: "")
    private let progressRow = NSStackView()
    private let detailsButton = NSButton(title: "", target: nil, action: nil)
    private let copyDetailsButton = NSButton(title: "", target: nil, action: nil)
    private let detailsActionRow = NSStackView()
    private let technicalDetailsView = NSTextView()
    private let technicalDetailsScrollView = NSScrollView()
    private let secondaryButton = NSButton(title: "", target: nil, action: nil)
    private let primaryButton = NSButton(title: "", target: nil, action: nil)
    private let buttonRow = NSStackView()
    private let contentStack = NSStackView()
    private var language = "zh-CN"
    private var awaitingRelaunch = false
    private var currentState = "checking"
    private var technicalDetail = ""
    private var detailsExpanded = false

    override init() {
        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 176),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        super.init()
        configurePanel()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        readCommands()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        panel.orderOut(nil)
        emit(action: "closed")
        return false
    }

    private func configurePanel() {
        panel.title = "Zeus"
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.fullScreenAuxiliary, .moveToActiveSpace]
        panel.delegate = self
        panel.tabbingMode = .disallowed
        panel.contentMinSize = NSSize(width: 440, height: 136)
        panel.contentMaxSize = NSSize(width: 760, height: 540)

        titleLabel.font = NSFont.systemFont(ofSize: 17, weight: .semibold)
        titleLabel.maximumNumberOfLines = 1
        detailLabel.font = NSFont.systemFont(ofSize: 13)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.maximumNumberOfLines = 3
        progressCaptionLabel.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        progressCaptionLabel.textColor = .secondaryLabelColor
        progressCaptionLabel.lineBreakMode = .byTruncatingTail
        progressIndicator.style = .bar
        progressIndicator.controlSize = .small
        progressIndicator.minValue = 0
        progressIndicator.maxValue = 1
        progressIndicator.isIndeterminate = true
        progressIndicator.startAnimation(nil)
        progressLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        progressLabel.textColor = .secondaryLabelColor
        progressLabel.alignment = .right
        progressLabel.setContentHuggingPriority(.required, for: .horizontal)
        progressLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        let progressSpacer = NSView()
        progressSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        progressSpacer.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        progressRow.setViews([progressCaptionLabel, progressSpacer, progressLabel], in: .leading)
        progressRow.orientation = .horizontal
        progressRow.alignment = .centerY
        progressRow.spacing = 8

        detailsButton.bezelStyle = .inline
        detailsButton.controlSize = .small
        detailsButton.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        detailsButton.contentTintColor = .secondaryLabelColor
        detailsButton.target = self
        detailsButton.action = #selector(toggleDetails)
        copyDetailsButton.bezelStyle = .inline
        copyDetailsButton.controlSize = .small
        copyDetailsButton.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        copyDetailsButton.contentTintColor = .secondaryLabelColor
        copyDetailsButton.target = self
        copyDetailsButton.action = #selector(copyDetails)

        let detailsSpacer = NSView()
        detailsSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        detailsSpacer.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        detailsActionRow.setViews([detailsButton, detailsSpacer, copyDetailsButton], in: .leading)
        detailsActionRow.orientation = .horizontal
        detailsActionRow.alignment = .centerY
        detailsActionRow.spacing = 8

        technicalDetailsView.isEditable = false
        technicalDetailsView.isSelectable = true
        technicalDetailsView.drawsBackground = false
        technicalDetailsView.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        technicalDetailsView.textColor = .secondaryLabelColor
        technicalDetailsView.textContainerInset = NSSize(width: 8, height: 7)
        technicalDetailsView.isHorizontallyResizable = false
        technicalDetailsView.isVerticallyResizable = true
        technicalDetailsView.autoresizingMask = [.width]
        technicalDetailsView.textContainer?.widthTracksTextView = true
        technicalDetailsScrollView.documentView = technicalDetailsView
        technicalDetailsScrollView.borderType = .lineBorder
        technicalDetailsScrollView.hasVerticalScroller = true
        technicalDetailsScrollView.drawsBackground = false

        secondaryButton.bezelStyle = .rounded
        secondaryButton.controlSize = .regular
        secondaryButton.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        secondaryButton.target = self
        secondaryButton.action = #selector(secondaryAction)
        primaryButton.bezelStyle = .rounded
        primaryButton.controlSize = .regular
        primaryButton.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        primaryButton.keyEquivalent = "\r"
        primaryButton.target = self
        primaryButton.action = #selector(primaryAction)

        let buttonSpacer = NSView()
        buttonSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        buttonSpacer.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        buttonRow.setViews([buttonSpacer, secondaryButton, primaryButton], in: .leading)
        buttonRow.orientation = .horizontal
        buttonRow.alignment = .centerY
        buttonRow.spacing = 8

        contentStack.setViews([titleLabel, detailLabel, progressRow, progressIndicator, detailsActionRow, technicalDetailsScrollView, buttonRow], in: .leading)
        contentStack.orientation = .vertical
        contentStack.alignment = .leading
        contentStack.spacing = 11
        contentStack.detachesHiddenViews = true
        contentStack.translatesAutoresizingMaskIntoConstraints = false

        let contentView = NSView()
        panel.contentView = contentView
        contentView.addSubview(contentStack)

        NSLayoutConstraint.activate([
            contentStack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 20),
            contentStack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 24),
            contentStack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -24),
            contentStack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -18),
            titleLabel.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
            detailLabel.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
            progressRow.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
            progressIndicator.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
            detailsActionRow.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
            technicalDetailsScrollView.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
            technicalDetailsScrollView.heightAnchor.constraint(equalToConstant: 112),
            buttonRow.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
            secondaryButton.heightAnchor.constraint(equalToConstant: 30),
            secondaryButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 76),
            primaryButton.heightAnchor.constraint(equalToConstant: 30),
            primaryButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 76),
        ])
        detailsActionRow.isHidden = true
        technicalDetailsScrollView.isHidden = true
        setButtons(secondary: nil, primary: nil)
    }

    private func readCommands() {
        DispatchQueue.global(qos: .userInitiated).async {
            while let line = readLine() {
                guard let data = line.data(using: .utf8),
                      let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else { continue }
                DispatchQueue.main.async { [weak self] in
                    self?.handle(value)
                }
            }
            DispatchQueue.main.async { [weak self] in
                if self?.awaitingRelaunch != true {
                    NSApp.terminate(nil)
                }
            }
        }
    }

    private func handle(_ command: [String: Any]) {
        guard let type = command["type"] as? String else { return }
        if let nextLanguage = command["language"] as? String {
            language = nextLanguage == "en-US" ? "en-US" : "zh-CN"
        }
        switch type {
        case "state":
            applyState(command)
        case "show":
            showPanel(activating: true)
        case "hide":
            panel.orderOut(nil)
        case "relaunch":
            guard let pid = command["pid"] as? Int,
                  let appPath = command["appPath"] as? String,
                  let bundleId = command["bundleId"] as? String,
                  let version = command["version"] as? String
            else { return }
            awaitingRelaunch = true
            waitForExitAndRelaunch(pid: Int32(pid), appPath: appPath, bundleId: bundleId, version: version)
        case "quit":
            NSApp.terminate(nil)
        default:
            break
        }
    }

    private func applyState(_ command: [String: Any]) {
        let state = command["state"] as? String ?? "checking"
        currentState = state
        titleLabel.stringValue = command["title"] as? String ?? localized("softwareUpdate")
        detailLabel.stringValue = command["detail"] as? String ?? ""
        progressCaptionLabel.stringValue = command["progressCaption"] as? String ?? ""
        progressLabel.stringValue = command["progressText"] as? String ?? ""
        updateTechnicalDetail(command["technicalDetail"] as? String ?? "")

        if let progress = command["progress"] as? Double {
            progressIndicator.stopAnimation(nil)
            progressIndicator.isIndeterminate = false
            progressIndicator.doubleValue = min(max(progress, 0), 1)
        } else {
            progressIndicator.isIndeterminate = true
            progressIndicator.startAnimation(nil)
        }

        switch state {
        case "available":
            progressRow.isHidden = true
            progressIndicator.isHidden = true
            setButtons(secondary: localized("later"), primary: localized("download"))
        case "downloading":
            progressRow.isHidden = false
            progressIndicator.isHidden = false
            setButtons(secondary: command["canReconnect"] as? Bool == true ? localized("reconnect") : nil, primary: nil)
        case "ready":
            progressRow.isHidden = true
            progressIndicator.isHidden = true
            setButtons(secondary: localized("later"), primary: localized("restart"))
        case "upToDate":
            progressRow.isHidden = true
            progressIndicator.isHidden = true
            setButtons(secondary: nil, primary: localized("ok"))
        case "failed":
            progressRow.isHidden = true
            progressIndicator.isHidden = true
            setButtons(secondary: localized("close"), primary: localized("retry"))
        case "installing":
            progressRow.isHidden = false
            progressIndicator.isHidden = false
            setButtons(secondary: nil, primary: nil)
        default:
            progressRow.isHidden = false
            progressIndicator.isHidden = false
            setButtons(secondary: nil, primary: nil)
        }
        refreshDetailsControls()
        fitPanelToContent(animated: panel.isVisible)
        if command["present"] as? Bool ?? true {
            showPanel(activating: false)
        }
    }

    /** 只有用户显式打开时才激活窗口；进度刷新不得抢占其他窗口的键盘焦点。 */
    private func showPanel(activating: Bool) {
        if activating {
            if panel.isMiniaturized {
                panel.deminiaturize(nil)
            }
            if !panel.isVisible {
                panel.center()
            }
            panel.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        guard !panel.isVisible, !panel.isMiniaturized else { return }
        panel.center()
        panel.orderFront(nil)
    }

    private func setButtons(secondary: String?, primary: String?) {
        secondaryButton.isHidden = secondary == nil
        secondaryButton.isEnabled = true
        secondaryButton.title = secondary ?? ""
        primaryButton.isHidden = primary == nil
        primaryButton.title = primary ?? ""
        buttonRow.isHidden = secondary == nil && primary == nil
    }

    @objc private func secondaryAction() {
        if currentState == "downloading" {
            secondaryButton.isEnabled = false
            emit(action: "reconnect")
            return
        }
        panel.orderOut(nil)
        if currentState == "failed" {
            emit(action: "close")
        } else {
            emit(action: "later")
        }
    }

    @objc private func primaryAction() {
        switch primaryButton.title {
        case localized("download"):
            emit(action: "download")
        case localized("restart"):
            emit(action: "restart")
        case localized("retry"):
            emit(action: "retry")
        case localized("close"):
            NSApp.terminate(nil)
        default:
            panel.orderOut(nil)
            emit(action: "close")
        }
    }

    @objc private func toggleDetails() {
        detailsExpanded.toggle()
        refreshDetailsControls()
        fitPanelToContent(animated: true)
    }

    @objc private func copyDetails() {
        guard !technicalDetail.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(technicalDetail, forType: .string)
        copyDetailsButton.title = localized("copied")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { [weak self] in
            guard let self, !self.copyDetailsButton.isHidden else { return }
            self.copyDetailsButton.title = self.localized("copyDetails")
        }
    }

    private func updateTechnicalDetail(_ nextDetail: String) {
        if technicalDetail != nextDetail {
            detailsExpanded = false
        }
        technicalDetail = nextDetail
        technicalDetailsView.string = nextDetail
    }

    private func refreshDetailsControls() {
        let canShowDetails = currentState == "failed" && !technicalDetail.isEmpty
        detailsActionRow.isHidden = !canShowDetails
        technicalDetailsScrollView.isHidden = !canShowDetails || !detailsExpanded
        detailsButton.title = localized(detailsExpanded ? "hideDetails" : "showDetails")
        detailsButton.image = NSImage(systemSymbolName: detailsExpanded ? "chevron.down" : "chevron.right", accessibilityDescription: nil)
        detailsButton.imagePosition = .imageLeading
        copyDetailsButton.title = localized("copyDetails")
        copyDetailsButton.isHidden = !detailsExpanded
    }

    private func fitPanelToContent(animated: Bool) {
        guard let contentView = panel.contentView else { return }
        contentView.layoutSubtreeIfNeeded()
        let targetContentHeight = min(max(contentStack.fittingSize.height + 38, panel.contentMinSize.height), panel.contentMaxSize.height)
        let currentContentWidth = min(max(panel.contentLayoutRect.width, panel.contentMinSize.width), panel.contentMaxSize.width)
        let targetFrame = panel.frameRect(forContentRect: NSRect(x: 0, y: 0, width: currentContentWidth, height: targetContentHeight))
        var nextFrame = panel.frame
        let topEdge = nextFrame.maxY
        nextFrame.size.height = targetFrame.height
        nextFrame.origin.y = topEdge - targetFrame.height
        panel.setFrame(nextFrame, display: true, animate: animated)
    }

    private func localized(_ key: String) -> String {
        let english = language == "en-US"
        switch key {
        case "softwareUpdate": return english ? "Software Update" : "软件更新"
        case "later": return english ? "Later" : "稍后"
        case "download": return english ? "Download Update" : "下载更新"
        case "reconnect": return english ? "Reconnect" : "重新连接"
        case "restart": return english ? "Restart Now" : "立即重启"
        case "ok": return english ? "OK" : "好"
        case "close": return english ? "Close" : "关闭"
        case "retry": return english ? "Try Again" : "重试"
        case "showDetails": return english ? "Show Details" : "查看详情"
        case "hideDetails": return english ? "Hide Details" : "收起详情"
        case "copyDetails": return english ? "Copy Details" : "复制详情"
        case "copied": return english ? "Copied" : "已复制"
        case "relaunchFailed": return english ? "The Updated Zeus Could Not Be Opened" : "无法打开更新后的 Zeus"
        default: return key
        }
    }

    private func emit(action: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["action": action]),
              let line = String(data: data, encoding: .utf8)
        else { return }
        FileHandle.standardOutput.write(Data("\(line)\n".utf8))
    }

    private func waitForExitAndRelaunch(pid: Int32, appPath: String, bundleId: String, version: String) {
        panel.orderOut(nil)
        DispatchQueue.global(qos: .userInitiated).async {
            let deadline = Date().addingTimeInterval(120)
            while Date() < deadline && kill(pid, 0) == 0 {
                Thread.sleep(forTimeInterval: 0.2)
            }
            guard kill(pid, 0) != 0 else {
                self.showRelaunchFailure(self.language == "en-US" ? "The previous Zeus process did not exit in time." : "原 Zeus 进程未能及时退出。")
                return
            }
            let appURL = URL(fileURLWithPath: appPath).standardizedFileURL
            guard let validationFailure = self.validateRelaunchTarget(appURL: appURL, bundleId: bundleId, version: version) else {
                let configuration = NSWorkspace.OpenConfiguration()
                configuration.activates = true
                // 禁止 macOS 用另一位置已经运行的同身份应用替代本次精确更新目标。
                configuration.allowsRunningApplicationSubstitution = false
                NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { [weak self] application, error in
                    guard let self else { return }
                    if let error {
                        self.showRelaunchFailure(error.localizedDescription)
                        return
                    }
                    guard let runningURL = application?.bundleURL?.standardizedFileURL,
                          runningURL.resolvingSymlinksInPath().path == appURL.resolvingSymlinksInPath().path,
                          application?.bundleIdentifier == bundleId,
                          self.validateRelaunchTarget(appURL: runningURL, bundleId: bundleId, version: version) == nil
                    else {
                        self.showRelaunchFailure(self.language == "en-US" ? "macOS did not open the Zeus app that was just updated." : "macOS 未启动刚刚更新的 Zeus App。")
                        return
                    }
                    DispatchQueue.main.async {
                        NSApp.terminate(nil)
                    }
                }
                return
            }
            self.showRelaunchFailure(validationFailure)
        }
    }

    /** 旧进程退出后再次读取磁盘身份，禁止路径在安装复验与重启之间发生漂移。 */
    private func validateRelaunchTarget(appURL: URL, bundleId: String, version: String) -> String? {
        var isDirectory: ObjCBool = false
        guard appURL.pathExtension == "app",
              FileManager.default.fileExists(atPath: appURL.path, isDirectory: &isDirectory),
              isDirectory.boolValue,
              let bundle = Bundle(url: appURL)
        else {
            return language == "en-US" ? "The updated Zeus app is missing." : "刚刚更新的 Zeus App 不存在。"
        }
        let actualBundleId = bundle.bundleIdentifier ?? ""
        let shortVersion = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let bundleVersion = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        guard actualBundleId == bundleId, shortVersion == version, bundleVersion == version else {
            return language == "en-US"
                ? "The updated Zeus app identity or version does not match the completed update."
                : "刚刚更新的 Zeus App 身份或版本与本次更新不一致。"
        }
        return nil
    }

    private func showRelaunchFailure(_ reason: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.currentState = "failed"
            self.titleLabel.stringValue = self.localized("relaunchFailed")
            self.detailLabel.stringValue = self.language == "en-US"
                ? "The update was installed, but the updated Zeus could not be opened."
                : "更新已经安装，但新版 Zeus 未能打开。"
            self.updateTechnicalDetail(reason)
            self.progressIndicator.stopAnimation(nil)
            self.progressIndicator.isHidden = true
            self.progressRow.isHidden = true
            self.setButtons(secondary: nil, primary: self.localized("close"))
            self.refreshDetailsControls()
            self.fitPanelToContent(animated: false)
            self.showPanel(activating: true)
        }
    }
}

@main
private enum UpdateProgressPanelApplication {
    static func main() {
        let application = NSApplication.shared
        let controller = UpdateProgressPanelController()
        application.delegate = controller
        application.run()
    }
}
