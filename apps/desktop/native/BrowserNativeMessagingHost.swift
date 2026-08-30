import Foundation
import Darwin

private struct Rendezvous: Decodable {
    let endpoint: String
    let token: String
    let surface: String
    let pid: Int32
}

@main
private struct ZeusBrowserNativeMessagingHost {
    static func main() {
        do {
            let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
            let configURL = executable.deletingLastPathComponent().appendingPathComponent("rendezvous.json")
            let config = try readSecureRendezvous(configURL)
            while let message = try readNativeMessage() {
                let reply = try exchange(message: message, rendezvous: config)
                try writeNativeMessage(reply)
            }
        } catch {
            let payload = (try? JSONSerialization.data(withJSONObject: [
                "type": "host_error",
                "code": "ZEUS_BROWSER_NATIVE_HOST_FAILED",
                "message": "Zeus rejected the Native Messaging rendezvous.",
            ])) ?? Data("{\"type\":\"host_error\"}".utf8)
            try? writeNativeMessage(payload)
            FileHandle.standardError.write(Data("Zeus Browser Native Host failed.\n".utf8))
            exit(1)
        }
    }

    private static func readSecureRendezvous(_ configURL: URL) throws -> Rendezvous {
        let values = try configURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        let attributes = try FileManager.default.attributesOfItem(atPath: configURL.path)
        let owner = (attributes[.ownerAccountID] as? NSNumber)?.uint32Value
        let permissions = (attributes[.posixPermissions] as? NSNumber)?.uint16Value
        guard values.isRegularFile == true,
              values.isSymbolicLink != true,
              owner == getuid(),
              permissions.map({ $0 & 0o777 }) == 0o600 else {
            throw NSError(domain: "ZeusBrowserNativeHost", code: 6, userInfo: nil)
        }
        let config = try JSONDecoder().decode(Rendezvous.self, from: Data(contentsOf: configURL, options: [.mappedIfSafe]))
        let allowedTokenBytes = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        guard (config.surface == "chrome" || config.surface == "edge"),
              config.token.utf8.count >= 43,
              config.token.utf8.count <= 128,
              config.token.unicodeScalars.allSatisfy({ allowedTokenBytes.contains($0) }),
              config.pid > 1,
              kill(config.pid, 0) == 0 else {
            throw NSError(domain: "ZeusBrowserNativeHost", code: 7, userInfo: nil)
        }
        guard let endpoint = URL(string: config.endpoint),
              endpoint.scheme == "http",
              endpoint.host == "127.0.0.1",
              endpoint.path == "/native",
              endpoint.port.map({ (1...65535).contains($0) }) == true,
              endpoint.user == nil,
              endpoint.password == nil,
              endpoint.query == nil,
              endpoint.fragment == nil else {
            throw NSError(domain: "ZeusBrowserNativeHost", code: 8, userInfo: nil)
        }
        return config
    }

    private static func readNativeMessage() throws -> Data? {
        guard let header = try readExact(count: 4) else { return nil }
        let bytes = [UInt8](header)
        let length = Int(bytes[0]) | Int(bytes[1]) << 8 | Int(bytes[2]) << 16 | Int(bytes[3]) << 24
        guard length >= 0, length <= 16 * 1024 * 1024 else {
            throw NSError(domain: "ZeusBrowserNativeHost", code: 1, userInfo: [NSLocalizedDescriptionKey: "Native Messaging frame is too large."])
        }
        return try readExact(count: length) ?? Data()
    }

    private static func readExact(count: Int) throws -> Data? {
        if count == 0 { return Data() }
        var result = Data()
        while result.count < count {
            let next = try FileHandle.standardInput.read(upToCount: count - result.count) ?? Data()
            if next.isEmpty { return result.isEmpty ? nil : result }
            result.append(next)
        }
        return result
    }

    private static func writeNativeMessage(_ message: Data) throws {
        guard message.count <= 16 * 1024 * 1024 else {
            throw NSError(domain: "ZeusBrowserNativeHost", code: 2, userInfo: [NSLocalizedDescriptionKey: "Native Messaging response is too large."])
        }
        let length = UInt32(message.count).littleEndian
        var header = length
        FileHandle.standardOutput.write(Data(bytes: &header, count: 4))
        FileHandle.standardOutput.write(message)
    }

    private static func exchange(message: Data, rendezvous: Rendezvous) throws -> Data {
        guard let endpoint = URL(string: rendezvous.endpoint), endpoint.host == "127.0.0.1" else {
            throw NSError(domain: "ZeusBrowserNativeHost", code: 3, userInfo: [NSLocalizedDescriptionKey: "Rendezvous endpoint is invalid."])
        }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 25
        request.httpBody = message
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(rendezvous.token)", forHTTPHeaderField: "Authorization")
        request.setValue(rendezvous.surface, forHTTPHeaderField: "X-Zeus-Browser-Surface")

        let semaphore = DispatchSemaphore(value: 0)
        var responseData: Data?
        var responseError: Error?
        URLSession.shared.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }
            if let error { responseError = error; return }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                responseError = NSError(domain: "ZeusBrowserNativeHost", code: 4, userInfo: [NSLocalizedDescriptionKey: "Zeus rendezvous rejected the native host."])
                return
            }
            responseData = data
        }.resume()
        guard semaphore.wait(timeout: .now() + 26) == .success else {
            throw NSError(domain: "ZeusBrowserNativeHost", code: 5, userInfo: [NSLocalizedDescriptionKey: "Zeus rendezvous timed out."])
        }
        if let responseError { throw responseError }
        return responseData ?? Data("{\"type\":\"noop\"}".utf8)
    }
}
