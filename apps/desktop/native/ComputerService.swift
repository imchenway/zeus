import AppKit
import ApplicationServices
import CoreGraphics
import CryptoKit
import Foundation
import ScreenCaptureKit

/** 供原生控制和辅助功能层共用的结构化失败。 */
struct ServiceFailure: Error {
    let code: String
    let message: String
}

private struct ElementSnapshot {
    let generation: Int
    let pid: pid_t
    let elements: [AXUIElement]
    let summaries: [[String: Any]]
    let complete: Bool
}

private let axMessagingTimeoutSeconds: Float = 2
private let minimumScreenshotBudgetMilliseconds: Double = 5_000

/** 明确的界面完成条件；只确认观察到的状态，不推断外部业务已完成。 */
private struct ComputerStateCondition {
    /** 精确匹配控件标题、描述或标识，不依赖会随页面变化的索引。 */
    let name: String
    /** 可选的辅助功能角色，用来区分同名控件。 */
    let role: String?
    /** 可选的完整文本值；空字符串代表确认清空。 */
    let value: String?
    /** 消失条件仅能由完整的目标窗口树确认。 */
    let absent: Bool
    /** 等待上限包含读取耗时，不在模型轮次之间固定睡眠。 */
    let timeoutMilliseconds: Double

    /** 在动作之前校验，错误条件不得造成先操作、后报参数错误。 */
    static func parse(_ raw: Any?) throws -> ComputerStateCondition? {
        guard let raw else { return nil }
        guard let input = raw as? [String: Any],
              Set(input.keys).isSubset(of: ["name", "role", "value", "state", "timeout_ms"]),
              let name = input["name"] as? String, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name.count <= 1000,
              input["role"] == nil || (input["role"] as? String).map({ !$0.isEmpty && $0.count <= 200 }) == true,
              input["value"] == nil || (input["value"] as? String).map({ $0.count <= 20_000 }) == true,
              input["state"] == nil || ["present", "absent"].contains(input["state"] as? String ?? ""),
              !(input["state"] as? String == "absent" && input["value"] != nil)
        else { throw ServiceFailure(code: "ZEUS_COMPUTER_WAIT_INVALID", message: "wait_for 需要精确 name，可选 role、value 和 present/absent；消失条件不能带 value。") }
        let timeout = input["timeout_ms"] as? NSNumber ?? 3000
        guard input["timeout_ms"] == nil || input["timeout_ms"] is NSNumber,
              CFGetTypeID(timeout) != CFBooleanGetTypeID(), timeout.doubleValue.isFinite,
              timeout.doubleValue.rounded() == timeout.doubleValue, (100...10_000).contains(timeout.doubleValue)
        else { throw ServiceFailure(code: "ZEUS_COMPUTER_WAIT_INVALID", message: "wait_for.timeout_ms 必须是 100 到 10000 的整数。") }
        return ComputerStateCondition(name: name, role: input["role"] as? String, value: input["value"] as? String, absent: input["state"] as? String == "absent", timeoutMilliseconds: timeout.doubleValue)
    }

    /** 缺少窗口树、不完整或同名值歧义时不把未知状态判成完成。 */
    func isSatisfied(by summaries: [[String: Any]], complete: Bool, windowMatched: Bool) -> Bool {
        guard windowMatched else { return false }
        let matches = summaries.filter { element in
            (role == nil || element["role"] as? String == role) && ["title", "description", "identifier"].contains { element[$0] as? String == name }
        }
        if absent { return complete && matches.isEmpty }
        guard let value else { return !matches.isEmpty }
        guard complete, matches.count == 1, let element = matches.first, element["secure"] as? Bool != true else { return false }
        return element["value"] as? String == value
    }
}

/** 会触发控件或输入的动作必须先经宿主检查实时目标。 */
private let preparedActionMethods: Set<String> = ["click", "drag", "paste", "perform_secondary_action", "press_key", "set_value", "type_text"]

/** 宿主一次确认对应的精确动作；控件、内容或参数变化后不能复用。 */
private struct PreparedComputerAction {
    /** 原生生成的一次性凭据，不由模型提供。 */
    let token: String
    /** 获准检查的工具动作。 */
    let method: String
    /** 包含控制身份的完整动作参数。 */
    let arguments: Data
    /** 系统控件引用，防止同名控件相互替换。 */
    let element: AXUIElement
    /** 应用、窗口、控件及内容指纹。 */
    let state: Data
}

@main
private struct ZeusComputerService {
    /** 主线程运行 AppKit，让系统采集回调、停止按钮和用户接管监听不被 AX 扫描阻塞。 */
    static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let service = ComputerService()
        // 宿主终止请求先释放本服务的虚拟按键，避免中断拖拽后目标应用保留按下状态。
        signal(SIGTERM, SIG_IGN)
        let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termination.setEventHandler { service.shutdown(); NSApp.terminate(nil) }
        termination.resume()
        Task.detached {
            while let line = readLine(strippingNewline: true) {
                guard !line.isEmpty else { continue }
                let response = await service.handle(line: line)
                writeComputerOutput(response)
            }
            service.shutdown()
            await MainActor.run { NSApp.terminate(nil) }
        }
        withExtendedLifetime(termination) { application.run() }
    }
}

private final class ComputerService {
    private var generation = 0
    /** 串行工具动作的序号，观察结果可追溯到最近一次动作请求。 */
    private var actionSequence = 0
    private var snapshots: [pid_t: ElementSnapshot] = [:]
    private var snapshotHistory: [Int: ElementSnapshot] = [:]
    /** 唯一控制窗口、持续采集和原生停止入口。 */
    private let control = ComputerControlSession()
    /** 当前串行请求由宿主签发的控制身份。 */
    private var controlSessionId = ""
    /** 串行动作只保留一份待执行检查，使用后立即消费。 */
    private var preparedAction: PreparedComputerAction?
    /** 虚拟输入独立于硬件键鼠状态，不继承用户正在按住的修饰键。 */
    private let inputSource = CGEventSource(stateID: .privateState)
    private let artifactRoot: URL
    private let parentPid: pid_t
    private let encoder = JSONSerialization.self

    init() {
        let environment = ProcessInfo.processInfo.environment
        let root = environment["ZEUS_COMPUTER_ARTIFACT_ROOT"] ?? NSTemporaryDirectory()
        artifactRoot = URL(fileURLWithPath: root, isDirectory: true).standardizedFileURL
        parentPid = pid_t(Int32(environment["ZEUS_PARENT_PID"] ?? "-1") ?? -1)
        inputSource?.userData = Int64(ProcessInfo.processInfo.processIdentifier)
        inputSource?.localEventsSuppressionInterval = 0
        // 为所有 AX 消息设置进程级上限，目标应用失去响应时仍能结束有界确认。
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), axMessagingTimeoutSeconds)
    }

    /** 父进程管道关闭时结束采集和预览。 */
    func shutdown() { control.stop(reason: "parent_closed") }

    func handle(line: String) async -> Data {
        var requestId: Any = NSNull()
        do {
            guard let data = line.data(using: .utf8),
                  let request = try encoder.jsonObject(with: data) as? [String: Any]
            else { throw ServiceFailure(code: "ZEUS_COMPUTER_REQUEST_INVALID", message: "Computer 请求不是 JSON object。") }
            requestId = request["id"] ?? NSNull()
            guard let method = request["method"] as? String, !method.isEmpty else {
                throw ServiceFailure(code: "ZEUS_COMPUTER_REQUEST_INVALID", message: "Computer 请求缺少 method。")
            }
            var params = request["params"] as? [String: Any] ?? [:]
            controlSessionId = params["_control_session_id"] as? String ?? ""
            if let requestId = requestId as? String { params["_request_id"] = requestId }
            let result = try await invoke(method: method, params: params)
            return try response(["id": requestId, "ok": true, "result": result])
        } catch let failure as ServiceFailure {
            return (try? response(["id": requestId, "ok": false, "error": ["code": failure.code, "message": failure.message]])) ?? Data()
        } catch {
            return (try? response(["id": requestId, "ok": false, "error": ["code": "ZEUS_COMPUTER_OPERATION_FAILED", "message": String(describing: error)]])) ?? Data()
        }
    }

    private func response(_ value: [String: Any]) throws -> Data {
        let data = try encoder.data(withJSONObject: value, options: [])
        guard data.count <= 16 * 1024 * 1024 else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_RESPONSE_TOO_LARGE", message: "Computer 响应超过 16 MiB。")
        }
        return data
    }

    private func invoke(method: String, params: [String: Any]) async throws -> Any {
        let condition = try ComputerStateCondition.parse(params["wait_for"])
        if preparedActionMethods.contains(method) { try validatePreparedAction(method, params) }
        switch method {
        case "status":
            return status()
        case "request_permissions":
            return requestPermissions(params)
        case "resume_control":
            // 此方法仅由宿主用户命令调用，不注册为模型工具。
            try control.resume(sessionId: controlSessionId)
            return control.status
        case "list_apps":
            return listApps()
        case "get_app_state":
            preparedAction = nil
            return try await getAppState(params, condition: condition)
        case "describe_target":
            return try describeTarget(params)
        default:
            break
        }
        let startedAt = ProcessInfo.processInfo.systemUptime
        var action: [String: Any]
        actionSequence += 1
        switch method {
        case "click":
            action = try performClick(params, secondary: false)
        case "perform_secondary_action":
            action = try performClick(params, secondary: true)
        case "drag":
            action = try await performDrag(params)
        case "paste":
            action = try performPaste(params)
        case "press_key":
            action = try performKey(params)
        case "scroll":
            action = try performScroll(params)
        case "select_text":
            action = try selectText(params)
        case "set_value":
            action = try setValue(params)
        case "type_text":
            action = try typeText(params)
        default:
            throw ServiceFailure(code: "ZEUS_COMPUTER_METHOD_UNSUPPORTED", message: "Computer 方法不受支持：\(method)")
        }
        let actionMilliseconds = (ProcessInfo.processInfo.systemUptime - startedAt) * 1000
        snapshots.removeAll()
        action["effect_verified"] = false
        action["action_sequence"] = actionSequence
        action["action_ms"] = actionMilliseconds
        action["diagnostics"] = ["action_ms": actionMilliseconds, "native_total_ms": actionMilliseconds]
        guard let condition else { return action }
        do {
            var observationParams = params
            // 动作确认复用已经观察的窗口，不能因弹出另一窗口而隐式切换目标。
            observationParams["include_screenshot"] = params["include_screenshot"] as? Bool ?? false
            let observation = try await getAppState(observationParams, condition: condition, afterAction: true)
            action.merge(observation) { _, value in value }
            action["effect_verified"] = (observation["confirmation"] as? [String: Any])?["status"] as? String == "satisfied"
        } catch {
            // 动作已经投递；确认失败不能伪装成未执行，更不能自动重放。
            let failure = error as? ServiceFailure
            action["confirmation"] = ["status": "observation_failed", "code": failure?.code ?? "ZEUS_COMPUTER_OPERATION_FAILED", "message": failure?.message ?? String(describing: error)]
        }
        action["diagnostics"] = (action["diagnostics"] as? [String: Any] ?? [:]).merging(["action_ms": actionMilliseconds, "native_total_ms": (ProcessInfo.processInfo.systemUptime - startedAt) * 1000]) { _, value in value }
        return action
    }

    private func status() -> [String: Any] {
        [
            "accessibilityTrusted": AXIsProcessTrusted(),
            "screenCaptureAvailable": CGPreflightScreenCaptureAccess(),
            "control": control.status,
            "servicePid": ProcessInfo.processInfo.processIdentifier,
            "protocolVersion": "zeus.computer.v1",
        ]
    }

    private func requestPermissions(_ params: [String: Any]) -> [String: Any] {
        let requestAccessibility = params["accessibility"] as? Bool ?? true
        let requestScreenCapture = params["screenCapture"] as? Bool ?? true
        if requestAccessibility && !AXIsProcessTrusted() {
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
        }
        if requestScreenCapture && !CGPreflightScreenCaptureAccess() {
            _ = CGRequestScreenCaptureAccess()
        }
        return status()
    }

    private func listApps() -> [[String: Any]] {
        NSWorkspace.shared.runningApplications
            .filter { $0.processIdentifier > 0 && $0.activationPolicy == .regular }
            .map { app in
                [
                    "id": app.bundleIdentifier ?? app.bundleURL?.path ?? app.localizedName ?? "",
                    "displayName": app.localizedName ?? "",
                    "isRunning": true,
                    "name": app.localizedName ?? "",
                    "bundleId": app.bundleIdentifier ?? "",
                    "path": app.bundleURL?.path ?? "",
                    "pid": Int(app.processIdentifier),
                    "active": app.isActive,
                    "hidden": app.isHidden,
                    "controllable": canControl(app),
                ] as [String: Any]
            }
            .sorted { String(describing: $0["name"]).localizedCaseInsensitiveCompare(String(describing: $1["name"])) == .orderedAscending }
    }

    /** 读取一次或等待明确条件；轮询复用窗口与采集流，仅最后一次读取返回模型。 */
    private func getAppState(_ params: [String: Any], condition: ComputerStateCondition? = nil, afterAction: Bool = false) async throws -> [String: Any] {
        let startedAt = Date()
        let startedUptime = ProcessInfo.processInfo.systemUptime
        try requireAccessibility()
        try requireUnlockedSession()
        let app = try await resolveApplication(params)
        try rejectSelf(app)
        // 观察与后续输入固定同一窗口；截屏关闭只省略返回图片，不隐藏正在控制的系统状态。
        let target = afterAction ? try control.requireTarget(pid: app.processIdentifier, sessionId: controlSessionId) : try await control.observe(app: app, sessionId: controlSessionId, windowId: intValue(params["window_id"]).flatMap { UInt32(exactly: $0) })
        let maxElements = boundedInt(params["max_elements"], fallback: 500, min: 1, max: 1000)
        let deadlineUnixMilliseconds = numberValue(params["_deadline_unix_ms"])
        let applicationElement = AXUIElementCreateApplication(app.processIdentifier)
        // Chromium 等应用按需暴露语义树；只启用目标应用声明支持的辅助功能属性，不激活窗口。
        var manualAccessibilitySettable = DarwinBoolean(false)
        if AXUIElementIsAttributeSettable(applicationElement, "AXManualAccessibility" as CFString, &manualAccessibilitySettable) == .success && manualAccessibilitySettable.boolValue {
            _ = AXUIElementSetAttributeValue(applicationElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        }
        let waitStarted = ProcessInfo.processInfo.systemUptime
        let waitDeadline = condition.map { Date().timeIntervalSince1970 * 1000 + $0.timeoutMilliseconds }
        let readDeadline = [deadlineUnixMilliseconds, waitDeadline].compactMap { $0 }.min()
        var axStartedAt = Date()
        var axFinishedAt = axStartedAt
        var readCount = 0
        var axMilliseconds = 0.0
        var satisfied = false
        var elements: [AXUIElement] = []
        var summaries: [[String: Any]] = []
        var truncatedReason: String?
        repeat {
            try requireUnlockedSession()
            if condition != nil { _ = try control.requireTarget(pid: app.processIdentifier, sessionId: controlSessionId) }
            axStartedAt = Date()
            let readStarted = ProcessInfo.processInfo.systemUptime
            // 每次重新定位窗口树，不复用已经离开页面的 AX 控件引用。
            let observedWindow = (attribute(applicationElement, kAXWindowsAttribute) as? [AXUIElement])?.first { matchesWindow($0, target: target) }
            elements.removeAll(keepingCapacity: true)
            summaries.removeAll(keepingCapacity: true)
            var visited = Set<CFHashCode>()
            truncatedReason = nil
            reportProgress(params, stage: "ax_walk", elementCount: 0, startedAt: startedAt)
            walk(
                element: observedWindow ?? applicationElement,
                depth: 0,
                maxElements: maxElements,
                deadlineUnixMilliseconds: readDeadline,
                visited: &visited,
                elements: &elements,
                summaries: &summaries,
                truncatedReason: &truncatedReason,
                progress: { count in
                    if count == 1 || count.isMultiple(of: 50) {
                        self.reportProgress(params, stage: "ax_walk", elementCount: count, startedAt: startedAt)
                    }
                }
            )
            if truncatedReason == nil, elements.count >= maxElements { truncatedReason = "element_limit" }
            axFinishedAt = Date()
            axMilliseconds += (ProcessInfo.processInfo.systemUptime - readStarted) * 1000
            readCount += 1
            satisfied = condition?.isSatisfied(by: summaries, complete: truncatedReason == nil, windowMatched: observedWindow != nil) ?? false
            guard let condition, !satisfied, !deadlineExceeded(readDeadline), (ProcessInfo.processInfo.systemUptime - waitStarted) * 1000 < condition.timeoutMilliseconds else { break }
            // ponytail: 有界复用现有 AX 扫描；大型树确有瓶颈时再引入目标区域订阅。
            try await Task.sleep(nanoseconds: UInt64(min(100, max(0, remainingMilliseconds(until: readDeadline)))) * 1_000_000)
        } while true
        let axCompletedTime = CMClockGetTime(CMClockGetHostTimeClock())
        let confirmationMilliseconds = (ProcessInfo.processInfo.systemUptime - waitStarted) * 1000
        generation += 1
        let complete = truncatedReason == nil
        let snapshot = ElementSnapshot(generation: generation, pid: app.processIdentifier, elements: elements, summaries: summaries, complete: complete)
        snapshots[app.processIdentifier] = snapshot
        snapshotHistory[generation] = snapshot
        if snapshotHistory.count > 8 {
            for key in snapshotHistory.keys.sorted().dropLast(8) { snapshotHistory.removeValue(forKey: key) }
        }
        var result: [String: Any] = [
            "app": app.bundleIdentifier ?? app.bundleURL?.path ?? app.localizedName ?? "",
            "application": appSummary(app),
            "snapshot_generation": generation,
            "action_sequence": actionSequence,
            "window": target.metadata,
            "control": control.status,
            "elements": summaries,
            "text": accessibilityText(summaries),
            "complete": complete,
            "truncated": !complete,
            "status": status(),
            "observation": ["ax_started_at_unix_ms": axStartedAt.timeIntervalSince1970 * 1000, "ax_finished_at_unix_ms": axFinishedAt.timeIntervalSince1970 * 1000, "atomic": false],
        ]
        if condition != nil {
            result["confirmation"] = ["status": satisfied ? "satisfied" : "timed_out", "scope": "accessibility_condition", "elapsed_ms": confirmationMilliseconds, "read_count": readCount]
        }
        if let truncatedReason { result["truncated_reason"] = truncatedReason }
        let screenshotStarted = ProcessInfo.processInfo.systemUptime
        if params["include_screenshot"] as? Bool != false {
            if remainingMilliseconds(until: deadlineUnixMilliseconds) < minimumScreenshotBudgetMilliseconds {
                result["screenshot_status"] = "skipped_deadline"
            } else if !CGPreflightScreenCaptureAccess() {
                result["screenshot_status"] = "permission_unavailable"
            } else {
                reportProgress(params, stage: "screenshot", elementCount: elements.count, startedAt: startedAt)
                do {
                    if let screenshot = try await captureWindow(app, notBefore: axCompletedTime) {
                        result["screenshot"] = screenshot
                        result["screenshot_status"] = "captured"
                    } else {
                        result["screenshot_status"] = "window_unavailable"
                    }
                } catch {
                    result["screenshot_status"] = "capture_failed"
                }
            }
        }
        let screenshotMilliseconds = (ProcessInfo.processInfo.systemUptime - screenshotStarted) * 1000
        if let previous = intValue(params["previous_snapshot_generation"]) {
            result["diff"] = snapshotDiff(previousGeneration: previous, current: snapshot)
        }
        if condition != nil { _ = try control.requireTarget(pid: app.processIdentifier, sessionId: controlSessionId) }
        result["diagnostics"] = ["axElementCount": elements.count, "ax_read_ms": axMilliseconds, "read_count": readCount, "confirmation_ms": condition == nil ? 0 : confirmationMilliseconds, "screenshot_ms": screenshotMilliseconds, "native_total_ms": (ProcessInfo.processInfo.systemUptime - startedUptime) * 1000]
        reportProgress(params, stage: "complete", elementCount: elements.count, startedAt: startedAt)
        return result
    }

    @discardableResult
    private func walk(
        element: AXUIElement,
        depth: Int,
        maxElements: Int,
        deadlineUnixMilliseconds: Double?,
        visited: inout Set<CFHashCode>,
        elements: inout [AXUIElement],
        summaries: inout [[String: Any]],
        truncatedReason: inout String?,
        progress: (Int) -> Void
    ) -> Bool {
        if elements.count >= maxElements {
            truncatedReason = truncatedReason ?? "element_limit"
            return true
        }
        guard depth <= 32 else {
            truncatedReason = truncatedReason ?? "depth_limit"
            return false
        }
        if deadlineExceeded(deadlineUnixMilliseconds) {
            truncatedReason = "deadline"
            return true
        }
        let identity = CFHash(element)
        guard visited.insert(identity).inserted else { return false }
        let index = elements.count
        let described = describeElement(element, index: index, depth: depth, includeValue: true, includeActions: true, includeChildren: true)
        if described.error == .cannotComplete {
            truncatedReason = "ax_cannot_complete"
            return true
        }
        guard let summary = described.summary else {
            truncatedReason = truncatedReason ?? "ax_unavailable"
            return false
        }
        elements.append(element)
        summaries.append(summary)
        progress(elements.count)
        if deadlineExceeded(deadlineUnixMilliseconds) {
            truncatedReason = "deadline"
            return true
        }
        let children = described.children
        for child in children {
            if walk(
                element: child,
                depth: depth + 1,
                maxElements: maxElements,
                deadlineUnixMilliseconds: deadlineUnixMilliseconds,
                visited: &visited,
                elements: &elements,
                summaries: &summaries,
                truncatedReason: &truncatedReason,
                progress: progress
            ) { return true }
        }
        return false
    }

    /** 检查实际执行路径上的控件，不使用先前展示给模型的缓存描述。 */
    private func inspectActionTarget(_ method: String, _ params: [String: Any]) throws -> (element: AXUIElement, summary: [String: Any], state: Data) {
        try requireAccessibility()
        try requireUnlockedSession()
        let (app, requestedElement) = try appAndElement(params, elementRequired: method == "set_value")
        let window = try control.requireTarget(pid: app.processIdentifier, sessionId: controlSessionId)
        if method == "press_key" { _ = try keyChord(params["key"] as? String ?? "") }
        var hitParams = params
        if method == "drag" { hitParams["x"] = params["from_x"] ?? params["start_x"]; hitParams["y"] = params["from_y"] ?? params["start_y"] }
        let focused = focusedElement(app.processIdentifier)
        // 与实际执行函数选择同一控件：文字与粘贴不使用坐标，按键只使用真实焦点。
        let target: AXUIElement?
        if method == "press_key" { target = focused }
        else if ["type_text", "paste"].contains(method) { target = requestedElement ?? focused }
        else if method == "drag" { target = try hitElement(app.processIdentifier, params: hitParams) }
        else { target = try requestedElement ?? hitElement(app.processIdentifier, params: hitParams) }
        guard let target else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_TARGET_UNAVAILABLE", message: "无法确认目标控件；请重新读取目标窗口，动作尚未执行。")
        }
        try requireElementWindow(target, target: window)
        let described = describeElement(target, index: 0, depth: 0, includeValue: false, includeActions: false, includeChildren: false)
        guard var summary = described.summary else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_TARGET_UNAVAILABLE", message: "无法读取目标控件信息；请重新观察，动作尚未执行。")
        }
        var valueSettable = DarwinBoolean(false)
        var selectedTextSettable = DarwinBoolean(false)
        let role = summary["role"] as? String ?? ""
        summary["editable"] = [kAXTextFieldRole, kAXTextAreaRole, "AXSecureTextField"].contains(role) && (
            (AXUIElementIsAttributeSettable(target, kAXValueAttribute as CFString, &valueSettable) == .success && valueSettable.boolValue) ||
            (AXUIElementIsAttributeSettable(target, kAXSelectedTextAttribute as CFString, &selectedTextSettable) == .success && selectedTextSettable.boolValue)
        )
        summary["appName"] = app.localizedName ?? app.bundleIdentifier ?? app.bundleURL?.path ?? ""
        summary["windowId"] = window.windowId
        let axWindow = attribute(target, kAXWindowAttribute).flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
        summary["windowTitle"] = axWindow.flatMap { stringAttribute($0, kAXTitleAttribute) } ?? ""
        var state = summary
        state["pid"] = Int(app.processIdentifier)
        state["window"] = window.metadata
        state["content"] = actionContentFingerprint(target)
        // 回车可能走默认按钮；等待期间该按钮发生变化也必须重新确认。
        if let axWindow, let defaultButton = attribute(axWindow, kAXDefaultButtonAttribute), CFGetTypeID(defaultButton) == AXUIElementGetTypeID() {
            let button = defaultButton as! AXUIElement
            state["defaultButton"] = describeElement(button, index: 0, depth: 0, includeValue: false, includeActions: false, includeChildren: false).summary
            state["defaultButtonIdentity"] = String(CFHash(button))
        }
        // 点击发送按钮时也绑定当前输入焦点及草稿内容，等待确认期间不能悄悄换稿。
        if let focused { state["focus"] = String(CFHash(focused)); state["focusContent"] = actionContentFingerprint(focused) }
        return (target, summary, try encoder.data(withJSONObject: state, options: [.sortedKeys]))
    }

    /** 内容只在原生服务内做完整指纹比较，密码值不读取也不回传给模型。 */
    private func actionContentFingerprint(_ element: AXUIElement) -> String {
        guard (try? rejectSecure(element)) != nil else { return "secure" }
        let value = stringAttribute(element, kAXValueAttribute) ?? ""
        let digest = SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
        var range = CFRange(location: -1, length: -1)
        if let selection = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(selection) == AXValueGetTypeID(), AXValueGetType(selection as! AXValue) == .cfRange {
            _ = AXValueGetValue(selection as! AXValue, .cfRange, &range)
        }
        return "\(digest):\(range.location):\(range.length)"
    }

    /** 排除传输编号、校验字段和宿主审批后设置的读取时限；动作及观察条件仍绑定本次批准。 */
    private func actionArguments(_ params: [String: Any]) throws -> Data {
        try encoder.data(withJSONObject: params.filter { !["_request_id", "_action_tool", "_action_token", "_deadline_unix_ms"].contains($0.key) }, options: [.sortedKeys])
    }

    /** 为宿主提供可确认的目标，并签发只用于这一次动作的凭据。 */
    private func describeTarget(_ params: [String: Any]) throws -> [String: Any] {
        preparedAction = nil
        guard let method = params["_action_tool"] as? String, preparedActionMethods.contains(method) else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_ACTION_REQUIRED", message: "目标检查缺少具体动作。")
        }
        let target = try inspectActionTarget(method, params)
        let token = UUID().uuidString
        preparedAction = PreparedComputerAction(token: token, method: method, arguments: try actionArguments(params), element: target.element, state: target.state)
        return target.summary.merging(["token": token]) { _, value in value }
    }

    /** 在实际输入前消费凭据并重新读取目标；确认不能授权变化后的控件或内容。 */
    private func validatePreparedAction(_ method: String, _ params: [String: Any]) throws {
        let prepared = preparedAction
        preparedAction = nil
        guard let prepared, params["_action_token"] as? String == prepared.token, method == prepared.method, try actionArguments(params) == prepared.arguments else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_ACTION_CHANGED", message: "本次操作的目标检查已失效，动作尚未执行；请重新观察后发起操作。")
        }
        let current = try inspectActionTarget(method, params)
        guard CFEqual(current.element, prepared.element), current.state == prepared.state else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_ACTION_CHANGED", message: "等待期间目标窗口、控件或内容已变化，动作尚未执行；请重新观察并确认实际操作。")
        }
    }

    private func resolveApplication(_ params: [String: Any]) async throws -> NSRunningApplication {
        guard let requested = params["app"] as? String, !requested.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_APP_REQUIRED", message: "Computer 请求缺少 app。")
        }
        let value = requested.trimmingCharacters(in: .whitespacesAndNewlines)
        if let running = NSWorkspace.shared.runningApplications.first(where: {
            $0.bundleIdentifier == value || $0.bundleURL?.standardizedFileURL.path == URL(fileURLWithPath: value).standardizedFileURL.path || $0.localizedName?.caseInsensitiveCompare(value) == .orderedSame
        }) { return running }

        throw ServiceFailure(code: "ZEUS_COMPUTER_APP_NOT_RUNNING", message: "目标应用当前没有运行；Zeus 不会为 Computer Use 在后台启动应用：\(value)")
    }

    /** 允许独立测试实例；当前宿主、控制服务和正式实例仍不可控制，保护自身审批。 */
    private func rejectSelf(_ app: NSRunningApplication) throws {
        if app.processIdentifier == parentPid || app.processIdentifier == ProcessInfo.processInfo.processIdentifier || ["dev.hypha.zeus.helper.computer", "dev.hypha.zeus.test.helper.computer"].contains(app.bundleIdentifier ?? "") {
            throw ServiceFailure(code: "ZEUS_COMPUTER_SELF_CONTROL_BLOCKED", message: "当前 Zeus 实例不能控制自身或自身审批界面。")
        }
        if app.bundleIdentifier == "dev.hypha.zeus" {
            throw ServiceFailure(code: "ZEUS_COMPUTER_ZEUS_CONTROL_BLOCKED", message: "不能控制正式 Zeus 实例；请使用独立的 Zeus Test 实例进行验收。")
        }
    }

    /** 应用列表与读取、点击、输入共用相同的实例边界。 */
    private func canControl(_ app: NSRunningApplication) -> Bool {
        (try? rejectSelf(app)) != nil
    }

    private func requireAccessibility() throws {
        guard AXIsProcessTrusted() else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_ACCESSIBILITY_PERMISSION_REQUIRED", message: "Zeus Computer Service 尚未获得 macOS 辅助功能权限。")
        }
    }

    private func requireUnlockedSession() throws {
        guard let dictionary = CGSessionCopyCurrentDictionary() as? [String: Any] else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_SESSION_UNAVAILABLE", message: "无法确认当前图形会话状态。")
        }
        if dictionary["CGSSessionScreenIsLocked"] as? Bool == true || dictionary[kCGSessionOnConsoleKey as String] as? Bool == false {
            throw ServiceFailure(code: "ZEUS_COMPUTER_SCREEN_LOCKED", message: "锁屏或非控制台会话中禁止 Computer Use。")
        }
    }

    private func appAndElement(_ params: [String: Any], elementRequired: Bool) throws -> (NSRunningApplication, AXUIElement?) {
        guard let requested = params["app"] as? String else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_APP_REQUIRED", message: "Computer 请求缺少 app。")
        }
        guard let app = NSWorkspace.shared.runningApplications.first(where: {
            $0.bundleIdentifier == requested || $0.bundleURL?.standardizedFileURL.path == URL(fileURLWithPath: requested).standardizedFileURL.path || $0.localizedName?.caseInsensitiveCompare(requested) == .orderedSame
        }) else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_APP_NOT_RUNNING", message: "目标应用当前没有运行，请先调用 get_app_state。")
        }
        try rejectSelf(app)
        let target = try control.requireTarget(pid: app.processIdentifier, sessionId: controlSessionId)
        guard let elementIndex = intValue(params["element_index"]) else {
            if elementRequired { throw ServiceFailure(code: "ZEUS_COMPUTER_ELEMENT_REQUIRED", message: "该操作需要 element_index。") }
            return (app, nil)
        }
        guard let requestedGeneration = intValue(params["snapshot_generation"]),
              let snapshot = snapshots[app.processIdentifier],
              snapshot.generation == requestedGeneration,
              elementIndex >= 0,
              elementIndex < snapshot.elements.count
        else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_ELEMENT_STALE", message: "element_index 已过期，请重新调用 get_app_state。")
        }
        let element = snapshot.elements[elementIndex]
        try requireElementWindow(element, target: target)
        return (app, element)
    }

    /** 语义动作不能利用同一应用的旧元素跨到未观察窗口。 */
    private func requireElementWindow(_ element: AXUIElement, target: ComputerWindowTarget) throws {
        let value = attribute(element, kAXWindowAttribute)
        let window = stringAttribute(element, kAXRoleAttribute) == kAXWindowRole ? element : value.flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
        guard let window, matchesWindow(window, target: target) else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_WINDOW_MISMATCH", message: "无法确认元素或键盘焦点属于已观察窗口，请重新观察目标窗口。")
        }
    }

    /** 辅助功能窗口与采集窗口使用相同的逻辑边界，允许系统的小数舍入。 */
    private func matchesWindow(_ element: AXUIElement, target: ComputerWindowTarget) -> Bool {
        guard let frame = frameAttribute(element), let x = frame["x"], let y = frame["y"], let width = frame["width"], let height = frame["height"] else { return false }
        return abs(x - target.frame.minX) < 1 && abs(y - target.frame.minY) < 1 && abs(width - target.frame.width) < 1 && abs(height - target.frame.height) < 1
    }

    private func performClick(_ params: [String: Any], secondary: Bool) throws -> [String: Any] {
        try requireAccessibility()
        try requireUnlockedSession()
        let (app, requestedElement) = try appAndElement(params, elementRequired: false)
        // 坐标也先命中目标应用自己的语义元素，后台控件不依赖前台鼠标路由。
        let element = try requestedElement ?? hitElement(app.processIdentifier, params: params)
        if let element { try requireElementWindow(element, target: control.requireTarget(pid: app.processIdentifier, sessionId: controlSessionId)) }
        defer { control.didMutate() }
        if let element, let point = centerPoint(element) { control.showCursor(point) }
        if secondary {
            guard let element, let action = params["action"] as? String, !action.isEmpty else {
                throw ServiceFailure(code: "ZEUS_COMPUTER_SECONDARY_ACTION_INVALID", message: "perform_secondary_action 需要元素公开的 action。")
            }
            guard AXUIElementPerformAction(element, action as CFString) == .success else {
                throw ServiceFailure(code: "ZEUS_COMPUTER_SECONDARY_ACTION_FAILED", message: "目标元素拒绝辅助功能动作：\(action)")
            }
            return ["performed": action, "semantic": true]
        }
        let requestedButton = try mouseButton(params["mouse_button"])
        let requestedCount = boundedInt(params["click_count"], fallback: 1, min: 1, max: 3)
        if let element {
            if requestedButton == .left && requestedCount == 1 && AXUIElementPerformAction(element, kAXPressAction as CFString) == .success {
                return ["performed": "press", "semantic": true]
            }
            if let point = centerPoint(element) {
                try postClick(pid: app.processIdentifier, point: point, button: requestedButton, count: requestedCount)
                control.showCursor(point)
                return ["dispatched": "click", "semantic": false, "effect_verified": false]
            }
        }
        guard let x = numberValue(params["x"]), let y = numberValue(params["y"]) else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_TARGET_REQUIRED", message: "点击需要语义元素或坐标。")
        }
        try postClick(pid: app.processIdentifier, point: CGPoint(x: x, y: y), button: requestedButton, count: requestedCount)
        control.showCursor(CGPoint(x: x, y: y))
        return ["dispatched": "click", "semantic": false, "click_count": requestedCount, "effect_verified": false]
    }

    /** 按约定的持续时间投递拖拽，每一步重新检查停止和窗口身份。 */
    private func performDrag(_ params: [String: Any]) async throws -> [String: Any] {
        try requireAccessibility()
        try requireUnlockedSession()
        let (app, _) = try appAndElement(params, elementRequired: false)
        guard let startX = numberValue(params["from_x"] ?? params["start_x"]), let startY = numberValue(params["from_y"] ?? params["start_y"]),
              let endX = numberValue(params["to_x"] ?? params["end_x"]), let endY = numberValue(params["to_y"] ?? params["end_y"])
        else { throw ServiceFailure(code: "ZEUS_COMPUTER_DRAG_INVALID", message: "拖拽坐标不完整。") }
        let start = CGPoint(x: startX, y: startY)
        let end = CGPoint(x: endX, y: endY)
        let target = try control.requireTarget(pid: app.processIdentifier, sessionId: controlSessionId)
        guard target.frame.contains(start), target.frame.contains(end) else { throw ServiceFailure(code: "ZEUS_COMPUTER_POINT_OUTSIDE_WINDOW", message: "拖拽起终点必须位于已观察窗口。") }
        let duration = boundedInt(params["duration_ms"], fallback: 300, min: 0, max: 5000)
        defer { control.didMutate() }
        try postMouse(pid: app.processIdentifier, type: .leftMouseDown, point: start, button: .left)
        for step in 1...16 {
            let fraction = CGFloat(step) / 16
            let point = CGPoint(x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction)
            try postMouse(pid: app.processIdentifier, type: .leftMouseDragged, point: point, button: .left)
            control.showCursor(point)
            if duration > 0 { try await Task.sleep(nanoseconds: UInt64(duration) * 1_000_000 / 16) }
        }
        try postMouse(pid: app.processIdentifier, type: .leftMouseUp, point: end, button: .left)
        control.showCursor(end)
        return ["dispatched": "drag", "effect_verified": false, "start": ["x": startX, "y": startY], "end": ["x": endX, "y": endY]]
    }

    private func performPaste(_ params: [String: Any]) throws -> [String: Any] {
        try requireAccessibility()
        try requireUnlockedSession()
        let (app, element) = try appAndElement(params, elementRequired: false)
        if let element { try rejectSecure(element); try focus(element) }
        else if let focused = focusedElement(app.processIdentifier) { try rejectSecure(focused) }
        guard let text = params["text"] as? String else { throw ServiceFailure(code: "ZEUS_COMPUTER_TEXT_REQUIRED", message: "paste 缺少 text。") }
        let pasteboard = NSPasteboard.general
        let previous = snapshotPasteboard(pasteboard)
        let format = params["format"] as? String ?? "text"
        guard ["text", "md", "html"].contains(format) else { throw ServiceFailure(code: "ZEUS_COMPUTER_PASTE_FORMAT_INVALID", message: "paste format 仅支持 text、md 或 html。") }
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        if format == "html" { pasteboard.setString(text, forType: .html) }
        if format == "md" { pasteboard.setString(text, forType: NSPasteboard.PasteboardType("net.daringfireball.markdown")) }
        let zeusChangeCount = pasteboard.changeCount
        // 无论投递是否成功，只在剪贴板仍属于本次粘贴时恢复，避免覆盖用户的新复制。
        defer { if pasteboard.changeCount == zeusChangeCount { restorePasteboard(pasteboard, previous) } }
        try postKeyChord(pid: app.processIdentifier, keyCode: 9, flags: .maskCommand)
        Thread.sleep(forTimeInterval: 0.25)
        let shouldRestore = pasteboard.changeCount == zeusChangeCount
        return ["dispatched": "paste", "effect_verified": false, "format": format, "length": text.utf16.count, "clipboardRestored": shouldRestore]
    }

    private func performKey(_ params: [String: Any]) throws -> [String: Any] {
        try requireAccessibility()
        try requireUnlockedSession()
        let (app, _) = try appAndElement(params, elementRequired: false)
        guard let chord = params["key"] as? String else { throw ServiceFailure(code: "ZEUS_COMPUTER_KEY_REQUIRED", message: "press_key 缺少 key。") }
        let parsed = try keyChord(chord)
        try postKeyChord(pid: app.processIdentifier, keyCode: parsed.code, flags: parsed.flags)
        return ["dispatched": "key", "key": chord, "effect_verified": false]
    }

    private func performScroll(_ params: [String: Any]) throws -> [String: Any] {
        try requireAccessibility()
        try requireUnlockedSession()
        let (app, requestedElement) = try appAndElement(params, elementRequired: false)
        let element = try requestedElement ?? hitElement(app.processIdentifier, params: params)
        defer { control.didMutate() }
        let direction = (params["direction"] as? String ?? "down").lowercased()
        let normalized = ["u": "up", "d": "down", "l": "left", "r": "right"][direction] ?? direction
        guard ["up", "down", "left", "right"].contains(normalized) else { throw ServiceFailure(code: "ZEUS_COMPUTER_SCROLL_DIRECTION_INVALID", message: "scroll direction 无效。") }
        let pages = max(0.1, min(100, numberValue(params["pages"]) ?? 1))
        if let element {
            let actions = ["up": "AXScrollUpByPage", "down": "AXScrollDownByPage", "left": "AXScrollLeftByPage", "right": "AXScrollRightByPage"]
            let count = max(1, Int(ceil(pages)))
            var completed = 0
            for _ in 0..<count where AXUIElementPerformAction(element, actions[normalized]! as CFString) == .success { completed += 1 }
            if completed > 0 { return ["scrolled": true, "semantic": true, "direction": normalized, "pages": completed] }
        }
        let distance = Int32(min(Double(Int32.max), 600 * pages))
        let deltaX: Int32 = normalized == "left" ? -distance : normalized == "right" ? distance : 0
        let deltaY: Int32 = normalized == "up" ? distance : normalized == "down" ? -distance : 0
        guard let scroll = CGEvent(scrollWheelEvent2Source: inputSource, units: .pixel, wheelCount: 2, wheel1: deltaY, wheel2: deltaX, wheel3: 0) else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_EVENT_CREATION_FAILED", message: "无法创建滚动事件。")
        }
        let point: CGPoint
        if let x = numberValue(params["x"]), let y = numberValue(params["y"]) { point = CGPoint(x: x, y: y) }
        else if let element, let center = centerPoint(element) { point = center }
        else { throw ServiceFailure(code: "ZEUS_COMPUTER_TARGET_REQUIRED", message: "滚动需要元素或明确坐标，不能使用用户鼠标位置。") }
        // AppKit 事件携带真实窗口归属；仅填写“鼠标下窗口”字段不足以路由到目标窗口。
        let event = try windowMouseEvent(pid: app.processIdentifier, type: .mouseMoved, point: point, clickState: 0)
        event.type = .scrollWheel
        for field: CGEventField in [.scrollWheelEventDeltaAxis1, .scrollWheelEventDeltaAxis2, .scrollWheelEventFixedPtDeltaAxis1, .scrollWheelEventFixedPtDeltaAxis2, .scrollWheelEventPointDeltaAxis1, .scrollWheelEventPointDeltaAxis2, .scrollWheelEventIsContinuous] {
            event.setIntegerValueField(field, value: scroll.getIntegerValueField(field))
        }
        try postEvent(event, pid: app.processIdentifier, point: point)
        control.showCursor(point)
        return ["dispatched": "scroll", "effect_verified": false, "semantic": false, "direction": normalized, "pages": pages, "delta_x": deltaX, "delta_y": deltaY]
    }

    private func selectText(_ params: [String: Any]) throws -> [String: Any] {
        try requireAccessibility()
        try requireUnlockedSession()
        let (_, element) = try appAndElement(params, elementRequired: true)
        defer { control.didMutate() }
        guard let element else { throw ServiceFailure(code: "ZEUS_COMPUTER_ELEMENT_REQUIRED", message: "select_text 缺少元素。") }
        try rejectSecure(element)
        guard let requested = params["text"] as? String, !requested.isEmpty,
              let current = stringAttribute(element, kAXValueAttribute)
        else { throw ServiceFailure(code: "ZEUS_COMPUTER_SELECT_TEXT_INVALID", message: "select_text 需要可编辑元素中的非空 text。") }
        let matches = textMatches(current: current, text: requested, prefix: params["prefix"] as? String, suffix: params["suffix"] as? String)
        guard matches.count == 1, let match = matches.first else {
            throw ServiceFailure(code: matches.isEmpty ? "ZEUS_COMPUTER_TEXT_NOT_FOUND" : "ZEUS_COMPUTER_TEXT_AMBIGUOUS", message: matches.isEmpty ? "目标元素中未找到指定文本。" : "指定文本出现多次，请提供 prefix 或 suffix。")
        }
        let selectionType = params["selection_type"] as? String ?? "text"
        var location = match.location
        var length = match.length
        if selectionType == "cursor_before" { length = 0 }
        else if selectionType == "cursor_after" { location += length; length = 0 }
        else if selectionType != "text" { throw ServiceFailure(code: "ZEUS_COMPUTER_SELECTION_TYPE_INVALID", message: "selection_type 无效。") }
        var range = CFRange(location: location, length: length)
        guard let value = AXValueCreate(.cfRange, &range), AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value) == .success else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_SELECT_TEXT_FAILED", message: "目标元素不支持文本范围选择。")
        }
        return ["selected": true, "text": requested, "selection_type": selectionType, "start": location, "end": location + length]
    }

    private func setValue(_ params: [String: Any]) throws -> [String: Any] {
        try requireAccessibility()
        try requireUnlockedSession()
        let (_, element) = try appAndElement(params, elementRequired: true)
        defer { control.didMutate() }
        guard let element, let value = params["value"] as? String else { throw ServiceFailure(code: "ZEUS_COMPUTER_VALUE_REQUIRED", message: "set_value 参数不完整。") }
        try rejectSecure(element)
        guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef) == .success else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_SET_VALUE_FAILED", message: "目标元素拒绝设置值。")
        }
        return ["set": true, "length": value.utf16.count]
    }

    private func typeText(_ params: [String: Any]) throws -> [String: Any] {
        try requireAccessibility()
        try requireUnlockedSession()
        let (app, element) = try appAndElement(params, elementRequired: false)
        guard let text = params["text"] as? String else { throw ServiceFailure(code: "ZEUS_COMPUTER_TEXT_REQUIRED", message: "type_text 缺少 text。") }
        guard let target = element ?? focusedElement(app.processIdentifier) else { throw ServiceFailure(code: "ZEUS_COMPUTER_ELEMENT_REQUIRED", message: "文字输入需要明确的可编辑元素。") }
        try rejectSecure(target)
        try requireElementWindow(target, target: control.requireTarget(pid: app.processIdentifier, sessionId: controlSessionId))
        if element != nil { try focus(target) }
        defer { control.didMutate() }
        var selectedTextSettable = DarwinBoolean(false)
        // Chromium 单行框声明可写 SelectedText 却可能不更新值，直接使用可验证的值与范围接口。
        let singleLine = stringAttribute(target, kAXRoleAttribute) == kAXTextFieldRole
        if !singleLine && AXUIElementIsAttributeSettable(target, kAXSelectedTextAttribute as CFString, &selectedTextSettable) == .success && selectedTextSettable.boolValue {
            guard AXUIElementSetAttributeValue(target, kAXSelectedTextAttribute as CFString, text as CFString) == .success else { throw ServiceFailure(code: "ZEUS_COMPUTER_TEXT_INSERT_FAILED", message: "目标控件拒绝插入文字。") }
        } else {
            // 单行输入框可保留已有值和选择范围；富文本与自绘编辑器不退化成整篇替换。
            guard singleLine,
                  let current = stringAttribute(target, kAXValueAttribute),
                  let selection = attribute(target, kAXSelectedTextRangeAttribute), CFGetTypeID(selection) == AXValueGetTypeID(), AXValueGetType(selection as! AXValue) == .cfRange else {
                throw ServiceFailure(code: "ZEUS_COMPUTER_TEXT_INPUT_UNSUPPORTED", message: "目标控件不支持后台文字插入；请使用明确的粘贴操作或由用户接管。")
            }
            var range = CFRange()
            guard AXValueGetValue(selection as! AXValue, .cfRange, &range), range.location >= 0, range.length >= 0,
                  range.location <= (current as NSString).length, range.length <= (current as NSString).length - range.location else {
                throw ServiceFailure(code: "ZEUS_COMPUTER_TEXT_SELECTION_INVALID", message: "无法确认文字选择范围，请重新观察。")
            }
            let replacement = (current as NSString).replacingCharacters(in: NSRange(location: range.location, length: range.length), with: text)
            guard AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, replacement as CFString) == .success else { throw ServiceFailure(code: "ZEUS_COMPUTER_TEXT_INSERT_FAILED", message: "目标控件拒绝插入文字。") }
            var caret = CFRange(location: range.location + text.utf16.count, length: 0)
            guard let value = AXValueCreate(.cfRange, &caret), AXUIElementSetAttributeValue(target, kAXSelectedTextRangeAttribute as CFString, value) == .success else {
                throw ServiceFailure(code: "ZEUS_COMPUTER_EFFECT_UNKNOWN", message: "文字已写入，但无法确认光标位置；请重新观察，不得自动重复输入。")
            }
        }
        return ["typed": true, "length": text.utf16.count, "semantic": true]
    }

    /** 使用应用自己的命中检测，避免被前台应用遮挡时误读或点击其他应用。 */
    private func hitElement(_ pid: pid_t, params: [String: Any]) throws -> AXUIElement? {
        guard let x = numberValue(params["x"]), let y = numberValue(params["y"]) else { return nil }
        let target = try control.requireTarget(pid: pid, sessionId: controlSessionId)
        guard x.isFinite, y.isFinite, target.frame.contains(CGPoint(x: x, y: y)) else { throw ServiceFailure(code: "ZEUS_COMPUTER_POINT_OUTSIDE_WINDOW", message: "坐标必须位于已观察窗口。") }
        var element: AXUIElement?
        guard AXUIElementCopyElementAtPosition(AXUIElementCreateApplication(pid), Float(x), Float(y), &element) == .success,
              let element, elementProcessIdentifier(element) == pid else { return nil }
        return element
    }

    private func focus(_ element: AXUIElement) throws {
        guard AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_FOCUS_FAILED", message: "目标元素无法获得焦点。")
        }
    }

    private func rejectSecure(_ element: AXUIElement) throws {
        let role = stringAttribute(element, kAXRoleAttribute) ?? ""
        let subrole = stringAttribute(element, kAXSubroleAttribute) ?? ""
        if role == "AXSecureTextField" || subrole.localizedCaseInsensitiveContains("secure") {
            throw ServiceFailure(code: "ZEUS_COMPUTER_SECURE_FIELD_BLOCKED", message: "Zeus 不读取或填写密码、验证码及其他安全文本字段。")
        }
    }

    /** 后台应用可能不公开应用级焦点，改从已观察窗口实时确认唯一焦点控件。 */
    private func focusedElement(_ pid: pid_t) -> AXUIElement? {
        let application = AXUIElementCreateApplication(pid)
        if let value = attribute(application, kAXFocusedUIElementAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() { return (value as! AXUIElement) }
        guard let snapshot = snapshots[pid], snapshot.complete, let window = try? control.requireTarget(pid: pid, sessionId: controlSessionId) else { return nil }
        // ponytail: 应用级接口缺失时扫描当前完整快照的存活控件；若实测延迟过高再接入窗口级焦点通知。
        let focused = snapshot.elements.filter { boolAttribute($0, kAXFocusedAttribute) == true && (try? requireElementWindow($0, target: window)) != nil }
        return focused.count == 1 ? focused[0] : nil
    }

    private func snapshotDiff(previousGeneration: Int, current: ElementSnapshot) -> [String: Any] {
        guard let previous = snapshotHistory[previousGeneration], previous.pid == current.pid else {
            return ["previous_generation": previousGeneration, "current_generation": current.generation, "available": false, "reason": "previous_snapshot_expired"]
        }
        guard previous.complete, current.complete else {
            return ["previous_generation": previousGeneration, "current_generation": current.generation, "available": false, "reason": "incomplete_snapshot"]
        }
        let keyed: ([[String: Any]]) -> [String: [String: Any]] = { values in
            Dictionary(uniqueKeysWithValues: values.enumerated().map { index, value in
                let key = [value["role"], value["subrole"], value["identifier"], value["title"], value["depth"]].map { String(describing: $0 ?? "") }.joined(separator: "\u{001f}") + "\u{001f}\(index)"
                return (key, value)
            })
        }
        let old = keyed(previous.summaries)
        let next = keyed(current.summaries)
        let added = next.keys.filter { old[$0] == nil }.prefix(200).compactMap { next[$0] }
        let removed = old.keys.filter { next[$0] == nil }.prefix(200).compactMap { old[$0] }
        let changed = next.keys.compactMap { key -> [String: Any]? in
            guard let before = old[key], let after = next[key] else { return nil }
            let beforeData = try? JSONSerialization.data(withJSONObject: before, options: [.sortedKeys])
            let afterData = try? JSONSerialization.data(withJSONObject: after, options: [.sortedKeys])
            return beforeData != afterData ? ["before": before, "after": after] : nil
        }.prefix(200)
        return [
            "previous_generation": previousGeneration,
            "current_generation": current.generation,
            "available": true,
            "changed": Array(changed),
            "added": Array(added),
            "removed": Array(removed),
            "truncated": added.count >= 200 || removed.count >= 200 || changed.count >= 200,
        ]
    }

    private func postClick(pid: pid_t, point: CGPoint, button: CGMouseButton, count: Int) throws {
        let down: CGEventType = button == .right ? .rightMouseDown : button == .center ? .otherMouseDown : .leftMouseDown
        let up: CGEventType = button == .right ? .rightMouseUp : button == .center ? .otherMouseUp : .leftMouseUp
        for click in 1...count {
            try postMouse(pid: pid, type: down, point: point, button: button, clickState: Int64(click))
            try postMouse(pid: pid, type: up, point: point, button: button, clickState: Int64(click))
        }
    }

    private func postMouse(pid: pid_t, type: CGEventType, point: CGPoint, button: CGMouseButton, clickState: Int64 = 1) throws {
        let event = try windowMouseEvent(pid: pid, type: type, point: point, clickState: clickState)
        event.setIntegerValueField(.mouseEventButtonNumber, value: Int64(button.rawValue))
        event.setIntegerValueField(.mouseEventClickState, value: clickState)
        try postEvent(event, pid: pid, point: point)
    }

    /** 用公开 AppKit 构造器附带窗口身份，再设置全局逻辑坐标与独立输入状态。 */
    private func windowMouseEvent(pid: pid_t, type: CGEventType, point: CGPoint, clickState: Int64) throws -> CGEvent {
        let target = try control.requireTarget(pid: pid, sessionId: controlSessionId)
        guard let eventType = NSEvent.EventType(rawValue: UInt(type.rawValue)),
              let event = NSEvent.mouseEvent(with: eventType, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                            windowNumber: Int(target.windowId), context: nil, eventNumber: 0, clickCount: Int(clickState), pressure: 1)?.cgEvent else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_EVENT_CREATION_FAILED", message: "无法创建目标窗口鼠标事件。")
        }
        event.setSource(inputSource)
        event.location = point
        return event
    }

    /** 键盘事件也携带目标窗口，不能依赖 WindowServer 的当前前台窗口。 */
    private func windowKeyEvent(pid: pid_t, keyCode: CGKeyCode, down: Bool, flags: CGEventFlags) throws -> CGEvent {
        let target = try control.requireTarget(pid: pid, sessionId: controlSessionId)
        // 由系统键盘布局提供按键字符，空字符的 AppKit 事件会被部分应用直接忽略。
        guard let base = CGEvent(keyboardEventSource: inputSource, virtualKey: keyCode, keyDown: down) else { throw ServiceFailure(code: "ZEUS_COMPUTER_EVENT_CREATION_FAILED", message: "无法创建按键。") }
        base.flags = flags
        let translated = NSEvent(cgEvent: base)
        guard let event = NSEvent.keyEvent(with: down ? .keyDown : .keyUp, location: .zero, modifierFlags: NSEvent.ModifierFlags(rawValue: UInt(flags.rawValue)),
                                          timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: Int(target.windowId), context: nil,
                                          characters: translated?.characters ?? "", charactersIgnoringModifiers: translated?.charactersIgnoringModifiers ?? "", isARepeat: false, keyCode: keyCode)?.cgEvent else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_EVENT_CREATION_FAILED", message: "无法创建目标窗口键盘事件。")
        }
        event.setSource(inputSource)
        event.flags = flags
        return event
    }

    /** 所有合成输入共用目标窗口校验及路由，不激活应用、不写全局鼠标位置。 */
    private func postEvent(_ event: CGEvent, pid: pid_t, point: CGPoint? = nil) throws {
        try requireUnlockedSession()
        let target = try control.requireTarget(pid: pid, sessionId: controlSessionId)
        if let point {
            guard point.x.isFinite, point.y.isFinite, target.frame.contains(point) else { throw ServiceFailure(code: "ZEUS_COMPUTER_POINT_OUTSIDE_WINDOW", message: "坐标不在已观察窗口内；请根据截图 frame 和 scale 换算全局逻辑坐标。") }
            event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(target.windowId))
            event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(target.windowId))
        } else if let focused = focusedElement(pid) {
            try requireElementWindow(focused, target: target)
        }
        try control.postInput(event, pid: pid, sessionId: controlSessionId)
    }

    private func mouseButton(_ value: Any?) throws -> CGMouseButton {
        let button = (value as? String ?? "left").lowercased()
        if button == "left" || button == "l" { return .left }
        if button == "right" || button == "r" { return .right }
        if button == "middle" || button == "m" { return .center }
        throw ServiceFailure(code: "ZEUS_COMPUTER_MOUSE_BUTTON_INVALID", message: "mouse_button 无效。")
    }

    private func postKeyChord(pid: pid_t, keyCode: CGKeyCode, flags: CGEventFlags) throws {
        let down = try windowKeyEvent(pid: pid, keyCode: keyCode, down: true, flags: flags)
        let up = try windowKeyEvent(pid: pid, keyCode: keyCode, down: false, flags: flags)
        try postEvent(down, pid: pid)
        try postEvent(up, pid: pid)
        control.didMutate()
    }

    private func keyChord(_ value: String) throws -> (code: CGKeyCode, flags: CGEventFlags) {
        let parts = value.split(separator: "+").map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard let key = parts.last?.lowercased() else { throw ServiceFailure(code: "ZEUS_COMPUTER_KEY_REQUIRED", message: "按键为空。") }
        var flags: CGEventFlags = []
        for modifier in parts.dropLast().map({ $0.lowercased() }) {
            if modifier == "meta" || modifier == "super" || modifier == "cmd" || modifier == "command" { flags.insert(.maskCommand) }
            else if modifier == "ctrl" || modifier == "control" { flags.insert(.maskControl) }
            else if modifier == "alt" || modifier == "option" { flags.insert(.maskAlternate) }
            else if modifier == "shift" { flags.insert(.maskShift) }
            else { throw ServiceFailure(code: "ZEUS_COMPUTER_KEY_UNSUPPORTED", message: "不支持的修饰键：\(modifier)") }
        }
        let named: [String: CGKeyCode] = [
            "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53,
            "left": 123, "arrowleft": 123, "right": 124, "arrowright": 124, "down": 125, "arrowdown": 125, "up": 126, "arrowup": 126,
            "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        ]
        if let code = named[key] { return (code, flags) }
        let letters = "abcdefghijklmnopqrstuvwxyz"
        let letterCodes: [CGKeyCode] = [0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6]
        if key.count == 1, let index = letters.firstIndex(of: Character(key)) {
            return (letterCodes[letters.distance(from: letters.startIndex, to: index)], flags)
        }
        throw ServiceFailure(code: "ZEUS_COMPUTER_KEY_UNSUPPORTED", message: "不支持的按键：\(key)")
    }

    /** 截图确认时间必须晚于本次控件读取，空闲帧和实际像素采集时间分别标明。 */
    private func captureWindow(_ app: NSRunningApplication, notBefore: CMTime) async throws -> [String: Any]? {
        try FileManager.default.createDirectory(at: artifactRoot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let (image, target, capturedAt, confirmedAt) = try await control.snapshot(notBefore: notBefore)
        let representation = NSBitmapImageRep(cgImage: image)
        guard let png = representation.representation(using: .png, properties: [:]) else { return nil }
        let file = artifactRoot.appendingPathComponent("computer-\(app.processIdentifier)-\(generation)-\(UUID().uuidString).png")
        try png.write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        return target.metadata.merging(["artifactPath": file.path, "mimeType": "image/png", "width": image.width, "height": image.height, "byteLength": png.count, "captured_at": ISO8601DateFormatter().string(from: capturedAt), "frame_confirmed_at": ISO8601DateFormatter().string(from: confirmedAt), "after_ax_read": true]) { _, value in value }
    }

    private func appSummary(_ app: NSRunningApplication) -> [String: Any] {
        ["name": app.localizedName ?? "", "bundleId": app.bundleIdentifier ?? "", "path": app.bundleURL?.path ?? "", "pid": Int(app.processIdentifier)]
    }

    private func accessibilityText(_ summaries: [[String: Any]]) -> String {
        summaries.map { element in
            let index = element["element_index"] as? Int ?? -1
            let depth = element["depth"] as? Int ?? 0
            let role = element["role"] as? String ?? ""
            let title = element["title"] as? String ?? ""
            let description = element["description"] as? String ?? ""
            let value = element["secure"] as? Bool == true ? "<secure>" : String(describing: element["value"] ?? "")
            let actions = (element["actions"] as? [String] ?? []).joined(separator: ",")
            let details = [title, description, value].filter { !$0.isEmpty }.joined(separator: " | ")
            return "\(String(repeating: "  ", count: min(depth, 14)))[\(index)] \(role)\(details.isEmpty ? "" : " \(details)")\(actions.isEmpty ? "" : " actions=\(actions)")"
        }.joined(separator: "\n")
    }

    private func textMatches(current: String, text: String, prefix: String?, suffix: String?) -> [NSRange] {
        let source = current as NSString
        let needle = text as NSString
        guard needle.length > 0 else { return [] }
        var matches: [NSRange] = []
        var location = 0
        while location <= source.length - needle.length {
            let range = source.range(of: text, options: [], range: NSRange(location: location, length: source.length - location))
            if range.location == NSNotFound { break }
            let before = source.substring(to: range.location)
            let after = source.substring(from: range.location + range.length)
            if (prefix == nil || before.hasSuffix(prefix!)) && (suffix == nil || after.hasPrefix(suffix!)) { matches.append(range) }
            location = range.location + max(1, range.length)
        }
        return matches
    }

    private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }

    private func describeElement(
        _ element: AXUIElement,
        index: Int,
        depth: Int,
        includeValue: Bool,
        includeActions: Bool,
        includeChildren: Bool
    ) -> (summary: [String: Any]?, children: [AXUIElement], error: AXError) {
        var names = [
            kAXRoleAttribute,
            kAXSubroleAttribute,
            kAXTitleAttribute,
            kAXDescriptionAttribute,
            kAXIdentifierAttribute,
            kAXEnabledAttribute,
            kAXFocusedAttribute,
            kAXPositionAttribute,
            kAXSizeAttribute,
        ]
        if includeChildren { names.append(kAXChildrenAttribute) }
        let copied = copyAttributes(element, names)
        guard copied.error == .success else { return (nil, [], copied.error) }
        let role = copied.values[kAXRoleAttribute] as? String ?? ""
        guard !role.isEmpty else { return (nil, [], .noValue) }
        let subrole = copied.values[kAXSubroleAttribute] as? String ?? ""
        let secure = role == "AXSecureTextField" || subrole.localizedCaseInsensitiveContains("secure")
        var summary: [String: Any] = [
            "element_index": index,
            "depth": depth,
            "role": role,
            "subrole": subrole,
            "title": copied.values[kAXTitleAttribute] as? String ?? "",
            "description": copied.values[kAXDescriptionAttribute] as? String ?? "",
            "identifier": copied.values[kAXIdentifierAttribute] as? String ?? "",
            "enabled": copied.values[kAXEnabledAttribute] as? Bool ?? true,
            "focused": copied.values[kAXFocusedAttribute] as? Bool ?? false,
            "secure": secure,
        ]
        if includeValue, !secure, let value = safeValueAttribute(element) { summary["value"] = value }
        if let frame = frameFromAttributes(copied.values) { summary["frame"] = frame }
        if includeActions, let actions = actionNames(element), !actions.isEmpty { summary["actions"] = actions }
        return (summary, copied.values[kAXChildrenAttribute] as? [AXUIElement] ?? [], .success)
    }

    private func copyAttributes(_ element: AXUIElement, _ names: [String]) -> (values: [String: Any], error: AXError) {
        var copied: CFArray?
        let error = AXUIElementCopyMultipleAttributeValues(element, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &copied)
        if [.cannotComplete, .invalidUIElement, .apiDisabled].contains(error) { return ([:], error) }
        guard error == .success, let values = copied as? [Any] else {
            return (Dictionary(uniqueKeysWithValues: names.compactMap { name in attribute(element, name).map { (name, $0 as Any) } }), .success)
        }
        var result: [String: Any] = [:]
        for (index, name) in names.enumerated() where index < values.count {
            let value = values[index]
            let cfValue = value as CFTypeRef
            if CFGetTypeID(cfValue) == CFNullGetTypeID() { continue }
            if CFGetTypeID(cfValue) == AXValueGetTypeID(), AXValueGetType(value as! AXValue) == .axError {
                var attributeError = AXError.success
                if AXValueGetValue(value as! AXValue, .axError, &attributeError), [.cannotComplete, .invalidUIElement, .apiDisabled].contains(attributeError) { return ([:], attributeError) }
                continue
            }
            result[name] = value
        }
        return (result, .success)
    }

    private func stringAttribute(_ element: AXUIElement, _ name: String) -> String? { attribute(element, name) as? String }
    private func boolAttribute(_ element: AXUIElement, _ name: String) -> Bool? { attribute(element, name) as? Bool }

    private func safeValueAttribute(_ element: AXUIElement) -> Any? {
        guard let value = attribute(element, kAXValueAttribute) else { return nil }
        if let string = value as? String { return String(string.prefix(20_000)) }
        if let number = value as? NSNumber { return number }
        return nil
    }

    private func actionNames(_ element: AXUIElement) -> [String]? {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success else { return nil }
        return names as? [String]
    }

    private func frameAttribute(_ element: AXUIElement) -> [String: Double]? {
        let copied = copyAttributes(element, [kAXPositionAttribute, kAXSizeAttribute])
        guard copied.error == .success else { return nil }
        return frameFromAttributes(copied.values)
    }

    private func frameFromAttributes(_ values: [String: Any]) -> [String: Double]? {
        guard let positionValue = values[kAXPositionAttribute], CFGetTypeID(positionValue as CFTypeRef) == AXValueGetTypeID(),
              let sizeValue = values[kAXSizeAttribute], CFGetTypeID(sizeValue as CFTypeRef) == AXValueGetTypeID()
        else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &point), AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else { return nil }
        return ["x": point.x, "y": point.y, "width": size.width, "height": size.height]
    }

    private func centerPoint(_ element: AXUIElement) -> CGPoint? {
        guard let frame = frameAttribute(element), let x = frame["x"], let y = frame["y"], let width = frame["width"], let height = frame["height"] else { return nil }
        return CGPoint(x: x + width / 2, y: y + height / 2)
    }

    private func snapshotPasteboard(_ pasteboard: NSPasteboard) -> [[NSPasteboard.PasteboardType: Data]] {
        (pasteboard.pasteboardItems ?? []).map { item in
            Dictionary(uniqueKeysWithValues: item.types.compactMap { type in item.data(forType: type).map { (type, $0) } })
        }
    }

    private func restorePasteboard(_ pasteboard: NSPasteboard, _ snapshot: [[NSPasteboard.PasteboardType: Data]]) {
        pasteboard.clearContents()
        let items = snapshot.map { values -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in values { item.setData(data, forType: type) }
            return item
        }
        if !items.isEmpty { pasteboard.writeObjects(items) }
    }

    private func elementProcessIdentifier(_ element: AXUIElement) -> pid_t? {
        var pid: pid_t = 0
        return AXUIElementGetPid(element, &pid) == .success ? pid : nil
    }

    private func deadlineExceeded(_ deadlineUnixMilliseconds: Double?) -> Bool {
        remainingMilliseconds(until: deadlineUnixMilliseconds) <= 0
    }

    private func remainingMilliseconds(until deadlineUnixMilliseconds: Double?) -> Double {
        guard let deadlineUnixMilliseconds else { return .greatestFiniteMagnitude }
        return deadlineUnixMilliseconds - Date().timeIntervalSince1970 * 1000
    }

    private func reportProgress(_ params: [String: Any], stage: String, elementCount: Int, startedAt: Date) {
        guard let requestId = params["_request_id"] as? String else { return }
        let payload: [String: Any] = [
            "requestId": requestId,
            "stage": stage,
            "elementCount": elementCount,
            "elapsedMs": Int(Date().timeIntervalSince(startedAt) * 1000),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []) else { return }
        FileHandle.standardError.write(Data("ZEUS_COMPUTER_PROGRESS ".utf8))
        FileHandle.standardError.write(data)
        FileHandle.standardError.write(Data([0x0a]))
    }

    private func intValue(_ value: Any?) -> Int? {
        if let number = value as? NSNumber { return number.intValue }
        if let value = value as? Int { return value }
        return nil
    }

    private func numberValue(_ value: Any?) -> Double? {
        if let number = value as? NSNumber { return number.doubleValue }
        if let value = value as? Double { return value }
        return nil
    }

    private func boundedInt(_ value: Any?, fallback: Int, min: Int, max: Int) -> Int {
        Swift.max(min, Swift.min(max, intValue(value) ?? fallback))
    }
}
