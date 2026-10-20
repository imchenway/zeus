import AppKit
import CryptoKit
import Darwin
import Foundation
import Security

/** Git 和本地模型共用的原生认证入口；秘密只经系统钥匙串与匿名管道传递。 */
@main
private struct ZeusGitAskpass {
    /** 与 OpenSSH askpass 的单行输入上限保持一致，预留换行和结束字符。 */
    private static let maximumSecretBytes = 1022

    /** 原生入口只接受一条有界提示，验证子进程不打开窗口或读取钥匙串。 */
    static func main() {
        guard CommandLine.arguments.count == 2,
              CommandLine.arguments[1].utf8.count <= 8192 else { exit(1) }
        /** Git 提供的提示只作为文本显示，不参与命令拼接。 */
        let prompt = CommandLine.arguments[1].trimmingCharacters(in: .whitespacesAndNewlines)
        if ProcessInfo.processInfo.environment["ZEUS_GIT_ASKPASS_STDIN"] == "1" {
            /** 验证期间只回传父进程管道中的一次口令，错误口令的再次读取会得到 EOF。 */
            let data = FileHandle.standardInput.readData(ofLength: maximumSecretBytes + 1)
            guard let secret = String(data: data, encoding: .utf8), validSecret(secret) else { exit(1) }
            print(secret)
            return
        }
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)
        do {
            /** 仅真实存在的本地私钥提示可记住；HTTPS 密码继续由 Git 凭据管理器维护。 */
            let key = privateKeyPath(prompt)
            /** 沿用正式、开发和验收环境已有的系统凭据身份。 */
            let service = ProcessInfo.processInfo.environment["ZEUS_GIT_ASKPASS_SERVICE"]
            /** 同一密钥的并发请求共用锁；取得锁后再次读取钥匙串，避免重复弹窗。 */
            let lock = try key.flatMap { key in try service.map { try lockCredential(service: $0, key: key) } }
            defer { if let lock { flock(lock, LOCK_UN); close(lock) } }
            if let key, let service, let saved = try readSecret(service: service, key: key) {
                if try accepts(secret: saved, key: key) {
                    print(saved)
                    return
                }
                // 文件内容或口令变化时只移除这一把密钥的旧口令，不覆盖其他钥匙串项目。
                try deleteSecret(service: service, key: key)
            }
            if prompt.contains("yes/no") {
                /** 服务器信任仍需独立确认，默认拒绝；不会由“记住口令”绕过。 */
                let alert = NSAlert()
                alert.messageText = "Zeus · 核对 Git 服务器指纹"
                alert.informativeText = prompt
                alert.addButton(withTitle: "取消")
                alert.addButton(withTitle: "信任此服务器")
                guard show(alert) == .alertSecondButtonReturn else { exit(1) }
                print("yes")
                return
            }
            /** 输入校验失败后保留用户刚选择的记忆状态。 */
            var remember = false
            for _ in 0..<3 {
                /** 密码输入与“记住”状态只在当前原生进程中存在。 */
                guard let answer = ask(prompt: prompt, canRemember: key != nil && service != nil, remember: remember) else { exit(1) }
                remember = answer.remember
                guard validSecret(answer.secret) else {
                    inform("输入过长或包含换行，请重新输入。")
                    continue
                }
                if answer.remember, let key, let service {
                    guard try accepts(secret: answer.secret, key: key) else {
                        inform("口令未通过这把密钥的校验，未保存。请重新输入。")
                        continue
                    }
                    do { try saveSecret(answer.secret, service: service, key: key) }
                    catch {
                        /** 保存失败必须明确显示，用户仍可选择仅用于当前操作。 */
                        let alert = NSAlert()
                        alert.messageText = "Zeus · 口令未能保存"
                        alert.informativeText = "系统钥匙串未能保存口令。可以仅用于本次操作，下次仍可能询问。"
                        alert.addButton(withTitle: "取消")
                        alert.addButton(withTitle: "仅本次继续")
                        guard show(alert) == .alertSecondButtonReturn else { exit(1) }
                    }
                }
                print(answer.secret)
                return
            }
        } catch {
            if (error as NSError).code == Int(errSecUserCanceled) { exit(1) }
            // 不输出系统异常详情，避免进程参数、输入或系统凭据进入模型日志。
            inform("无法完成系统认证。请检查钥匙串是否已解锁，以及 SSH 密钥文件是否可读，然后重试。")
        }
        exit(1)
    }

    /** 同时识别 SSH 与 ssh-add 的标准提示；未知格式仍允许当次输入，但不保存。 */
    private static func privateKeyPath(_ prompt: String) -> String? {
        /** 提示中的路径必须覆盖完整字段，禁止从任意服务器文案中截取文件名。 */
        var path: String
        if prompt.hasPrefix("Enter passphrase for key '"), prompt.hasSuffix("':") {
            path = String(prompt.dropFirst("Enter passphrase for key '".count).dropLast(2))
        } else if prompt.hasPrefix("Enter passphrase for "), prompt.hasSuffix(":") {
            path = String(prompt.dropFirst("Enter passphrase for ".count).dropLast())
        } else { return nil }
        guard path.hasPrefix("/"), !path.contains("\0"), !path.contains("\n"), !path.contains("\r") else { return nil }
        path = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
              attributes[.type] as? FileAttributeType == .typeRegular else { return nil }
        return path
    }

    /** 口令遵守 askpass 单行协议，不把超限值截断后误存为另一个密码。 */
    private static func validSecret(_ secret: String) -> Bool {
        !secret.isEmpty && secret.utf8.count <= maximumSecretBytes &&
            !secret.contains("\0") && !secret.contains("\n") && !secret.contains("\r")
    }

    /** 系统提示提供安全输入框和可选的钥匙串记忆；用户名保持明文输入。 */
    private static func ask(prompt: String, canRemember: Bool, remember: Bool) -> (secret: String, remember: Bool)? {
        /** 本次原生认证窗口。 */
        let alert = NSAlert()
        alert.messageText = prompt.contains("Username") ? "Zeus · Git 用户名" : "Zeus · Git 密码或密钥口令"
        alert.informativeText = prompt
        alert.addButton(withTitle: "继续")
        alert.addButton(withTitle: "取消")
        /** 使用系统安全文本框，屏幕辅助功能可读标签但不能读出口令。 */
        let input: NSTextField = prompt.contains("Username") ? NSTextField() : NSSecureTextField()
        input.frame = NSRect(x: 0, y: 0, width: 380, height: 24)
        input.setAccessibilityLabel(prompt.contains("Username") ? "Git 用户名" : "Git 密码或密钥口令")
        alert.accessoryView = input
        alert.window.initialFirstResponder = input
        alert.showsSuppressionButton = canRemember
        alert.suppressionButton?.title = "记住此密钥口令（保存在系统钥匙串）"
        alert.suppressionButton?.state = remember ? .on : .off
        guard show(alert) == .alertFirstButtonReturn else { return nil }
        return (input.stringValue, canRemember && alert.suppressionButton?.state == .on)
    }

    /** 原生窗口最多等待九十秒；取消、关闭和超时都不会返回口令。 */
    private static func show(_ alert: NSAlert) -> NSApplication.ModalResponse {
        /** 模态循环使用公共模式计时，窗口关闭后立即取消计时器。 */
        let timer = Timer(timeInterval: 90, repeats: false) { _ in NSApp.abortModal() }
        RunLoop.main.add(timer, forMode: .common)
        defer { timer.invalidate() }
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal()
    }

    /** 非敏感的处理说明始终在原生窗口中显示。 */
    private static func inform(_ message: String) {
        /** 当前提示不包含异常对象、口令或命令输出。 */
        let alert = NSAlert()
        alert.messageText = "Zeus · SSH 认证"
        alert.informativeText = message
        alert.addButton(withTitle: "确定")
        _ = show(alert)
    }

    /** 只读解密私钥确认口令；不连接服务器、不改文件、不把口令放进命令行。 */
    private static func accepts(secret: String, key: String) throws -> Bool {
        /** 系统 SSH 实现用于本地私钥校验，避免 PATH 覆盖改变接收口令的程序。 */
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh-keygen")
        process.arguments = ["-y", "-f", key]
        /** 只有校验子进程及其 askpass 可读取这条匿名输入管道。 */
        let input = Pipe()
        process.standardInput = input
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        /** 环境只携带非敏感的协议标记与当前辅助程序绝对路径。 */
        var environment = ProcessInfo.processInfo.environment
        environment["SSH_ASKPASS"] = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.path
        environment["SSH_ASKPASS_REQUIRE"] = "force"
        environment["DISPLAY"] = "zeus"
        environment["ZEUS_GIT_ASKPASS_STDIN"] = "1"
        process.environment = environment
        /** 有界等待防止损坏的密钥或异常子进程阻塞 Git。 */
        let finished = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in finished.signal() }
        try process.run()
        try input.fileHandleForWriting.write(contentsOf: Data(secret.utf8))
        try input.fileHandleForWriting.close()
        if finished.wait(timeout: .now() + 15) == .timedOut {
            kill(process.processIdentifier, SIGKILL)
            process.waitUntilExit()
            throw NSError(domain: "ZeusGitAskpass", code: 1)
        }
        return process.terminationStatus == 0
    }

    /** 系统凭据按产品身份与规范密钥路径定位，不依赖仓库名或不可信提示全文。 */
    private static func secretQuery(service: String, key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: key]
    }

    /** 钥匙串拒绝访问时不把拒绝误当成未保存，也不继续自动请求其他凭据。 */
    private static func readSecret(service: String, key: String) throws -> String? {
        /** 仅请求匹配项的密码数据。 */
        var query = secretQuery(service: service, key: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        /** 系统只向当前辅助程序返回凭据，不经过 Zeus 数据库或模型。 */
        var result: CFTypeRef?
        /** 区分不存在、拒绝与成功。 */
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let secret = String(data: data, encoding: .utf8) else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        return secret
    }

    /** 校验通过后才新增或更新，避免错误口令造成永久重试。 */
    private static func saveSecret(_ secret: String, service: String, key: String) throws {
        /** 查询条件与读取一致，更新失败不先删除已有凭据。 */
        let query = secretQuery(service: service, key: key)
        /** 只保存口令，不复制私钥文件。 */
        let update: [String: Any] = [kSecValueData as String: Data(secret.utf8)]
        /** 先更新既有条目，缺少时才添加。 */
        var status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            /** 显示名称帮助用户在“钥匙串访问”中找到并移除这项授权。 */
            var item = query.merging(update) { _, value in value }
            item[kSecAttrLabel as String] = "Zeus SSH · \(URL(fileURLWithPath: key).lastPathComponent)"
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }

    /** 失效口令只删除对应的钥匙串项目。 */
    private static func deleteSecret(service: String, key: String) throws {
        /** 删除不影响磁盘上的私钥或系统 SSH agent。 */
        let status = SecItemDelete(secretQuery(service: service, key: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }

    /** 同一用户、同一密钥串行询问；锁文件不含任何秘密。 */
    private static func lockCredential(service: String, key: String) throws -> Int32 {
        /** 用户专属目录拒绝符号链接和其他用户拥有的既有目录。 */
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("zeus-git-askpass-\(getuid())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        /** 读取真实目录属性，防止锁文件被重定向。 */
        let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              ((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o777 == 0o700 else {
            throw NSError(domain: "ZeusGitAskpass", code: 2)
        }
        /** 哈希只用于锁文件名，私钥内容不会读取或写入。 */
        let name = SHA256.hash(data: Data("\(service)\0\(key)".utf8)).map { String(format: "%02x", $0) }.joined()
        /** O_NOFOLLOW 防止既有锁文件被替换成链接。 */
        let descriptor = open(directory.appendingPathComponent(name).path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        for _ in 0..<450 {
            if flock(descriptor, LOCK_EX | LOCK_NB) == 0 { return descriptor }
            guard errno == EWOULDBLOCK else { break }
            Thread.sleep(forTimeInterval: 0.2)
        }
        close(descriptor)
        throw NSError(domain: "ZeusGitAskpass", code: 3)
    }
}
