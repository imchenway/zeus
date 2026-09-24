import AppKit
import CoreImage
import ScreenCaptureKit

/** 标准输出同时承载请求响应和系统停止通知，整行写入避免相互拼接。 */
private let computerOutputLock = NSLock()

/** macOS 的 Tab 虚拟键码；与 Command 组合时由系统应用切换器处理。 */
private let applicationSwitchTabKeyCode: UInt16 = 48
/** IOKit 仍会发布 AppKit 未命名的 NX_ZOOM 第 28 类事件，必须和现代 Magnify 一并让权。 */
private let legacyZoomEventMask = NSEvent.EventTypeMask(rawValue: 1 << 28)

/** 返回当前控制台是否锁屏；锁屏期间禁止继续使用不可见的旧观察。 */
func computerSessionScreenIsLocked() -> Bool {
    (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool == true
}

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
    /** 系统窗口标题用于说明无焦点控件时的导航目标。 */
    let title: String

    /** 将同一坐标映射同时提供给模型、截图和输入。 */
    var metadata: [String: Any] {
        ["window_id": windowId, "title": title, "frame": ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height], "scale": scale]
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
    /** WindowServer 中用于判断受控窗口及其附属浮层的最小身份。 */
    private typealias VisibleWindow = (windowId: CGWindowID, pid: pid_t, frame: CGRect)
    /** 系统共享入口属于进程；停止一个轮次不能关闭其他轮次的入口。 */
    @MainActor private static var registeredStreams = Set<ObjectIdentifier>()
    /** 对共享状态的短同步保护，不在持锁时等待系统调用。 */
    private let lock = NSLock()
    /** 唯一目标窗口。 */
    private var target: ComputerWindowTarget?
    /** 持续采集触发 macOS 自身的屏幕共享状态入口。 */
    private var capture: SCStream?
    /** 停止帧先于原因回调时保留流身份，原因明确前不得重建采集或恢复输入。 */
    private var captureStopPending = false
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
    private var previewData: Data? {
        didSet {
            // 系统可能重复提交相同完整帧；仅在到帧时比较有界 JPEG，不扫描原图或周期性哈希。
            if previewData != oldValue { previewRevision &+= 1; encodedPreview = nil }
        }
    }
    /** 每个新帧只执行一次编码，空闲帧不修改此身份。 */
    private var previewRevision: UInt64 = 0
    /** 仅保留当前缩略图的编码结果。 */
    private var encodedPreview: String?
    /** 图像与安全状态共同决定发布，不能仅按图像吞掉用户接管。 */
    private struct PreviewIdentity: Equatable {
        /** 控制轮次及目标窗口发生变化时必须重新发布。 */
        let sessionId: String
        /** 窗口切换不能复用旧预览。 */
        let windowId: CGWindowID
        /** 展示名称更新独立于画面。 */
        let label: String
        /** 窗口移动影响光标归一化坐标。 */
        let frame: CGRect
        /** 当前图像身份；无需为去重重新扫描整张图像。 */
        let revision: UInt64
        /** 暂停、观察要求和光标变化独立于图像。 */
        let paused: Bool
        /** 恢复后需要观察的安全状态。 */
        let needsObservation: Bool
        /** 锁屏、休眠或采集暂停期间不允许继续输入。 */
        let systemUnavailable: Bool
        /** 窗口内光标位置，窗口外统一为空。 */
        let cursor: CGPoint?
    }
    /** 上一次成功构造的完整预览身份。 */
    private var publishedPreview: PreviewIdentity?
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
    /** 系统画面不可见时保持控制身份，但关闭所有输入。 */
    private var systemUnavailable = false
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
    /** 目标应用物理输入监听，不因用户操作其他应用而暂停。 */
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
    /** 同一目标应用本次可见的窗口，包括独立菜单和文件选择框。 */
    private(set) var availableWindows: [[String: Any]] = []

    /** 原生进程身份用于跨轮次互斥；停止后立即释放应用占用。 */
    var targetProcessIdentifier: pid_t? {
        lock.withLock { !stopped ? target?.pid : nil }
    }

    /** 系统菜单注册按实际采集流计数，只在最后一路结束后关闭。 */
    @MainActor private static func unregister(_ stream: SCStream) {
        registeredStreams.remove(ObjectIdentifier(stream))
        if #available(macOS 14.0, *) { SCContentSharingPicker.shared.isActive = !registeredStreams.isEmpty }
    }

    /** 观察时固定窗口；切换应用或显式窗口编号才创建新的采集对象。 */
    func observe(app: NSRunningApplication, sessionId: String, windowId: CGWindowID?) async throws -> ComputerWindowTarget {
        guard !sessionId.isEmpty else { throw ServiceFailure(code: "ZEUS_COMPUTER_SESSION_REQUIRED", message: "缺少宿主控制身份。") }
        guard !computerSessionScreenIsLocked() else {
            lock.withLock { systemUnavailable = true; needsObservation = true }
            DispatchQueue.main.async { [weak self] in self?.publishPreview() }
            throw ServiceFailure(code: "ZEUS_COMPUTER_SESSION_UNAVAILABLE", message: "macOS 当前处于锁屏或不可见会话；已暂停输入，解锁后必须重新观察。")
        }
        guard CGPreflightScreenCaptureAccess() else { throw ServiceFailure(code: "ZEUS_COMPUTER_SCREEN_CAPTURE_PERMISSION_REQUIRED", message: "开始控制需要屏幕录制权限，以显示真实的控制状态。") }
        /** 锁屏遮住桌面但不会关闭应用窗口；此时必须保留后台窗口候选，才能继续同一控制。 */
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: !computerSessionScreenIsLocked())
        // 原生菜单使用非零层级；只按真实进程及可见边界筛选，不把层级当作窗口归属。
        let windows = content.windows.filter { $0.owningApplication?.processID == app.processIdentifier && $0.windowLayer >= 0 && $0.frame.width > 1 && $0.frame.height > 1 }
        availableWindows = windows.map { ["window_id": $0.windowID, "title": $0.title ?? "", "layer": $0.windowLayer, "frame": ["x": $0.frame.minX, "y": $0.frame.minY, "width": $0.frame.width, "height": $0.frame.height]] }
        /** 无可捕获窗口时直接说明原因，避免要求用户选择不存在的窗口编号。 */
        guard !windows.isEmpty else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_WINDOW_UNAVAILABLE", message: "目标应用正在运行，但没有可捕获的可见窗口；桌面、隐藏或最小化窗口不能作为当前操作目标。")
        }
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
        let next = ComputerWindowTarget(sessionId: sessionId, pid: app.processIdentifier, windowId: window.windowID, frame: window.frame, scale: scale, title: window.title ?? "")
        let existing = try lock.withLock { () throws -> SCStream? in
            if stopped { throw ServiceFailure(code: "ZEUS_COMPUTER_STOPPED", message: "本轮控制已停止。") }
            if let previous, previous.sessionId != sessionId { throw ServiceFailure(code: "ZEUS_COMPUTER_SESSION_MISMATCH", message: "控制身份已失效。") }
            return capture
        }
        if previous?.windowId != next.windowId || previous?.frame != next.frame || previous?.scale != next.scale || existing == nil {
            // 先脱离旧流，迟到的旧流停止回调不会撤销新窗口。
            try lock.withLock {
                guard !captureStopPending else { throw ServiceFailure(code: "ZEUS_COMPUTER_OBSERVATION_REQUIRED", message: "正在确认采集停止原因，请稍后重新观察，不能继续旧动作。") }
                capture = nil; image = nil; previewData = nil; frameDate = .distantPast; imageDate = .distantPast; frameTime = .invalid; needsObservation = true
            }
            if let existing { await Self.unregister(existing); try await existing.stopCapture() }
            let configuration = SCStreamConfiguration()
            configuration.width = max(1, Int(next.frame.width * scale))
            configuration.height = max(1, Int(next.frame.height * scale))
            configuration.showsCursor = false
            configuration.queueDepth = 2
            configuration.minimumFrameInterval = CMTime(value: 1, timescale: 2)
            // 忽略窗口阴影，使图像原点、尺寸和输入坐标一致。
            if #available(macOS 14.0, *) { configuration.ignoreShadowsSingleWindow = true }
            /** 非普通层级的弹出窗口使用明确窗口列表裁切，避免独立窗口采集错误缩放菜单。 */
            let filter: SCContentFilter
            if window.windowLayer != 0, let display {
                filter = SCContentFilter(display: display, including: [window])
                configuration.sourceRect = window.frame.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
            } else { filter = SCContentFilter(desktopIndependentWindow: window) }
            let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
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
                    Self.registeredStreams.insert(ObjectIdentifier(stream))
                    picker.isActive = true
                }
            }
            do { try await stream.startCapture() }
            catch {
                // 启动失败也先处理明确的用户撤权，不能被锁屏降级吞掉。
                self.stream(stream, didStopWithError: error)
                /** 锁屏下像素采集失败不等于窗口控制失败；保留实时辅助功能和输入目标。 */
                if !computerSessionScreenIsLocked() { throw error }
            }
        }
        try lock.withLock {
            if stopped { throw ServiceFailure(code: "ZEUS_COMPUTER_STOPPED", message: "本轮控制已停止。") }
            guard !captureStopPending else { throw ServiceFailure(code: "ZEUS_COMPUTER_OBSERVATION_REQUIRED", message: "正在确认采集停止原因，请稍后重新观察，不能继续旧动作。") }
            guard target?.windowId == next.windowId, target?.pid == next.pid else {
                throw ServiceFailure(code: "ZEUS_COMPUTER_OBSERVATION_REQUIRED", message: "目标窗口已变化，请重新观察。")
            }
            systemUnavailable = false
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
            guard !stopped, let target, target.pid == pid, target.sessionId == sessionId else { throw ServiceFailure(code: "ZEUS_COMPUTER_OBSERVATION_REQUIRED", message: "请先观察当前应用窗口，不能直接开始输入。") }
            guard !paused else { throw ServiceFailure(code: "ZEUS_COMPUTER_PAUSED", message: "用户正在操作目标应用；宿主会等待空闲后返回，请保留任务并重新观察，不能重放旧动作。") }
            guard !systemUnavailable else { throw ServiceFailure(code: "ZEUS_COMPUTER_SESSION_UNAVAILABLE", message: "系统画面当前不可见；解锁或唤醒后必须重新观察，不能继续旧动作。") }
            guard !needsObservation else { throw ServiceFailure(code: "ZEUS_COMPUTER_OBSERVATION_REQUIRED", message: "窗口位置或用户控制状态已变化，请重新观察。") }
            return target
        }
        guard windowFrame(current.windowId) == current.frame else { throw ServiceFailure(code: "ZEUS_COMPUTER_WINDOW_CHANGED", message: "目标窗口已移动或关闭，请重新观察。") }
        return current
    }

    /** 会改变应用内部焦点的动作不能打断用户正在同应用其他窗口中的输入。 */
    func requireFocusAvailable(pid: pid_t, sessionId: String) throws {
        let current = try requireTarget(pid: pid, sessionId: sessionId)
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
              let front = frontWindow(of: pid), front.windowId != current.windowId else { return }
        lock.withLock {
            paused = true; needsObservation = true
            lastUserInput = ProcessInfo.processInfo.systemUptime
        }
        releaseInput()
        DispatchQueue.main.async { [weak self] in self?.refreshPresentation() }
        throw ServiceFailure(code: "ZEUS_COMPUTER_PAUSED", message: "用户正在目标应用的另一个窗口中操作；本动作会改变应用焦点，已暂停执行。请等待空闲后重新观察。")
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
            guard !systemUnavailable else { throw ServiceFailure(code: "ZEUS_COMPUTER_SESSION_UNAVAILABLE", message: "系统画面当前不可见；动作尚未投递，解锁或唤醒后请重新观察。") }
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
    private func releaseInput(stream: SCStream? = nil) {
        let releases = lock.withLock {
            // 迟到的旧采集回调不能中断新窗口的输入。
            guard stream == nil || capture === stream else { return [(CGEvent, pid_t)]() }
            /** 本次需要释放的虚拟按键或鼠标按钮。 */
            let values = Array(pendingReleases.values)
            // 清理意味着在途动作已被打断；与输入闸门共用锁，先作废再发送抬起事件。
            if !values.isEmpty { needsObservation = true }
            pendingReleases.removeAll()
            return values
        }
        for (event, pid) in releases { event.postToPid(pid) }
    }

    /** 将接管状态附在观察结果中；读取状态不会绕过空闲等待。 */
    var status: [String: Any] {
        lock.withLock { ["active": !stopped && target != nil, "paused": paused, "needs_observation": needsObservation, "system_unavailable": systemUnavailable] }
    }

    /** 帧须晚于动作和控件回读；分别返回像素采集及内容未变化确认的时间。 */
    func snapshot(notBefore: CMTime) async throws -> (CGImage, ComputerWindowTarget, Date, Date) {
        guard !lock.withLock({ systemUnavailable }) else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_SESSION_UNAVAILABLE", message: "系统画面当前不可见；解锁或唤醒后必须重新观察。")
        }
        guard lock.withLock({ !stopped && capture != nil }) else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_FRAME_UNAVAILABLE", message: "当前没有可用像素帧；辅助功能观察和定向输入仍可继续。")
        }
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
            // 空帧只清除过期图像；停止原因未明或在途输入被释放时，必须阻止旧动作继续。
            /** 迟到的旧流空帧不能清理新窗口正在进行的输入。 */
            let cleared = lock.withLock { () -> Bool in
                guard capture === stream && !stopped else { return false }
                image = nil; previewData = nil; frameTime = .invalid
                // 停止帧不携带原因；保留 capture 给随后到达的用户停止回调判定身份。
                if status == .stopped { captureStopPending = true }
                needsObservation = true
                systemUnavailable = status != .stopped
                return true
            }
            if cleared {
                releaseInput(stream: stream)
                DispatchQueue.main.async { [weak self] in self?.publishPreview() }
            }
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
            invalidateCapture(stream, observationRemainsValid: computerSessionScreenIsLocked(), stopReasonResolved: true)
        }
    }

    /** 窗口关闭或采集失败只作废观察；下一次观察重建采集，旧动作不会自动重放。 */
    private func invalidateCapture(_ stream: SCStream, observationRemainsValid: Bool = false, stopReasonResolved: Bool = false) {
        /** 同一把锁确认流身份并清理，迟到的旧流事件不能使新窗口失效。 */
        let invalidated = lock.withLock { () -> Bool in
            guard !stopped, capture === stream else { return false }
            // 生命周期检查不能先移除尚待撤权判定的流；只有携带原因的回调可以结束等待。
            guard !captureStopPending || stopReasonResolved else { return false }
            capture = nil; captureStopPending = false; image = nil; previewData = nil; frameTime = .invalid
            needsObservation = needsObservation || !observationRemainsValid || !pendingReleases.isEmpty
            return true
        }
        guard invalidated else { return }
        releaseInput()
        DispatchQueue.main.async { [weak self] in Self.unregister(stream); self?.cursorPanel?.orderOut(nil); self?.publishPreview() }
        Task { try? await stream.stopCapture() }
    }

    /** 停止不依赖模型响应；先撤销，再关闭预览和采集，最后由宿主回收进程。 */
    func stop(reason: String, stream: SCStream? = nil) {
        let previous = lock.withLock { () -> (SCStream?, String)? in
            guard !stopped, stream == nil || capture === stream else { return nil }
            stopped = true
            let result = (capture, target?.sessionId ?? "")
            capture = nil; captureStopPending = false; image = nil; previewData = nil
            return result
        }
        guard let previous else { return }
        releaseInput()
        DispatchQueue.main.async { [self] in
            if let stream = previous.0 { Self.unregister(stream) }
            if let item = statusItem { NSStatusBar.system.removeStatusItem(item); statusItem = nil }
            cursorPanel?.orderOut(nil)
            lifecycleTimer?.invalidate()
            if let monitor = inputMonitor { NSEvent.removeMonitor(monitor); inputMonitor = nil }
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
            let userInputMask: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseUp, .rightMouseUp, .otherMouseUp, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .keyDown, .keyUp, .flagsChanged, .scrollWheel, .gesture, .beginGesture, .endGesture, .magnify, .swipe, .rotate, .smartMagnify, .pressure]
            inputMonitor = NSEvent.addGlobalMonitorForEvents(matching: userInputMask.union(legacyZoomEventMask)) { [weak self] event in self?.observeUserInput(event) }
            lifecycleTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.refreshPresentation() }
        }
        refreshPresentation()
    }

    /** 将当前会话画面与状态交给宿主；停止和目标切换后的旧图像不会混入新会话。 */
    private func publishPreview() {
        let payload = lock.withLock { () -> [String: Any]? in
            guard !stopped, let target else { return nil }
            let point = cursorPoint.flatMap { target.frame.contains($0) ? $0 : nil }
            let identity = PreviewIdentity(sessionId: target.sessionId, windowId: target.windowId, label: targetLabel, frame: target.frame, revision: previewRevision, paused: paused, needsObservation: needsObservation, systemUnavailable: systemUnavailable, cursor: point)
            guard identity != publishedPreview else { return nil }
            if encodedPreview == nil, let previewData { encodedPreview = "data:image/jpeg;base64," + previewData.base64EncodedString() }
            publishedPreview = identity
            return [
                "event": "control_preview", "sessionId": target.sessionId,
                "preview": [
                    "appName": targetLabel, "paused": paused, "needsObservation": needsObservation, "systemUnavailable": systemUnavailable,
                    "imageUrl": encodedPreview as Any? ?? NSNull(),
                    "cursor": point.map { ["x": ($0.x - target.frame.minX) / target.frame.width, "y": ($0.y - target.frame.minY) / target.frame.height] } as Any? ?? NSNull(),
                ],
            ]
        }
        if let payload, let data = try? JSONSerialization.data(withJSONObject: payload) { writeComputerOutput(data) }
    }

    /** 用户可以提前结束等待；恢复后仍必须重新观察，停止的会话不能复活。 */
    func resume(sessionId: String) throws {
        try lock.withLock {
            guard !stopped, target?.sessionId == sessionId else {
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

    /** 过滤本服务的合成输入；用户操作已控制窗口时让权，操作其他窗口或应用时继续。 */
    private func observeUserInput(_ event: NSEvent) {
        guard let current = lock.withLock({ stopped ? nil : target }), let cgEvent = event.cgEvent,
              cgEvent.getIntegerValueField(.eventSourceUnixProcessID) != Int64(ProcessInfo.processInfo.processIdentifier) else { return }
        /** 修饰键本身不改变应用内容；真正的按键再按当时的前台应用判定。 */
        if event.type == .flagsChanged { return }
        /** 键盘按目标应用最前窗口判定，鼠标、滚轮与手势按指针下窗口判定。 */
        let keyboard = [.keyDown, .keyUp].contains(event.type)
        /** Command-Tab 由系统切换应用，不属于目标应用输入。 */
        let switchesApplication = keyboard && event.keyCode == applicationSwitchTabKeyCode && event.modifierFlags.contains(.command)
        /** 独立且不重叠的同应用窗口可以继续工作；受控窗口上的菜单、Sheet 和浮层必须一并让权。 */
        let targetAppFrontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier == current.pid
        let eventWindow = keyboard ? (targetAppFrontmost ? frontWindow(of: current.pid) : nil) : topWindow(at: cgEvent.location)
        let usesTargetWindow = !switchesApplication && (keyboard
            ? targetAppFrontmost && eventWindow.map { isTargetWindowFamily($0, target: current) } == true
            : eventWindow.map { isTargetWindowFamily($0, target: current) } == true)
        /** 焦点冲突已经进入等待后，同应用其他窗口的持续输入也要延长等待。 */
        let continuesFocusConflict = lock.withLock({ paused }) && !switchesApplication && eventWindow?.pid == current.pid
        if usesTargetWindow || continuesFocusConflict {
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
        if computerSessionScreenIsLocked() {
            lock.withLock { systemUnavailable = true; needsObservation = true }
            releaseInput(); publishPreview(); cursorPanel?.orderOut(nil)
            return
        }
        /** 采集或窗口失效时沿用既有的重新观察流程。 */
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
        let state = lock.withLock { (paused, needsObservation, systemUnavailable) }
        statusCaption?.title = state.2 ? "等待系统解锁或唤醒 · \(targetLabel)" : state.0 ? "等待用户操作结束 · \(targetLabel)" : targetLabel
        statusItem?.button?.toolTip = state.2 ? "系统画面不可见；恢复后需重新观察" : state.0 ? "目标窗口空闲 3 秒后自动继续；停止可结束本轮控制" : "Zeus 正在控制 \(targetLabel)"
        resumeItem?.isHidden = !state.0 || state.2
        publishPreview()
        guard !state.0, !state.1, !state.2, let point = cursorPoint, current.frame.contains(point) else { cursorPanel?.orderOut(nil); return }
        guard topWindow(at: point)?.windowId == current.windowId else { cursorPanel?.orderOut(nil); return }
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
              windows.first?[kCGWindowIsOnscreen as String] as? Bool == true || computerSessionScreenIsLocked(),
              let bounds = windows.first?[kCGWindowBounds as String] as? [String: Any] else { return nil }
        return CGRect(dictionaryRepresentation: bounds as CFDictionary)
    }

    /** 命中检测返回最上层窗口，并忽略自己的光标浮层。 */
    private func topWindow(at point: CGPoint) -> VisibleWindow? {
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for window in windows {
            if window[kCGWindowOwnerPID as String] as? Int32 == ProcessInfo.processInfo.processIdentifier { continue }
            guard let bounds = window[kCGWindowBounds as String] as? [String: Any], let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary), frame.contains(point),
                  let windowId = window[kCGWindowNumber as String] as? CGWindowID, let pid = window[kCGWindowOwnerPID as String] as? pid_t else { continue }
            return (windowId, pid, frame)
        }
        return nil
    }

    /** 返回目标进程当前最前的可见窗口，用于把物理键盘接管限制到已观察窗口。 */
    private func frontWindow(of pid: pid_t) -> VisibleWindow? {
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        guard let window = windows.first(where: { window in
            window[kCGWindowOwnerPID as String] as? pid_t == pid && (window[kCGWindowAlpha as String] as? Double ?? 0) > 0
        }), let windowId = window[kCGWindowNumber as String] as? CGWindowID,
              let bounds = window[kCGWindowBounds as String] as? [String: Any], let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return nil }
        return (windowId, pid, frame)
    }

    /** 受控窗口自身以及覆盖其区域的同进程 Sheet、菜单和浮层属于同一接管范围。 */
    private func isTargetWindowFamily(_ window: VisibleWindow, target: ComputerWindowTarget) -> Bool {
        window.windowId == target.windowId || (window.pid == target.pid && window.frame.intersection(target.frame).area > 0)
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
