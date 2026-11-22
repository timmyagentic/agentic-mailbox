import AppKit
import CryptoKit
import Security
import UniformTypeIdentifiers

private enum DeviceCertificateError: Error {
    case invalidBundle
    case identityUnavailable
    case cannotSign
}

private struct DeviceCertificate {
    static var file: URL {
        let environment = ProcessInfo.processInfo.environment
        let parent = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let legacy = parent.appendingPathComponent("Mailbox Vault")
        let defaultDirectory = FileManager.default.fileExists(atPath: legacy.path)
            ? legacy : parent.appendingPathComponent("Agentic Mailbox")
        let directory = (environment["AGENTIC_MAILBOX_DATA_DIR"] ?? environment["VAULT_DATA_DIR"])
            .flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0, isDirectory: true) } ?? defaultDirectory
        return directory.appendingPathComponent("device-certificate.cer")
    }

    static func enroll(bundle: URL, password: String) throws {
        let bytes = try Data(contentsOf: bundle)
        var items: CFArray?
        let options = [kSecImportExportPassphrase as String: password] as CFDictionary
        guard SecPKCS12Import(bytes as CFData, options, &items) == errSecSuccess,
              let entries = items as? [[String: Any]],
              let identity = entries.first?[kSecImportItemIdentity as String] else {
            throw DeviceCertificateError.invalidBundle
        }
        let selected = identity as! SecIdentity
        var certificate: SecCertificate?
        guard SecIdentityCopyCertificate(selected, &certificate) == errSecSuccess, let certificate else {
            throw DeviceCertificateError.invalidBundle
        }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(),
                                                withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try (SecCertificateCopyData(certificate) as Data).write(to: file, options: .atomic)
    }

    static func prove(nonce: String, fingerprint: String) throws -> String {
        let query = [kSecClass: kSecClassIdentity, kSecMatchLimit: kSecMatchLimitAll, kSecReturnRef: kCFBooleanTrue!] as CFDictionary
        var matches: CFTypeRef?
        guard SecItemCopyMatching(query, &matches) == errSecSuccess, let identities = matches as? [SecIdentity] else {
            throw DeviceCertificateError.identityUnavailable
        }
        for identity in identities {
            var certificate: SecCertificate?
            guard SecIdentityCopyCertificate(identity, &certificate) == errSecSuccess, let certificate else { continue }
            let actual = SHA256.hash(data: SecCertificateCopyData(certificate) as Data)
                .map { String(format: "%02x", $0) }.joined()
            guard actual == fingerprint else { continue }
            var key: SecKey?
            guard SecIdentityCopyPrivateKey(identity, &key) == errSecSuccess, let key else { break }
            let algorithms: [SecKeyAlgorithm] = [.rsaSignatureMessagePKCS1v15SHA256, .ecdsaSignatureMessageX962SHA256]
            let message = Data(("Agentic Mailbox local login v1\n" + nonce).utf8)
            guard let algorithm = algorithms.first(where: { SecKeyIsAlgorithmSupported(key, .sign, $0) }),
                  let signature = SecKeyCreateSignature(key, algorithm, message as CFData, nil) else {
                throw DeviceCertificateError.cannotSign
            }
            return (signature as Data).base64EncodedString()
        }
        throw DeviceCertificateError.identityUnavailable
    }
}

private struct ServiceMessage: Decodable {
    let type: String
    let ticket: String?
    let nonce: String?
    let fingerprint: String?
}

final class Launcher: NSObject, NSApplicationDelegate {
    private var server: Process?
    private var commands: FileHandle?
    private var received = Data()
    private var window: NSWindow?
    private var ready = false
    private var checking = false
    private let resources = Bundle.main.resourceURL!.appendingPathComponent("Mailbox")
    private let status = NSTextField(wrappingLabelWithString: "邮件服务在本机运行。关闭此窗口会停止服务。")
    private lazy var certificateLogin = NSButton(title: "使用设备证书登录", target: self, action: #selector(loginWithCertificate))

    private var origin: URL? {
        let environment = ProcessInfo.processInfo.environment
        let port = environment["AGENTIC_MAILBOX_LOCAL_PORT"] ?? environment["VAULT_LOCAL_PORT"] ?? "8787"
        guard let number = UInt16(port), number > 0 else { return nil }
        return URL(string: "http://127.0.0.1:\(number)/")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let open = NSButton(title: "打开邮箱", target: self, action: #selector(openMailbox))
        let enroll = NSButton(title: "登记设备证书", target: self, action: #selector(enrollCertificate))
        let oauth = NSButton(title: "配置本机 OAuth", target: self, action: #selector(configureOAuth))
        let actions = NSStackView(views: [open, certificateLogin])
        let setup = NSStackView(views: [enroll, oauth])
        let body = NSStackView(views: [status, actions, setup])
        body.orientation = .vertical
        body.alignment = .leading
        body.spacing = 16
        body.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 465, height: 182),
                              styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Agentic Mailbox"
        window.contentView = body
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
        updateCertificateButton()
        startService()
    }

    @objc private func openMailbox() {
        if let server, server.isRunning {
            if ready { openBrowser() }
        } else {
            startService()
        }
    }

    private func startService() {
        let task = Process()
        let input = Pipe()
        let output = Pipe()
        task.executableURL = resources.appendingPathComponent("runtime/node")
        task.arguments = ["scripts/local.mjs", "--native-launcher"]
        task.currentDirectoryURL = resources
        task.standardInput = input
        task.standardOutput = output
        commands = input.fileHandleForWriting
        received = Data()
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            if chunk.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.consume(chunk) }
        }
        task.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                self?.ready = false
                self?.checking = false
                self?.updateCertificateButton()
                self?.status.stringValue = process.terminationStatus == 0
                    ? "本机邮箱已停止。" : "启动失败。请检查本机端口后再点击「打开邮箱」。"
            }
        }
        do {
            try task.run()
            server = task
            status.stringValue = "正在启动本机邮箱…"
        } catch {
            status.stringValue = "无法启动本机邮箱。请重新安装此应用。"
        }
    }

    private func openBrowser(ticket: String? = nil) {
        guard let origin, var url = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { return }
        if let ticket, ticket.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil {
            url.fragment = "localUnlock=" + ticket
        }
        if let address = url.url { NSWorkspace.shared.open(address) }
    }

    private func send(_ command: [String: String]) {
        do {
            guard let commands else { throw DeviceCertificateError.identityUnavailable }
            var line = try JSONEncoder().encode(command)
            line.append(0x0a)
            try commands.write(contentsOf: line)
        } catch {
            endCheck("本机服务未就绪，请重新打开邮箱。")
        }
    }

    private func consume(_ chunk: Data) {
        received.append(chunk)
        while let end = received.firstIndex(of: 0x0a) {
            let line = received[..<end]
            if let message = try? JSONDecoder().decode(ServiceMessage.self, from: Data(line)) {
                receive(message)
            }
            received.removeSubrange(...end)
        }
    }

    private func receive(_ message: ServiceMessage) {
        switch message.type {
        case "ready":
            ready = true
            updateCertificateButton()
            status.stringValue = "本机邮箱已启动。关闭此窗口会停止服务。"
            openBrowser(ticket: message.ticket)
        case "challenge":
            guard checking, let nonce = message.nonce, let fingerprint = message.fingerprint else { return }
            do {
                let signature = try DeviceCertificate.prove(nonce: nonce, fingerprint: fingerprint)
                send(["type": "prove", "nonce": nonce, "signature": signature])
            } catch {
                endCheck("钥匙串无法使用已登记的设备私钥。可重新登记证书，或使用本机密码。")
            }
        case "authorized":
            guard checking else { return }
            endCheck("设备证书验证通过，正在打开本机邮箱。")
            openBrowser(ticket: message.ticket)
        case "certificate-unavailable":
            endCheck("设备证书未登记、已过期或用途不符。可使用本机密码。")
        case "certificate-rejected":
            endCheck("设备证书验证失败。请重试或使用本机密码。")
        default:
            break
        }
    }

    @objc private func loginWithCertificate() {
        checking = true
        updateCertificateButton()
        status.stringValue = "正在验证设备证书…"
        send(["type": "challenge"])
    }

    private func endCheck(_ text: String) {
        checking = false
        updateCertificateButton()
        status.stringValue = text
    }

    private func updateCertificateButton() {
        certificateLogin.isEnabled = ready && !checking && FileManager.default.fileExists(atPath: DeviceCertificate.file.path)
    }

    @objc private func enrollCertificate() {
        let panel = NSOpenPanel()
        panel.message = "选择设备证书包，私钥将导入你的钥匙串。"
        panel.allowedContentTypes = ["p12", "pfx"].compactMap { UTType(filenameExtension: $0) }
        guard panel.runModal() == .OK, let bundle = panel.url else { return }
        let alert = NSAlert()
        alert.messageText = "输入证书包的导入密码"
        alert.addButton(withTitle: "登记")
        alert.addButton(withTitle: "取消")
        let password = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        alert.accessoryView = password
        alert.window.initialFirstResponder = password
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        defer { password.stringValue = "" }
        do {
            try DeviceCertificate.enroll(bundle: bundle, password: password.stringValue)
            status.stringValue = "已登记设备证书。登录时将使用钥匙串中的私钥。"
            updateCertificateButton()
        } catch {
            status.stringValue = "无法登记。请检查证书包和导入密码。"
        }
    }

    @objc private func configureOAuth() {
        NSWorkspace.shared.open(resources.appendingPathComponent("配置本机 OAuth.command"))
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        try? commands?.close()
        if let server, server.isRunning { server.terminate() }
    }
}

if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--import-device-certificate" {
    do {
        guard let password = readLine() else { throw DeviceCertificateError.invalidBundle }
        try DeviceCertificate.enroll(bundle: URL(fileURLWithPath: CommandLine.arguments[2]), password: password)
        exit(EXIT_SUCCESS)
    } catch {
        FileHandle.standardError.write(Data("无法登记设备证书。请检查证书包和导入密码。\n".utf8))
        exit(EXIT_FAILURE)
    }
}

let app = NSApplication.shared
let delegate = Launcher()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
