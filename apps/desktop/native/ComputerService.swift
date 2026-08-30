import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

private struct ServiceFailure: Error {
    let code: String
    let message: String
}

private struct ElementSnapshot {
    let generation: Int
    let pid: pid_t
    let elements: [AXUIElement]
    let summaries: [[String: Any]]
}

@main
private struct ZeusComputerService {
    static func main() async {
        let service = ComputerService()
        while let line = readLine(strippingNewline: true) {
            guard !line.isEmpty else { continue }
            let response = await service.handle(line: line)
            FileHandle.standardOutput.write(response)
            FileHandle.standardOutput.write(Data([0x0a]))
        }
    }
}

private final class ComputerService {
    private var generation = 0
    private var snapshots: [pid_t: ElementSnapshot] = [:]
    private var snapshotHistory: [Int: ElementSnapshot] = [:]
    private var virtualPointers: [pid_t: CGPoint] = [:]
    private let artifactRoot: URL
    private let parentPid: pid_t
    private let qaMode: Bool
    private let encoder = JSONSerialization.self

    init() {
        let environment = ProcessInfo.processInfo.environment
        let root = environment["ZEUS_COMPUTER_ARTIFACT_ROOT"] ?? NSTemporaryDirectory()
        artifactRoot = URL(fileURLWithPath: root, isDirectory: true).standardizedFileURL
        parentPid = pid_t(Int32(environment["ZEUS_PARENT_PID"] ?? "-1") ?? -1)
        qaMode = environment["ZEUS_COMPUTER_QA_MODE"] == "1"
    }

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
            let params = request["params"] as? [String: Any] ?? [:]
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
        switch method {
        case "status":
            return status()
        case "list_apps":
            return listApps()
        case "get_app_state":
            return try await getAppState(params)
        case "click":
            return try performClick(params, secondary: false)
        case "perform_secondary_action":
            return try performClick(params, secondary: true)
        case "drag":
            return try performDrag(params)
        case "paste":
            return try performPaste(params)
        case "press_key":
            return try performKey(params)
        case "scroll":
            return try performScroll(params)
        case "select_text":
            return try selectText(params)
        case "set_value":
            return try setValue(params)
        case "type_text":
            return try typeText(params)
        default:
            throw ServiceFailure(code: "ZEUS_COMPUTER_METHOD_UNSUPPORTED", message: "Computer 方法不受支持：\(method)")
        }
    }

    private func status() -> [String: Any] {
        [
            "accessibilityTrusted": AXIsProcessTrusted(),
            "screenCaptureAvailable": CGPreflightScreenCaptureAccess(),
            "servicePid": ProcessInfo.processInfo.processIdentifier,
            "protocolVersion": "zeus.computer.v1",
        ]
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

    private func getAppState(_ params: [String: Any]) async throws -> [String: Any] {
        try requireAccessibility()
        try requireUnlockedSession()
        let app = try await resolveApplication(params)
        try rejectSelf(app)
        let maxElements = boundedInt(params["max_elements"], fallback: 500, min: 1, max: 1000)
        let applicationElement = AXUIElementCreateApplication(app.processIdentifier)
        generation += 1
        var elements: [AXUIElement] = []
        var summaries: [[String: Any]] = []
        var visited = Set<CFHashCode>()
        walk(element: applicationElement, depth: 0, maxElements: maxElements, visited: &visited, elements: &elements, summaries: &summaries)
        let snapshot = ElementSnapshot(generation: generation, pid: app.processIdentifier, elements: elements, summaries: summaries)
        snapshots[app.processIdentifier] = snapshot
        snapshotHistory[generation] = snapshot
        if snapshotHistory.count > 8 {
            for key in snapshotHistory.keys.sorted().dropLast(8) { snapshotHistory.removeValue(forKey: key) }
        }
        var result: [String: Any] = [
            "app": app.bundleIdentifier ?? app.bundleURL?.path ?? app.localizedName ?? "",
            "application": appSummary(app),
            "snapshot_generation": generation,
            "elements": summaries,
            "text": accessibilityText(summaries),
            "truncated": elements.count >= maxElements,
            "status": status(),
        ]
        if params["include_screenshot"] as? Bool != false, let screenshot = try await captureWindow(app) {
            result["screenshot"] = screenshot
        }
        if let previous = intValue(params["previous_snapshot_generation"]) {
            result["diff"] = snapshotDiff(previousGeneration: previous, current: snapshot)
        }
        return result
    }

    private func walk(
        element: AXUIElement,
        depth: Int,
        maxElements: Int,
        visited: inout Set<CFHashCode>,
        elements: inout [AXUIElement],
        summaries: inout [[String: Any]]
    ) {
        guard elements.count < maxElements, depth <= 14 else { return }
        let identity = CFHash(element)
        guard visited.insert(identity).inserted else { return }
        let index = elements.count
        elements.append(element)
        let role = stringAttribute(element, kAXRoleAttribute) ?? ""
        let subrole = stringAttribute(element, kAXSubroleAttribute) ?? ""
        let secure = role == "AXSecureTextField" || subrole.localizedCaseInsensitiveContains("secure")
        var summary: [String: Any] = [
            "element_index": index,
            "depth": depth,
            "role": role,
            "subrole": subrole,
            "title": stringAttribute(element, kAXTitleAttribute) ?? "",
            "description": stringAttribute(element, kAXDescriptionAttribute) ?? "",
            "identifier": stringAttribute(element, kAXIdentifierAttribute) ?? "",
            "enabled": boolAttribute(element, kAXEnabledAttribute) ?? true,
            "focused": boolAttribute(element, kAXFocusedAttribute) ?? false,
            "secure": secure,
        ]
        if !secure, let value = safeValueAttribute(element) { summary["value"] = value }
        if let frame = frameAttribute(element) { summary["frame"] = frame }
        if let actions = actionNames(element), !actions.isEmpty { summary["actions"] = actions }
        summaries.append(summary)
        guard let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] else { return }
        for child in children {
            walk(element: child, depth: depth + 1, maxElements: maxElements, visited: &visited, elements: &elements, summaries: &summaries)
            if elements.count >= maxElements { return }
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

    private func rejectSelf(_ app: NSRunningApplication) throws {
        if app.processIdentifier == parentPid {
            throw ServiceFailure(code: "ZEUS_COMPUTER_SELF_CONTROL_BLOCKED", message: "当前 Zeus 实例不能控制自身或自身审批界面。")
        }
        if let bundleId = app.bundleIdentifier, bundleId == "dev.hypha.zeus" || bundleId == "dev.hypha.zeus.test" {
            if !(qaMode && bundleId == "dev.hypha.zeus.test") {
                throw ServiceFailure(code: "ZEUS_COMPUTER_ZEUS_CONTROL_BLOCKED", message: "Zeus 实例默认不能控制其他 Zeus 或审批界面；仅独立 Test 身份可在显式 QA 模式下被控制。")
            }
        }
    }

    private func canControl(_ app: NSRunningApplication) -> Bool {
        if app.processIdentifier == parentPid { return false }
        guard let bundleId = app.bundleIdentifier, bundleId == "dev.hypha.zeus" || bundleId == "dev.hypha.zeus.test" else { return true }
        return qaMode && bundleId == "dev.hypha.zeus.test"
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
        return (app, snapshot.elements[elementIndex])
    }

    private func performClick(_ params: [String: Any], secondary: Bool) throws -> [String: Any] {
        try requireAccessibility()
        try requireUnlockedSession()
        let (app, element) = try appAndElement(params, elementRequired: false)
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
                virtualPointers[app.processIdentifier] = point
                return ["performed": "click", "semantic": false]
            }
        }
        guard let x = numberValue(params["x"]), let y = numberValue(params["y"]) else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_TARGET_REQUIRED", message: "点击需要语义元素或坐标。")
        }
        try postClick(pid: app.processIdentifier, point: CGPoint(x: x, y: y), button: requestedButton, count: requestedCount)
        virtualPointers[app.processIdentifier] = CGPoint(x: x, y: y)
        return ["performed": "click", "semantic": false, "click_count": requestedCount]
    }

    private func performDrag(_ params: [String: Any]) throws -> [String: Any] {
        try requireAccessibility()
        try requireUnlockedSession()
        let (app, _) = try appAndElement(params, elementRequired: false)
        guard let startX = numberValue(params["from_x"] ?? params["start_x"]), let startY = numberValue(params["from_y"] ?? params["start_y"]),
              let endX = numberValue(params["to_x"] ?? params["end_x"]), let endY = numberValue(params["to_y"] ?? params["end_y"])
        else { throw ServiceFailure(code: "ZEUS_COMPUTER_DRAG_INVALID", message: "拖拽坐标不完整。") }
        let source = CGEventSource(stateID: .hidSystemState)
        let start = CGPoint(x: startX, y: startY)
        let end = CGPoint(x: endX, y: endY)
        try postMouse(pid: app.processIdentifier, source: source, type: .leftMouseDown, point: start, button: .left)
        for step in 1...16 {
            let fraction = CGFloat(step) / 16
            let point = CGPoint(x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction)
            try postMouse(pid: app.processIdentifier, source: source, type: .leftMouseDragged, point: point, button: .left)
        }
        try postMouse(pid: app.processIdentifier, source: source, type: .leftMouseUp, point: end, button: .left)
        virtualPointers[app.processIdentifier] = end
        return ["dragged": true, "start": ["x": startX, "y": startY], "end": ["x": endX, "y": endY]]
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
        try postKeyChord(pid: app.processIdentifier, keyCode: 9, flags: .maskCommand)
        Thread.sleep(forTimeInterval: 0.25)
        let shouldRestore = pasteboard.changeCount == zeusChangeCount
        if shouldRestore { restorePasteboard(pasteboard, previous) }
        return ["pasted": true, "format": format, "length": text.utf16.count, "clipboardRestored": shouldRestore]
    }

    private func performKey(_ params: [String: Any]) throws -> [String: Any] {
        try requireAccessibility()
        try requireUnlockedSession()
        let (app, _) = try appAndElement(params, elementRequired: false)
        guard let chord = params["key"] as? String else { throw ServiceFailure(code: "ZEUS_COMPUTER_KEY_REQUIRED", message: "press_key 缺少 key。") }
        let parsed = try keyChord(chord)
        try postKeyChord(pid: app.processIdentifier, keyCode: parsed.code, flags: parsed.flags)
        return ["pressed": chord]
    }

    private func performScroll(_ params: [String: Any]) throws -> [String: Any] {
        try requireAccessibility()
        try requireUnlockedSession()
        let (app, element) = try appAndElement(params, elementRequired: false)
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
        guard let event = CGEvent(scrollWheelEvent2Source: CGEventSource(stateID: .hidSystemState), units: .pixel, wheelCount: 2, wheel1: deltaY, wheel2: deltaX, wheel3: 0) else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_EVENT_CREATION_FAILED", message: "无法创建滚动事件。")
        }
        event.postToPid(app.processIdentifier)
        if let x = numberValue(params["x"]), let y = numberValue(params["y"]) { virtualPointers[app.processIdentifier] = CGPoint(x: x, y: y) }
        return ["scrolled": true, "semantic": false, "direction": normalized, "pages": pages, "delta_x": deltaX, "delta_y": deltaY]
    }

    private func selectText(_ params: [String: Any]) throws -> [String: Any] {
        try requireAccessibility()
        try requireUnlockedSession()
        let (_, element) = try appAndElement(params, elementRequired: true)
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
        if let element { try rejectSecure(element); try focus(element) }
        else if let focused = focusedElement(app.processIdentifier) { try rejectSecure(focused) }
        let source = CGEventSource(stateID: .hidSystemState)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
        else { throw ServiceFailure(code: "ZEUS_COMPUTER_EVENT_CREATION_FAILED", message: "无法创建文字事件。") }
        let characters = Array(text.utf16)
        characters.withUnsafeBufferPointer { buffer in
            guard let base = buffer.baseAddress else { return }
            down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
            up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
        }
        down.postToPid(app.processIdentifier)
        up.postToPid(app.processIdentifier)
        return ["typed": true, "length": text.utf16.count]
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

    private func focusedElement(_ pid: pid_t) -> AXUIElement? {
        let application = AXUIElementCreateApplication(pid)
        guard let value = attribute(application, kAXFocusedUIElementAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    private func snapshotDiff(previousGeneration: Int, current: ElementSnapshot) -> [String: Any] {
        guard let previous = snapshotHistory[previousGeneration], previous.pid == current.pid else {
            return ["previous_generation": previousGeneration, "current_generation": current.generation, "available": false, "reason": "previous_snapshot_expired"]
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
        let source = CGEventSource(stateID: .hidSystemState)
        let down: CGEventType = button == .right ? .rightMouseDown : button == .center ? .otherMouseDown : .leftMouseDown
        let up: CGEventType = button == .right ? .rightMouseUp : button == .center ? .otherMouseUp : .leftMouseUp
        for click in 1...count {
            try postMouse(pid: pid, source: source, type: down, point: point, button: button, clickState: Int64(click))
            try postMouse(pid: pid, source: source, type: up, point: point, button: button, clickState: Int64(click))
        }
    }

    private func postMouse(pid: pid_t, source: CGEventSource?, type: CGEventType, point: CGPoint, button: CGMouseButton, clickState: Int64 = 1) throws {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
            throw ServiceFailure(code: "ZEUS_COMPUTER_EVENT_CREATION_FAILED", message: "无法创建鼠标事件。")
        }
        event.setIntegerValueField(.mouseEventClickState, value: clickState)
        event.postToPid(pid)
    }

    private func mouseButton(_ value: Any?) throws -> CGMouseButton {
        let button = (value as? String ?? "left").lowercased()
        if button == "left" || button == "l" { return .left }
        if button == "right" || button == "r" { return .right }
        if button == "middle" || button == "m" { return .center }
        throw ServiceFailure(code: "ZEUS_COMPUTER_MOUSE_BUTTON_INVALID", message: "mouse_button 无效。")
    }

    private func postKeyChord(pid: pid_t, keyCode: CGKeyCode, flags: CGEventFlags) throws {
        let source = CGEventSource(stateID: .hidSystemState)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false)
        else { throw ServiceFailure(code: "ZEUS_COMPUTER_EVENT_CREATION_FAILED", message: "无法创建键盘事件。") }
        down.flags = flags
        up.flags = flags
        down.postToPid(pid)
        up.postToPid(pid)
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
        if let index = letters.firstIndex(of: Character(key)), key.count == 1 {
            return (letterCodes[letters.distance(from: letters.startIndex, to: index)], flags)
        }
        throw ServiceFailure(code: "ZEUS_COMPUTER_KEY_UNSUPPORTED", message: "不支持的按键：\(key)")
    }

    private func captureWindow(_ app: NSRunningApplication) async throws -> [String: Any]? {
        try FileManager.default.createDirectory(at: artifactRoot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let capture: CGImage?
        if #available(macOS 14.0, *) {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            if let window = content.windows.first(where: { $0.owningApplication?.processID == app.processIdentifier && $0.frame.width > 1 && $0.frame.height > 1 }) {
                let configuration = SCStreamConfiguration()
                let scale = NSScreen.screens.map(\.backingScaleFactor).max() ?? 1
                configuration.width = max(1, Int(window.frame.width * scale))
                configuration.height = max(1, Int(window.frame.height * scale))
                configuration.showsCursor = false
                capture = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: configuration)
            } else { capture = nil }
        } else {
            capture = legacyWindowImage(app.processIdentifier)
        }
        guard let image = capture else { return nil }
        let representation = NSBitmapImageRep(cgImage: image)
        guard let png = representation.representation(using: .png, properties: [:]) else { return nil }
        let file = artifactRoot.appendingPathComponent("computer-\(app.processIdentifier)-\(generation)-\(UUID().uuidString).png")
        try png.write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        return ["artifactPath": file.path, "mimeType": "image/png", "width": image.width, "height": image.height, "byteLength": png.count]
    }

    private func legacyWindowImage(_ pid: pid_t) -> CGImage? {
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
              let match = windows.first(where: {
                  ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0
              }),
              let number = match[kCGWindowNumber as String] as? UInt32
        else { return nil }
        return CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(number), [.boundsIgnoreFraming, .bestResolution])
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
        guard let positionValue = attribute(element, kAXPositionAttribute), CFGetTypeID(positionValue) == AXValueGetTypeID(),
              let sizeValue = attribute(element, kAXSizeAttribute), CFGetTypeID(sizeValue) == AXValueGetTypeID()
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
