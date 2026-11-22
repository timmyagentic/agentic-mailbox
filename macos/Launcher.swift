import AppKit

final class Launcher: NSObject, NSApplicationDelegate {
    private var server: Process?
    private var window: NSWindow?
    private let resources = Bundle.main.resourceURL!.appendingPathComponent("Mailbox")
    private let status = NSTextField(wrappingLabelWithString: "邮件服务在本机运行。关闭此窗口会停止服务。")

    func applicationDidFinishLaunching(_ notification: Notification) {
        let open = NSButton(title: "打开邮箱", target: self, action: #selector(openMailbox))
        let configure = NSButton(title: "配置本机 OAuth", target: self, action: #selector(configureOAuth))
        let buttons = NSStackView(views: [open, configure])
        let body = NSStackView(views: [status, buttons])
        body.orientation = .vertical
        body.alignment = .leading
        body.spacing = 18
        body.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 130),
                              styleMask: [.titled, .closable, .miniaturizable],
                              backing: .buffered, defer: false)
        window.title = "Agentic Mailbox"
        window.contentView = body
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
        openMailbox()
    }

    @objc private func openMailbox() {
        if server?.isRunning == true {
            let port = ProcessInfo.processInfo.environment["AGENTIC_MAILBOX_LOCAL_PORT"] ??
                ProcessInfo.processInfo.environment["VAULT_LOCAL_PORT"] ?? "8787"
            if let url = URL(string: "http://127.0.0.1:\(port)") { NSWorkspace.shared.open(url) }
            return
        }
        let task = Process()
        task.executableURL = resources.appendingPathComponent("runtime/node")
        task.arguments = ["scripts/local.mjs"]
        task.currentDirectoryURL = resources
        task.terminationHandler = { [weak self] process in
            let failed = process.terminationStatus != 0
            DispatchQueue.main.async {
                self?.status.stringValue = failed ? "启动失败。请检查本机端口是否被占用，再点击「打开邮箱」。" : "本机邮箱已停止。"
            }
        }
        do {
            try task.run()
            server = task
            status.stringValue = "正在打开本机邮箱。关闭此窗口会停止服务。"
        } catch {
            status.stringValue = "无法启动本机邮箱。请重新安装此应用。"
        }
    }

    @objc private func configureOAuth() {
        NSWorkspace.shared.open(resources.appendingPathComponent("配置本机 OAuth.command"))
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        if let server, server.isRunning { server.terminate() }
    }
}

let app = NSApplication.shared
let delegate = Launcher()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
