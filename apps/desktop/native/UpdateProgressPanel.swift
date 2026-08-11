import AppKit
import Foundation

private final class UpdateProgressPanelController: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let panel: NSPanel
    private let titleLabel = NSTextField(labelWithString: "")
    private let detailLabel = NSTextField(wrappingLabelWithString: "")
    private let progressIndicator = NSProgressIndicator()
    private let progressLabel = NSTextField(labelWithString: "")
    private let secondaryButton = NSButton(title: "", target: nil, action: nil)
    private let primaryButton = NSButton(title: "", target: nil, action: nil)
    private var language = "zh-CN"
    private var awaitingRelaunch = false

    override init() {
        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 440, height: 210),
            styleMask: [.titled, .closable, .utilityWindow],
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

        titleLabel.font = NSFont.systemFont(ofSize: 15, weight: .semibold)
        titleLabel.maximumNumberOfLines = 1
        detailLabel.font = NSFont.systemFont(ofSize: 13)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.maximumNumberOfLines = 3
        progressIndicator.style = .bar
        progressIndicator.minValue = 0
        progressIndicator.maxValue = 1
        progressIndicator.isIndeterminate = true
        progressIndicator.startAnimation(nil)
        progressLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        progressLabel.textColor = .secondaryLabelColor
        progressLabel.alignment = .right

        secondaryButton.bezelStyle = .rounded
        secondaryButton.target = self
        secondaryButton.action = #selector(secondaryAction)
        primaryButton.bezelStyle = .rounded
        primaryButton.keyEquivalent = "\r"
        primaryButton.target = self
        primaryButton.action = #selector(primaryAction)

        let buttonRow = NSStackView(views: [secondaryButton, primaryButton])
        buttonRow.orientation = .horizontal
        buttonRow.alignment = .centerY
        buttonRow.spacing = 8
        buttonRow.setHuggingPriority(.required, for: .horizontal)

        let content = NSStackView(views: [titleLabel, detailLabel, progressIndicator, progressLabel, buttonRow])
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 10
        content.edgeInsets = NSEdgeInsets(top: 22, left: 24, bottom: 18, right: 24)
        content.translatesAutoresizingMaskIntoConstraints = false
        panel.contentView = content

        NSLayoutConstraint.activate([
            content.widthAnchor.constraint(equalToConstant: 440),
            titleLabel.widthAnchor.constraint(equalToConstant: 392),
            detailLabel.widthAnchor.constraint(equalToConstant: 392),
            progressIndicator.widthAnchor.constraint(equalToConstant: 392),
            progressLabel.widthAnchor.constraint(equalToConstant: 392),
            buttonRow.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
        ])
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
            showPanel()
        case "hide":
            panel.orderOut(nil)
        case "relaunch":
            guard let pid = command["pid"] as? Int,
                  let bundleId = command["bundleId"] as? String
            else { return }
            awaitingRelaunch = true
            waitForExitAndRelaunch(pid: Int32(pid), bundleId: bundleId)
        case "quit":
            NSApp.terminate(nil)
        default:
            break
        }
    }

    private func applyState(_ command: [String: Any]) {
        let state = command["state"] as? String ?? "checking"
        titleLabel.stringValue = command["title"] as? String ?? localized("softwareUpdate")
        detailLabel.stringValue = command["detail"] as? String ?? ""
        progressLabel.stringValue = command["progressText"] as? String ?? ""

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
            progressIndicator.isHidden = true
            progressLabel.isHidden = true
            setButtons(secondary: localized("later"), primary: localized("download"))
        case "ready":
            progressIndicator.isHidden = false
            progressLabel.isHidden = false
            progressIndicator.stopAnimation(nil)
            progressIndicator.isIndeterminate = false
            progressIndicator.doubleValue = 1
            setButtons(secondary: localized("later"), primary: localized("restart"))
        case "upToDate":
            progressIndicator.isHidden = true
            progressLabel.isHidden = true
            setButtons(secondary: nil, primary: localized("ok"))
        case "failed":
            progressIndicator.isHidden = true
            progressLabel.isHidden = false
            setButtons(secondary: localized("close"), primary: localized("retry"))
        case "installing":
            progressIndicator.isHidden = false
            progressLabel.isHidden = false
            setButtons(secondary: nil, primary: nil)
        default:
            progressIndicator.isHidden = false
            progressLabel.isHidden = false
            setButtons(secondary: nil, primary: nil)
        }
        if command["present"] as? Bool ?? true {
            showPanel()
        }
    }

    private func showPanel() {
        guard !panel.isVisible else { return }
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func setButtons(secondary: String?, primary: String?) {
        secondaryButton.isHidden = secondary == nil
        secondaryButton.title = secondary ?? ""
        primaryButton.isHidden = primary == nil
        primaryButton.title = primary ?? ""
    }

    @objc private func secondaryAction() {
        if primaryButton.title == localized("retry") {
            emit(action: "close")
        } else {
            panel.orderOut(nil)
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
        default:
            panel.orderOut(nil)
            emit(action: "close")
        }
    }

    private func localized(_ key: String) -> String {
        let english = language == "en-US"
        switch key {
        case "softwareUpdate": return english ? "Software Update" : "软件更新"
        case "later": return english ? "Later" : "稍后"
        case "download": return english ? "Download Update" : "下载更新"
        case "restart": return english ? "Restart Now" : "立即重启"
        case "ok": return english ? "OK" : "好"
        case "close": return english ? "Close" : "关闭"
        case "retry": return english ? "Try Again" : "重试"
        default: return key
        }
    }

    private func emit(action: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["action": action]),
              let line = String(data: data, encoding: .utf8)
        else { return }
        FileHandle.standardOutput.write(Data("\(line)\n".utf8))
    }

    private func waitForExitAndRelaunch(pid: Int32, bundleId: String) {
        panel.orderOut(nil)
        DispatchQueue.global(qos: .userInitiated).async {
            let deadline = Date().addingTimeInterval(120)
            while Date() < deadline && kill(pid, 0) == 0 {
                Thread.sleep(forTimeInterval: 0.2)
            }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            process.arguments = ["-b", bundleId]
            try? process.run()
            DispatchQueue.main.async {
                NSApp.terminate(nil)
            }
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
