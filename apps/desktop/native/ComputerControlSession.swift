import AppKit
import CoreImage
import ScreenCaptureKit

/** 标准输出同时承载请求响应和系统停止通知，整行写入避免相互拼接。 */
private let computerOutputLock = NSLock()

/** 串行输出一条完整的原生服务消息。 */
func writeComputerOutput(_ data: Data) {
    computerOutputLock.withLock {
        FileHandle.standardOutput.write(data + Data([0x0a]))
    }
}

/** 固定窗口身份及其全局逻辑坐标；截图像素通过 scale 换算。 */
struct ComputerWindowTarget {
    /** 宿主签发的控制身份。 */
    let sessionId: String
    /** 目标进程，不能由坐标切换。 */
    let pid: pid_t
    /** WindowServer 的窗口编号。 */
    let windowId: CGWindowID
    /** 全局逻辑坐标，原点位于主屏左上。 */
    let frame: CGRect
    /** 该窗口实际所在显示器的像素比例。 */
    let scale: CGFloat

    /** 将同一坐标映射同时提供给模型、截图和输入。 */
    var metadata: [String: Any] {
        ["window_id": windowId, "frame": ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height], "scale": scale]
    }
}

/** 虚拟光标不成为键盘或主窗口，用户工作焦点始终留在原应用。 */
private final class ComputerCursorPanel: NSPanel {
    /** 光标不接收打字焦点。 */
    override var canBecomeKey: Bool { false }
    /** 禁止成为主窗口。 */
    override var canBecomeMain: Bool { false }
}

/** 一个控制轮次复用一个窗口采集流；锁保护回调、工具线程与主线程之间的撤销状态。 */
// 跨线程仅共享 lock 保护的控制状态；视图及 NSEvent 监听只在主线程访问。
final class ComputerControlSession: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    /** 对共享状态的短同步保护，不在持锁时等待系统调用。 */
    private let lock = NSLock()
    /** 唯一目标窗口。 */
    private var target: ComputerWindowTarget?
    /** 持续采集触发 macOS 自身的屏幕共享状态入口。 */
    private var capture: SCStream?
    /** 最近一个有效帧；队列和缓存均有界。 */
    private var image: CGImage?
    /** 完整或空闲帧的时间；空闲帧明确表示窗口内容未变化。 */
    private var frameDate = Date.distantPast
    /** 最近一次完整像素帧的采集时间；空闲确认不能改写成重新采集。 */
    private var imageDate = Date.distantPast
    /** 输入后的截图必须晚于该时间。 */
    private var mutationTime = CMTime.zero
    /** 使用采集帧原始时间戳，防止动作后才到达的旧帧被误认为新画面。 */
    private var frameTime = CMTime.invalid
    /** 供会话内预览使用的有界缩略图，不写入磁盘或另开采集流。 */
    private var previewData: Data?
    /** 用户接管目标窗口时暂让输入，空闲后恢复观察资格。 */
    private var paused = false
    /** 接管空闲窗口使用单调时钟，避免系统校时影响恢复。 */
    private var lastUserInput = 0.0
    /** 连续空闲三秒后允许重新观察；明确停止始终不可自动恢复。 */
    private let userIdleInterval = 3.0
    /** 记住目标窗口内按下的实体键，长按不能被当成空闲。 */
    private var userKeys = Set<CGKeyCode>()
    /** 拖拽越出窗口后仍等待实体按钮释放。 */
    private var userButtons = Set<UInt32>()
    /** 继续或窗口移动后，必须重新观察才能输入。 */
    private var needsObservation = true
    /** 原生停止先锁住输入，再通知宿主释放 Helper。 */
    private var stopped = false
    /** 仅保存本服务尚未释放的虚拟按键或按钮；停止与用户接管时归还给目标应用。 */
    private var pendingReleases: [String: (CGEvent, pid_t)] = [:]
    /** 采集回调使用单独串行队列，最多保留系统配置的两帧。 */
    private let frameQueue = DispatchQueue(label: "dev.hypha.zeus.computer.frames")
    /** Core Image 上下文复用，避免每帧创建 GPU 资源。 */
    private let imageContext = CIContext(options: [.cacheIntermediates: false])
    /** 仅可见目标区域内展示光标，不拦截鼠标。 */
    private var cursorPanel: ComputerCursorPanel?
    /** 当前虚拟光标的全局逻辑坐标。 */
    private var cursorPoint: CGPoint?
    /** 目标窗口物理输入监听，不因用户操作其他应用而暂停。 */
    private var inputMonitor: Any?
    /** 目标退出和窗口失效的有限频率检查。 */
    private var lifecycleTimer: Timer?
    /** 预览的产品文字，不含模型提供的参数。 */
    private var targetLabel = ""
    /** 系统录屏提示在部分 macOS 布局中只有圆点，独立提供明确的 Zeus 控制与停止入口。 */
    private var statusItem: NSStatusItem?
    /** 菜单中的当前控制状态，与预览共用同一状态源。 */
    private var statusCaption: NSMenuItem?
    /** 用户也可从菜单栏继续暂停的控制，模型没有该恢复入口。 */
    private var resumeItem: NSMenuItem?

    /** 观察时固定窗口；切换应用或显式窗口编号才创建新的采集对象。 */
    func observe(app: NSRunningApplication, sessionId: String, windowId: CGWindowID?) async throws -> ComputerWindowTarget {
        guard !sessionId.isEmpty else { throw ServiceFailure(code: "ZEUS_COMPUTER_SESSION_REQUIRED", message: "缺少宿主控制身份。") }
        guard CGPreflightScreenCaptureAccess() else { throw ServiceFailure(code: "ZEUS_COMPUTER_SCREEN_CAPTURE_PERMISSION_REQUIRED", message: "开始控制需要屏幕录制权限，以显示真实的控制状态。") }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let windows = content.windows.filter { $0.owningApplication?.processID == app.processIdentifier && $0.windowLayer == 0 && $0.frame.width > 1 && $0.frame.height > 1 }
        let previous = lock.withLock { target }
        let selectedId = windowId ?? (previous?.pid == app.processIdentifier ? previous?.windowId : nil)
        // 多窗口优先匹配应用公开的焦点窗口；无法确认时要求明确编号，禁止猜测第一项。
        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        var focusedValue: CFTypeRef?
        _ = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &focusedValue)
        var focusedTitle: CFTypeRef?
        if let focusedValue, CFGetTypeID(focusedValue) == AXUIElementGetTypeID() {
            _ = AXUIElementCopyAttributeValue(focusedValue as! AXUIElement, kAXTitleAttribute as CFString, &focusedTitle)
        }
        let titleMatches = windows.filter { !$0.title.isNilOrEmpty && $0.title == focusedTitle as? String }
        guard let window = selectedId.flatMap({ id in windows.first { $0.windowID == id } }) ?? (selectedId == nil ? (windows.count == 1 ? windows.first : titleMatches.count == 1 ? titleMatches.first : nil) : nil) else {
            let choices = windows.map { "\($0.windowID): \($0.title ?? "未命名窗口")" }.joined(separator: "；")
            throw ServiceFailure(code: "ZEUS_COMPUTER_WINDOW_REQUIRED", message: "无法确认目标窗口，请通过 window_id 指定。可用窗口：\(choices)")
        }
        // 显示器坐标来自同一 WindowServer 坐标系，不使用所有屏幕中的最大比例。
        let display = content.displays.max { first, second in first.frame.intersection(window.frame).area < second.frame.intersection(window.frame).area }
        let scale = await MainActor.run {
            NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == display?.displayID }?.backingScaleFactor ?? 1
        }
        let next = ComputerWindowTarget(sessionId: sessionId, pid: app.processIdentifier, windowId: window.windowID, frame: window.frame, scale: scale)
        let existing = try lock.withLock { () throws -> SCStream? in
            if stopped { throw ServiceFailure(code: "ZEUS_COMPUTER_STOPPED", message: "本轮控制已停止。") }
            if let previous, previous.sessionId != sessionId { throw ServiceFailure(code: "ZEUS_COMPUTER_SESSION_MISMATCH", message: "控制身份已失效。") }
            return capture
        }
        if previous?.windowId != next.windowId || previous?.frame != next.frame || previous?.scale != next.scale || existing == nil {
            // 先脱离旧流，迟到的旧流停止回调不会撤销新窗口。
            lock.withLock { capture = nil; image = nil; previewData = nil; frameDate = .distantPast; imageDate = .distantPast; frameTime = .invalid; needsObservation = true }
            if let existing { try await existing.stopCapture() }
            let configuration = SCStreamConfiguration()
            configuration.width = max(1, Int(next.frame.width * scale))
            configuration.height = max(1, Int(next.frame.height * scale))
            configuration.showsCursor = false
            configuration.queueDepth = 2
            configuration.minimumFrameInterval = CMTime(value: 1, timescale: 2)
            // 忽略窗口阴影，使图像原点、尺寸和输入坐标一致。
            if #available(macOS 14.0, *) { configuration.ignoreShadowsSingleWindow = true }
            let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: window), configuration: configuration, delegate: self)
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: frameQueue)
            try lock.withLock {
                guard !stopped else { throw ServiceFailure(code: "ZEUS_COMPUTER_STOPPED", message: "本轮控制已停止。") }
                target = next; capture = stream
            }
            // 将当前流接入系统共享菜单；禁止从菜单新增流或切到未经观察的窗口。
            await MainActor.run {
                if #available(macOS 14.0, *) {
                    let picker = SCContentSharingPicker.shared
                    var configuration = SCContentSharingPickerConfiguration()
                    configuration.allowedPickerModes = [.singleWindow]
                    configuration.allowsChangingSelectedContent = false
                    picker.setConfiguration(configuration, for: stream)
                    picker.maximumStreamCount = 0
                    picker.isActive = true
                }
            }
            do { try await stream.startCapture() }
            catch { self.stream(stream, didStopWithError: error); throw error }
        }
        try lock.withLock {
            if stopped { throw ServiceFailure(code: "ZEUS_COMPUTER_STOPPED", message: "本轮控制已停止。") }
            guard capture != nil, target?.windowId == next.windowId, target?.pid == next.pid else {
                throw ServiceFailure(code: "ZEUS_COMPUTER_OBSERVATION_REQUIRED", message: "目标窗口或采集已变化，请重新观察。")
            }
            if !paused { needsObservation = false }
        }
        await MainActor.run {
            // 切换受控窗口时清除上个窗口的虚拟光标，避免新预览继承旧落点。
            if previous?.windowId != next.windowId || previous?.pid != next.pid {
                self.cursorPoint = nil
                self.cursorPanel?.orderOut(nil)
            }
            self.targetLabel = app.localizedName ?? "目标应用"
            self.showControls()
        }
        return next
    }

    /** 工具线程的输入闸门；窗口关闭、移动、暂停或撤销时均不投递输入。 */
    func requireTarget(pid: pid_t, sessionId: String) throws -> ComputerWindowTarget {
        let current = try lock.withLock { () throws -> ComputerWindowTarget in
            guard !stopped, capture != nil, let target, target.pid == pid, target.sessionId == sessionId else { throw ServiceFailure(code: "ZEUS_COMPUTER_OBSERVATION_REQUIRED", message: "请先观察当前应用窗口，不能直接开始输入。") }
            guard !paused else { throw ServiceFailure(code: "ZEUS_COMPUTER_PAUSED", message: "用户正在操作目标窗口；宿主会等待空闲后返回，请保留任务并重新观察，不能重放旧动作。") }
            guard !needsObservation else { throw ServiceFailure(code: "ZEUS_COMPUTER_OBSERVATION_REQUIRED", message: "窗口位置或用户控制状态已变化，请重新观察。") }
            return target
        }
        guard windowFrame(current.windowId) == current.frame else { throw ServiceFailure(code: "ZEUS_COMPUTER_WINDOW_CHANGED", message: "目标窗口已移动或关闭，请重新观察。") }
        return current
    }

    /** 输入发生后作废旧帧；下一张模型截图等待采集确认内容。 */
    func didMutate() { lock.withLock { mutationTime = CMClockGetTime(CMClockGetHostTimeClock()) } }

    /** 检查与投递在同一把锁内完成，停止不能插入检查和鼠标按下之间。 */
    func postInput(_ event: CGEvent, pid: pid_t, sessionId: String) throws {
        try lock.withLock {
            guard !stopped, target?.pid == pid, target?.sessionId == sessionId else {
                throw ServiceFailure(code: "ZEUS_COMPUTER_STOPPED", message: "输入投递前控制状态已改变，请停止并重新观察，不能重放动作。")
            }
            guard !paused else { throw ServiceFailure(code: "ZEUS_COMPUTER_PAUSED", message: "用户接管中，动作可能已部分投递；等待空闲后重新观察，不能重放。") }
            guard !needsObservation else { throw ServiceFailure(code: "ZEUS_COMPUTER_OBSERVATION_REQUIRED", message: "输入前窗口状态已变化，请重新观察，不能重放动作。") }
            let type = event.type
            let mouse = [.leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .leftMouseUp, .rightMouseUp, .otherMouseUp] as [CGEventType]
            if mouse.contains(type) {
                let button = event.getIntegerValueField(.mouseEventButtonNumber)
                let key = "mouse-\(button)"
                if [.leftMouseUp, .rightMouseUp, .otherMouseUp].contains(type) { pendingReleases.removeValue(forKey: key) }
                else if let release = event.copy() {
                    release.type = button == 1 ? .rightMouseUp : button == 2 ? .otherMouseUp : .leftMouseUp
                    pendingReleases[key] = (release, pid)
                }
            } else if type == .keyDown || type == .keyUp {
                let key = "key-\(event.getIntegerValueField(.keyboardEventKeycode))"
                if type == .keyUp { pendingReleases.removeValue(forKey: key) }
                else if let release = event.copy() { release.type = .keyUp; release.flags = []; pendingReleases[key] = (release, pid) }
            }
            event.postToPid(pid)
        }
    }

    /** 只发送清理用的抬起事件，不恢复已撤销的操作权限。 */
    private func releaseInput() {
        let releases = lock.withLock { let values = Array(pendingReleases.values); pendingReleases.removeAll(); return values }
        for (event, pid) in releases { event.postToPid(pid) }
    }

    /** 将接管状态附在观察结果中；读取状态不会绕过空闲等待。 */
    var status: [String: Any] {
        lock.withLock { ["active": !stopped && capture != nil, "paused": paused, "needs_observation": needsObservation] }
    }

    /** 帧须晚于动作和控件回读；分别返回像素采集及内容未变化确认的时间。 */
    func snapshot(notBefore: CMTime) async throws -> (CGImage, ComputerWindowTarget, Date, Date) {
        let deadline = Date().addingTimeInterval(4)
        while Date() < deadline {
            let current = try lock.withLock { () throws -> (CGImage, ComputerWindowTarget, Date, Date)? in
                guard !stopped else { throw ServiceFailure(code: "ZEUS_COMPUTER_STOPPED", message: "控制已停止。") }
                guard let image, let target, frameTime.isValid, CMTimeCompare(frameTime, mutationTime) >= 0, CMTimeCompare(frameTime, notBefore) >= 0 else { return nil }
                return (image, target, imageDate, frameDate)
            }
            if let current { return current }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw ServiceFailure(code: "ZEUS_COMPUTER_FRAME_UNAVAILABLE", message: "窗口采集尚未产生有效的新帧，不能使用动作前的旧截图。")
    }

    /** 持续帧回调只缓存最后一帧；停止后的迟到帧不进入任何视图或截图。 */
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let rawStatus = attachments.first?[.status] as? Int, let status = SCFrameStatus(rawValue: rawStatus) else { return }
        if [.blank, .suspended, .stopped].contains(status) {
            // 帧状态不代表用户撤权；明确的停止原因由采集结束回调处理。
            /** 迟到的旧流空帧不能清理新窗口正在进行的输入。 */
            let invalidated = lock.withLock { () -> Bool in
                guard capture === stream && !stopped else { return false }
                image = nil; previewData = nil; frameTime = .invalid; needsObservation = true
                return true
            }
            if invalidated { releaseInput() }
            return
        }
        // 将原始单调帧时间换算为采集时刻，避免把队列送达时间误当成截图时间。
        let sampleTime = sampleBuffer.presentationTimeStamp
        guard sampleTime.isValid else { return }
        let sampledAt = Date(timeIntervalSinceNow: -CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), sampleTime)))
        if status == .idle {
            lock.withLock { if capture === stream && !stopped && image != nil { frameDate = sampledAt; frameTime = sampleTime } }
            return
        }
        guard status == .complete, let buffer = sampleBuffer.imageBuffer else { return }
        let ciImage = CIImage(cvPixelBuffer: buffer)
        guard let frame = imageContext.createCGImage(ciImage, from: ciImage.extent) else { return }
        // 预览最长边限制为 640 像素，标准输出不传输完整窗口的 PNG。
        let ratio = min(1, 640 / max(ciImage.extent.width, ciImage.extent.height))
        let reduced = ciImage.transformed(by: CGAffineTransform(scaleX: ratio, y: ratio))
        let thumbnail = imageContext.createCGImage(reduced, from: reduced.extent).flatMap {
            NSBitmapImageRep(cgImage: $0).representation(using: .jpeg, properties: [.compressionFactor: 0.7])
        }
        lock.withLock {
            guard capture === stream && !stopped else { return }
            image = frame; previewData = thumbnail; imageDate = sampledAt; frameDate = sampledAt; frameTime = sampleTime
        }
    }

    /** 用户取消共享才撤销整轮；采集故障只作废旧目标，允许重新观察。 */
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        /** 使用系统给出的明确原因区分用户停止和采集故障。 */
        let failure = error as NSError
        if failure.domain == SCStreamErrorDomain && [SCStreamError.Code.userStopped.rawValue, SCStreamError.Code.userDeclined.rawValue].contains(failure.code) {
            stop(reason: "system_capture_stopped", stream: stream)
        } else {
            invalidateCapture(stream)
        }
    }

    /** 窗口关闭或采集失败只作废观察；下一次观察重建采集，旧动作不会自动重放。 */
    private func invalidateCapture(_ stream: SCStream) {
        /** 同一把锁确认流身份并清理，迟到的旧流事件不能使新窗口失效。 */
        let invalidated = lock.withLock { () -> Bool in
            guard !stopped, capture === stream else { return false }
            capture = nil; image = nil; previewData = nil; frameTime = .invalid; paused = false; needsObservation = true
            return true
        }
        guard invalidated else { return }
        releaseInput()
        DispatchQueue.main.async { [weak self] in self?.cursorPanel?.orderOut(nil); self?.publishPreview() }
        Task { try? await stream.stopCapture() }
    }

    /** 停止不依赖模型响应；先撤销，再关闭预览和采集，最后由宿主回收进程。 */
    func stop(reason: String, stream: SCStream? = nil) {
        let previous = lock.withLock { () -> (SCStream?, String)? in
            guard !stopped, stream == nil || capture === stream else { return nil }
            stopped = true
            let result = (capture, target?.sessionId ?? "")
            capture = nil; image = nil; previewData = nil
            return result
        }
        guard let previous else { return }
        releaseInput()
        DispatchQueue.main.async { [weak self] in
            if #available(macOS 14.0, *) { SCContentSharingPicker.shared.isActive = false }
            if let item = self?.statusItem { NSStatusBar.system.removeStatusItem(item); self?.statusItem = nil }
            self?.cursorPanel?.orderOut(nil)
            self?.lifecycleTimer?.invalidate()
            if let monitor = self?.inputMonitor { NSEvent.removeMonitor(monitor); self?.inputMonitor = nil }
        }
        if let data = try? JSONSerialization.data(withJSONObject: ["event": "control_stopped", "sessionId": previous.1, "reason": reason]) { writeComputerOutput(data) }
        if let stream = previous.0 { Task { try? await stream.stopCapture() } }
    }

    /** 只更新虚拟光标；物理鼠标位置从不写入。 */
    func showCursor(_ point: CGPoint) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.cursorPoint = point
            self.refreshPresentation()
        }
    }

    /** 控制菜单、接管监听与生命周期独立于会话预览，不创建桌面预览窗口。 */
    @MainActor private func showControls() {
        guard !lock.withLock({ stopped }) else { return }
        if statusItem == nil {
            let status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            status.button?.image = NSImage(systemSymbolName: "rectangle.and.hand.point.up.left", accessibilityDescription: "Zeus 屏幕控制")
            if status.button?.image == nil { status.button?.title = "控制" }
            let menu = NSMenu()
            let heading = NSMenuItem(title: targetLabel, action: nil, keyEquivalent: "")
            menu.addItem(heading)
            menu.addItem(.separator())
            let resume = NSMenuItem(title: "继续屏幕控制", action: #selector(userResume), keyEquivalent: "")
            resume.target = self
            menu.addItem(resume)
            let stopItem = NSMenuItem(title: "停止本轮屏幕控制", action: #selector(userStop), keyEquivalent: "")
            stopItem.target = self
            menu.addItem(stopItem)
            status.menu = menu
            statusItem = status; statusCaption = heading; resumeItem = resume
            inputMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseUp, .rightMouseUp, .otherMouseUp, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .keyDown, .keyUp, .flagsChanged, .scrollWheel]) { [weak self] event in self?.observeUserInput(event) }
            lifecycleTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.refreshPresentation() }
        }
        refreshPresentation()
    }

    /** 将当前会话画面与状态交给宿主；停止和目标切换后的旧图像不会混入新会话。 */
    private func publishPreview() {
        let payload = lock.withLock { () -> [String: Any]? in
            guard !stopped, let target else { return nil }
            let point = cursorPoint.flatMap { target.frame.contains($0) ? $0 : nil }
            return [
                "event": "control_preview", "sessionId": target.sessionId,
                "preview": [
                    "appName": targetLabel, "paused": paused, "needsObservation": needsObservation,
                    "imageUrl": previewData.map { "data:image/jpeg;base64," + $0.base64EncodedString() } as Any? ?? NSNull(),
                    "cursor": point.map { ["x": ($0.x - target.frame.minX) / target.frame.width, "y": ($0.y - target.frame.minY) / target.frame.height] } as Any? ?? NSNull(),
                ],
            ]
        }
        if let payload, let data = try? JSONSerialization.data(withJSONObject: payload) { writeComputerOutput(data) }
    }

    /** 用户可以提前结束等待；恢复后仍必须重新观察，停止的会话不能复活。 */
    func resume(sessionId: String) throws {
        try lock.withLock {
            guard !stopped, capture != nil, target?.sessionId == sessionId else {
                throw ServiceFailure(code: "ZEUS_COMPUTER_STOPPED", message: "该屏幕控制会话已结束，不能继续。")
            }
            paused = false; needsObservation = true
        }
        DispatchQueue.main.async { [weak self] in self?.refreshPresentation() }
    }

    /** 用户点击停止只撤销本轮，不修改全局能力开关。 */
    @objc private func userStop() { stop(reason: "user") }

    /** 原生菜单与会话按钮共用恢复入口。 */
    @objc private func userResume() {
        if let sessionId = lock.withLock({ target?.sessionId }) { try? resume(sessionId: sessionId) }
    }

    /** 过滤本服务的合成输入，其他应用中的物理输入不影响控制。 */
    private func observeUserInput(_ event: NSEvent) {
        guard let current = lock.withLock({ stopped ? nil : target }), let cgEvent = event.cgEvent,
              cgEvent.getIntegerValueField(.eventSourceUnixProcessID) != Int64(ProcessInfo.processInfo.processIdentifier) else { return }
        /** 按键与修饰键以目标应用焦点判断，鼠标只命中固定窗口。 */
        let keyboard = [.keyDown, .keyUp, .flagsChanged].contains(event.type)
        let touchesTarget = keyboard
            ? NSWorkspace.shared.frontmostApplication?.processIdentifier == current.pid
            : topWindow(at: cgEvent.location) == current.windowId
        if touchesTarget {
            lock.withLock {
                paused = true; needsObservation = true
                lastUserInput = ProcessInfo.processInfo.systemUptime
                if keyboard { userKeys.insert(event.keyCode) }
                if [.leftMouseDown, .rightMouseDown, .otherMouseDown].contains(event.type) { userButtons.insert(UInt32(event.buttonNumber)) }
            }
            releaseInput(); refreshPresentation()
        }
    }

    /** 跟随目标窗口生命周期，光标只出现在目标自身可见区域。 */
    private func refreshPresentation() {
        guard let current = lock.withLock({ stopped ? nil : target }) else { cursorPanel?.orderOut(nil); return }
        if let session = CGSessionCopyCurrentDictionary() as? [String: Any], session["CGSSessionScreenIsLocked"] as? Bool == true {
            stop(reason: "screen_locked"); return
        }
        guard let frame = windowFrame(current.windowId), NSRunningApplication(processIdentifier: current.pid)?.isTerminated == false else {
            if let stream = lock.withLock({ target?.windowId == current.windowId ? capture : nil }) { invalidateCapture(stream) }
            return
        }
        if frame != current.frame { lock.withLock { needsObservation = true } }
        lock.withLock {
            guard paused else { return }
            userKeys = userKeys.filter { CGEventSource.keyState(.combinedSessionState, key: $0) }
            userButtons = userButtons.filter { CGEventSource.buttonState(.combinedSessionState, button: CGMouseButton(rawValue: $0)!) }
            /** 长按和跨窗口拖拽保持等待，释放后重新计算空闲时间。 */
            let now = ProcessInfo.processInfo.systemUptime
            if !userKeys.isEmpty || !userButtons.isEmpty { lastUserInput = now }
            if now - lastUserInput >= userIdleInterval { paused = false; needsObservation = true }
        }
        let state = lock.withLock { (paused, needsObservation) }
        statusCaption?.title = state.0 ? "等待用户操作结束 · \(targetLabel)" : targetLabel
        statusItem?.button?.toolTip = state.0 ? "目标窗口空闲 3 秒后自动继续；停止可结束本轮控制" : "Zeus 正在控制 \(targetLabel)"
        resumeItem?.isHidden = !state.0
        publishPreview()
        guard !state.0, !state.1, let point = cursorPoint, current.frame.contains(point) else { cursorPanel?.orderOut(nil); return }
        guard topWindow(at: point) == current.windowId else { cursorPanel?.orderOut(nil); return }
        if cursorPanel == nil {
            let initialRect = NSRect(x: point.x, y: CGDisplayBounds(CGMainDisplayID()).height - point.y - 24, width: 24, height: 24)
            let cursor = ComputerCursorPanel(contentRect: initialRect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            cursor.isOpaque = false; cursor.backgroundColor = .clear; cursor.hasShadow = false
            cursor.ignoresMouseEvents = true; cursor.hidesOnDeactivate = false
            cursor.contentView = NSImageView(image: NSCursor.arrow.image)
            cursorPanel = cursor
        }
        cursorPanel?.setFrameOrigin(NSPoint(x: point.x, y: CGDisplayBounds(CGMainDisplayID()).height - point.y - 24))
        cursorPanel?.order(.above, relativeTo: Int(current.windowId))
    }

    /** 读取同一个窗口的实时边界，窗口缺失时不回退其他窗口。 */
    private func windowFrame(_ id: CGWindowID) -> CGRect? {
        guard let windows = CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]],
              windows.first?[kCGWindowIsOnscreen as String] as? Bool == true,
              let bounds = windows.first?[kCGWindowBounds as String] as? [String: Any] else { return nil }
        return CGRect(dictionaryRepresentation: bounds as CFDictionary)
    }

    /** 命中检测忽略自己的光标浮层，不把光标显示到遮挡目标的用户应用上。 */
    private func topWindow(at point: CGPoint) -> CGWindowID? {
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for window in windows {
            if window[kCGWindowOwnerPID as String] as? Int32 == ProcessInfo.processInfo.processIdentifier { continue }
            guard let bounds = window[kCGWindowBounds as String] as? [String: Any], let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary), frame.contains(point) else { continue }
            return window[kCGWindowNumber as String] as? CGWindowID
        }
        return nil
    }
}

private extension CGRect {
    /** 空交集不参与所在屏幕选择。 */
    var area: CGFloat { isNull ? 0 : width * height }
}

private extension Optional where Wrapped == String {
    /** 匹配焦点窗口时忽略空标题，避免把多个未命名窗口视为同一个。 */
    var isNilOrEmpty: Bool { self?.isEmpty ?? true }
}
