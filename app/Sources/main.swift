// Knuth.app: a native window around the page the local engine serves.
//
// APP.md, "What the shell does, exactly". The shell owns a window per
// document, the native open/save dialogs, and the engine process's
// lifetime. With an engine, documents are read and written by it over the
// page's own socket and the shell never touches one. With the built-in
// Python instead (no Python on this Mac: Pyodide runs the cells in the
// tab), there is no engine, so the shell serves the page from its bundle
// under knuth://app/ and answers the page's file requests itself.
//
// Built by app/build.sh with swiftc alone — no Xcode project (not Tauri).

import AppKit
import WebKit

let environment = ProcessInfo.processInfo.environment
// KNUTH_PORT and KNUTH_CONFIG_DIR are for development (`open --env`): a
// Finder launch has neither and gets the defaults the engine also uses.
let port = Int(environment["KNUTH_PORT"] ?? "") ?? 5197
let origin = "http://127.0.0.1:\(port)"
let logURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/Knuth.log")
// The engine's own preference store (python/knuth/state.py): the shell
// reads and writes one key there, "python", so `knuth doctor` and the app
// agree about which interpreter is the engine.
let preferencesURL: URL = {
    if let override = environment["KNUTH_CONFIG_DIR"], !override.isEmpty {
        return URL(fileURLWithPath: override).appendingPathComponent("preferences.json")
    }
    return FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Knuth/preferences.json")
}()
let installRequirement =
    "knuth @ https://github.com/tayweid/knuth/archive/refs/heads/main.zip#subdirectory=python"
// The page, as the engine would serve it, for the built-in Python mode.
let bundledWebRoot = Bundle.main.resourceURL?.appendingPathComponent("web")
let appScheme = "knuth"
let appOrigin = "\(appScheme)://app"

/// Which Python runs the cells (APP.md, "Built-in Python"): the engine in
/// a Python on this Mac, or Pyodide in the tab with the shell doing files.
enum PythonMode: String {
    case engine, browser
}

// MARK: - Small helpers

/// The log, opened for appending at the descriptor level: the shell and
/// the engine both write to it, and only O_APPEND keeps two writers with
/// their own offsets from overwriting each other.
func openLog() -> FileHandle? {
    try? FileManager.default.createDirectory(
        at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    let descriptor = open(logURL.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
    return descriptor >= 0 ? FileHandle(fileDescriptor: descriptor, closeOnDealloc: true) : nil
}

func log(_ line: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    let text = "[\(stamp)] Knuth.app: \(line)\n"
    guard let handle = openLog() else { return }
    handle.write(text.data(using: .utf8)!)
    handle.closeFile()
}

/// Run a command to completion; (exit status, combined output). A timeout
/// kills it and reports -1, so a hung interpreter never hangs the launch.
@discardableResult
func run(_ executable: String, _ arguments: [String], timeout: TimeInterval = 30) -> (Int32, String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    do {
        try process.run()
    } catch {
        return (-1, "\(error)")
    }
    let deadline = Date().addingTimeInterval(timeout)
    while process.isRunning && Date() < deadline {
        Thread.sleep(forTimeInterval: 0.05)
    }
    if process.isRunning {
        process.terminate()
        return (-1, "timed out")
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}

func readPreferences() -> [String: Any] {
    guard let data = try? Data(contentsOf: preferencesURL),
          let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return [:] }
    return parsed
}

func writePreference(_ key: String, _ value: Any) {
    var merged = readPreferences()
    merged[key] = value
    guard let data = try? JSONSerialization.data(withJSONObject: merged) else { return }
    try? FileManager.default.createDirectory(
        at: preferencesURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? data.write(to: preferencesURL)
}

// MARK: - The engine

enum EngineError: Error {
    case noPython
    case installFailed(String)
    case startFailed(String)
}

/// Starts `knuth serve` when nothing owns the port, reuses whatever does,
/// and stops only what it started.
final class Engine {
    private var child: Process?
    private(set) var python: String?

    /// Whether the engine answers on its port (any engine: ours, the
    /// launchd agent, or a terminal's).
    static func isUp() -> Bool {
        var up = false
        let done = DispatchSemaphore(value: 0)
        var request = URLRequest(url: URL(string: "\(origin)/")!)
        request.timeoutInterval = 1.5
        request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { data, response, _ in
            if let http = response as? HTTPURLResponse, http.statusCode == 200,
               let data = data, let body = String(data: data, encoding: .utf8),
               body.range(of: "knuth", options: .caseInsensitive) != nil {
                up = true
            }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 2.5)
        return up
    }

    /// Interpreters worth trying, most likely science environment first
    /// (APP.md, "First launch installs the engine"). A remembered choice
    /// goes ahead of all of them.
    static func candidatePythons() -> [String] {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var list: [String] = []
        if let remembered = readPreferences()["python"] as? String { list.append(remembered) }
        list += [
            "\(home)/anaconda3/bin/python3",
            "/opt/anaconda3/bin/python3",
            "\(home)/miniconda3/bin/python3",
            "/opt/miniconda3/bin/python3",
            "\(home)/miniforge3/bin/python3",
            "/opt/homebrew/bin/python3",
            "/usr/local/bin/python3",
            "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
        ]
        // Apple's stub pops a "install the command line tools" dialog when
        // they are missing; only consider it when it is a real Python.
        if FileManager.default.fileExists(atPath: "/Library/Developer/CommandLineTools/usr/bin/python3") {
            list.append("/usr/bin/python3")
        }
        var seen = Set<String>()
        return list.filter { FileManager.default.isExecutableFile(atPath: $0) && seen.insert($0).inserted }
    }

    static func hasModule(_ python: String, _ module: String) -> Bool {
        run(python, ["-c", "import sys; assert sys.version_info >= (3, 11); import \(module)"], timeout: 60).0 == 0
    }

    /// The interpreter to run the engine in: one that already has knuth,
    /// else the best one to install it into (nil when knuth is missing).
    static func choosePython() -> (path: String, hasKnuth: Bool)? {
        let candidates = candidatePythons()
        if let ready = candidates.first(where: { hasModule($0, "knuth") }) { return (ready, true) }
        if let science = candidates.first(where: { hasModule($0, "pandas") }) { return (science, false) }
        if let any = candidates.first(where: { hasModule($0, "sys") }) { return (any, false) }
        return nil
    }

    static func install(into python: String) -> Result<Void, EngineError> {
        let (status, output) = run(
            python,
            ["-m", "pip", "install", "--upgrade", "--force-reinstall", installRequirement],
            timeout: 600)
        log("pip install into \(python): exit \(status)\n\(output.suffix(2000))")
        return status == 0 ? .success(()) : .failure(.installFailed(String(output.suffix(1500))))
    }

    /// Start `knuth serve` as our child and wait for it to answer.
    func start(with python: String) -> Result<Void, EngineError> {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: python)
        // --parent: the engine watches this process and stops when it is
        // gone, so a crash or force-quit never leaves an orphan (APP.md).
        process.arguments = [
            "-m", "knuth", "serve", "--port", String(port),
            "--parent", String(ProcessInfo.processInfo.processIdentifier),
        ]
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        process.environment = environment
        if let handle = openLog() {
            process.standardOutput = handle
            process.standardError = handle
        }
        process.terminationHandler = { finished in
            log("engine exited with status \(finished.terminationStatus)")
        }
        do {
            try process.run()
        } catch {
            return .failure(.startFailed("\(error)"))
        }
        child = process
        self.python = python
        log("started engine: \(python) -m knuth serve --port \(port) --parent \(ProcessInfo.processInfo.processIdentifier) (pid \(process.processIdentifier))")
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            if Engine.isUp() { return .success(()) }
            if !process.isRunning {
                return .failure(.startFailed("the engine exited with status \(process.terminationStatus); see \(logURL.path)"))
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return .failure(.startFailed("the engine did not answer on port \(port) within 20 seconds"))
    }

    func stop() {
        guard let process = child, process.isRunning else { return }
        log("stopping engine (pid \(process.processIdentifier))")
        process.terminate()
        let deadline = Date().addingTimeInterval(5)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        child = nil
    }
}

// MARK: - Serving the page from the bundle

/// knuth://app/<path> → Contents/Resources/web/<path>. What the engine's
/// web.py does over HTTP, for the mode with no engine.
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    let root: URL

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    private static let contentTypes: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8",
        "mjs": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8",
        "json": "application/json; charset=utf-8", "webmanifest": "application/manifest+json",
        "svg": "image/svg+xml", "png": "image/png", "ico": "image/x-icon",
        "woff": "font/woff", "woff2": "font/woff2", "otf": "font/otf", "ttf": "font/ttf",
        "wasm": "application/wasm", "txt": "text/plain; charset=utf-8",
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var relative = url.path
        if relative.isEmpty || relative == "/" { relative = "/index.html" }
        let file = root.appendingPathComponent(String(relative.dropFirst())).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"),
              let data = FileManager.default.contents(atPath: file.path)
        else {
            let response = HTTPURLResponse(
                url: url, statusCode: 404, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/plain"])!
            task.didReceive(response)
            task.didReceive(Data("not found".utf8))
            task.didFinish()
            return
        }
        let type = AppSchemeHandler.contentTypes[file.pathExtension.lowercased()] ?? "application/octet-stream"
        let response = HTTPURLResponse(
            url: url, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": type,
                "Content-Length": String(data.count),
                "Cache-Control": "no-cache",
                "X-Content-Type-Options": "nosniff",
            ])!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

// MARK: - Files on the page's behalf

/// The shell's answers to read/write/stat/rename/remove, shaped like the
/// engine's files.py replies so the page's one file manager serves both.
enum FileOps {
    static let maxDocumentBytes = 8 * 1024 * 1024

    private static func modified(_ path: String) -> Int? {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
              let date = attributes[.modificationDate] as? Date
        else { return nil }
        return Int(date.timeIntervalSince1970 * 1000)
    }

    private static func checked(_ value: Any?) -> (String?, [String: Any]?) {
        guard let path = value as? String, !path.isEmpty else {
            return (nil, ["error": "path must be a non-empty string"])
        }
        guard path.hasPrefix("/") else { return (nil, ["error": "path must be absolute"]) }
        return (path, nil)
    }

    static func read(_ value: Any?) -> [String: Any] {
        let (path, problem) = checked(value)
        guard let path = path else { return problem! }
        let name = (path as NSString).lastPathComponent
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) else {
            return ["error": "\(name) does not exist"]
        }
        if isDirectory.boolValue { return ["error": "\(name) is not a file"] }
        guard let data = FileManager.default.contents(atPath: path) else {
            return ["error": "\(name) could not be read"]
        }
        if data.count > maxDocumentBytes {
            return ["error": "\(name) is larger than \(maxDocumentBytes / (1024 * 1024)) MB"]
        }
        guard let text = String(data: data, encoding: .utf8) else {
            return ["error": "\(name) is not UTF-8 text"]
        }
        return ["path": path, "name": name, "text": text, "modified": modified(path) ?? NSNull()]
    }

    static func write(_ value: Any?, _ text: Any?) -> [String: Any] {
        let (path, problem) = checked(value)
        guard let path = path else { return problem! }
        guard let text = text as? String else { return ["error": "text must be a string"] }
        let name = (path as NSString).lastPathComponent
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue {
            return ["error": "\(name) is not a file"]
        }
        let url = URL(fileURLWithPath: path)
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            // .atomic stages beside the destination and renames into place.
            try Data(text.utf8).write(to: url, options: .atomic)
        } catch {
            return ["error": "\(name) could not be saved: \(error.localizedDescription)"]
        }
        return ["path": path, "modified": modified(path) ?? NSNull()]
    }

    static func stat(_ value: Any?) -> [String: Any] {
        let (path, problem) = checked(value)
        guard let path = path else { return problem! }
        var isDirectory: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) && !isDirectory.boolValue
        var stamp: Any = NSNull()
        if exists, let milliseconds = modified(path) { stamp = milliseconds }
        return ["path": path, "modified": stamp]
    }

    static func rename(_ value: Any?, _ newName: Any?) -> [String: Any] {
        let (path, problem) = checked(value)
        guard let path = path else { return problem! }
        guard let raw = newName as? String else { return ["error": "name must be a string"] }
        let name = raw.trimmingCharacters(in: .whitespaces)
        if name.isEmpty || name == "." || name == ".." || name.contains("/") {
            return ["error": "name must be a file name, not a path"]
        }
        let target = (path as NSString).deletingLastPathComponent + "/" + name
        guard FileManager.default.fileExists(atPath: path) else {
            return ["error": "\((path as NSString).lastPathComponent) does not exist"]
        }
        if target != path && FileManager.default.fileExists(atPath: target) {
            return ["error": "\(name) already exists"]
        }
        do {
            if target != path { try FileManager.default.moveItem(atPath: path, toPath: target) }
        } catch {
            return ["error": "could not rename: \(error.localizedDescription)"]
        }
        return ["path": target, "name": name, "modified": modified(target) ?? NSNull()]
    }

    static func remove(_ value: Any?) -> [String: Any] {
        let (path, problem) = checked(value)
        guard let path = path else { return problem! }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) else { return [:] }
        if isDirectory.boolValue { return ["error": "not a file"] }
        do {
            try FileManager.default.removeItem(atPath: path)
        } catch {
            return ["error": "could not delete: \(error.localizedDescription)"]
        }
        return [:]
    }
}

// MARK: - A document window

final class DocumentWindow: NSObject, NSWindowDelegate, WKScriptMessageHandler,
    WKNavigationDelegate, WKUIDelegate
{
    let window: NSWindow
    let webView: WKWebView
    private var titleObservation: NSKeyValueObservation?
    /// The document this window was opened with, for dialogs' start folder
    /// and the title bar's proxy icon.
    var documentURL: URL?

    init(url: URL, document: URL?) {
        let configuration = WKWebViewConfiguration()
        configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")
        if let webRoot = bundledWebRoot {
            configuration.setURLSchemeHandler(AppSchemeHandler(root: webRoot), forURLScheme: appScheme)
        }
        webView = WKWebView(frame: .zero, configuration: configuration)
        let frame = NSRect(x: 0, y: 0, width: 1100, height: 760)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        documentURL = document
        super.init()

        configuration.userContentController.add(self, name: "knuth")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.autoresizingMask = [.width, .height]
        window.contentView = webView
        window.delegate = self
        window.title = document?.lastPathComponent ?? "Knuth"
        window.representedURL = document
        window.setFrameAutosaveName("KnuthDocument")
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.minSize = NSSize(width: 520, height: 360)
        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] view, _ in
            guard let self = self, let title = view.title, !title.isEmpty else { return }
            self.window.title = title
        }
        webView.load(URLRequest(url: url))
        window.center()
        if let document = document { _ = document } // keep the cascade default
        window.makeKeyAndOrderFront(nil)
    }

    // Requests from the page (fs-types.d.ts: KnuthShellMessage). Dialogs and
    // file operations carry an id and get one reply each; status and error
    // reports only go to the log.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        let id = body["id"] as? Int
        switch type {
        case "open":
            let panel = NSOpenPanel()
            panel.canChooseDirectories = false
            panel.allowsMultipleSelection = false
            panel.directoryURL = documentURL?.deletingLastPathComponent()
            panel.beginSheetModal(for: window) { [weak self] response in
                self?.chose(id, response == .OK ? panel.url : nil)
            }
        case "saveAs":
            let panel = NSSavePanel()
            panel.nameFieldStringValue = body["name"] as? String ?? "Knuth.py"
            panel.directoryURL = documentURL?.deletingLastPathComponent()
            panel.canCreateDirectories = true
            panel.beginSheetModal(for: window) { [weak self] response in
                self?.chose(id, response == .OK ? panel.url : nil)
            }
        case "read":
            reply(id, FileOps.read(body["path"]))
        case "write":
            reply(id, FileOps.write(body["path"], body["text"]))
        case "stat":
            reply(id, FileOps.stat(body["path"]))
        case "rename":
            reply(id, FileOps.rename(body["path"], body["name"]))
        case "remove":
            reply(id, FileOps.remove(body["path"]))
        case "status":
            log("page: Python is \(body["state"] as? String ?? "?") (\(window.title))")
        case "error":
            log("page error: \(body["message"] as? String ?? "?") (\(window.title))")
        default:
            log("unknown shell message: \(type)")
        }
    }

    private func chose(_ id: Int?, _ url: URL?) {
        if let url = url {
            documentURL = url
            window.representedURL = url
        }
        reply(id, ["path": url?.path ?? NSNull()])
    }

    private func reply(_ id: Int?, _ result: [String: Any]) {
        guard let id = id else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: result),
              let json = String(data: data, encoding: .utf8)
        else {
            log("could not serialize a reply to request \(id)")
            return
        }
        webView.evaluateJavaScript("window.knuthShell && window.knuthShell.reply(\(id), \(json))") { _, error in
            if let error = error { log("reply \(id) failed: \(error)") }
        }
    }

    // window.open from the page ("New" opens a fresh session) becomes one
    // of our windows rather than a WebKit popup.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView?
    {
        if let url = navigationAction.request.url {
            (NSApp.delegate as? AppDelegate)?.openWindow(url: url, document: nil)
        }
        return nil
    }

    // Links out of the page (the docs, GitHub) go to the default browser;
    // only our own origin renders here.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void)
    {
        if let url = navigationAction.request.url, let host = url.host,
           url.scheme?.hasPrefix("http") == true, !(host == "127.0.0.1" || host == "localhost") {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func windowWillClose(_ notification: Notification) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "knuth")
        (NSApp.delegate as? AppDelegate)?.forget(self)
    }
}

// MARK: - The application

final class AppDelegate: NSObject, NSApplicationDelegate {
    let engine = Engine()
    private var windows: [DocumentWindow] = []
    private var engineReady = false
    private var mode: PythonMode = .engine
    private var pending: [URL] = []
    private var launching = true

    func applicationWillFinishLaunching(_ notification: Notification) {
        buildMenu()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.activate(ignoringOtherApps: true)
        ensureEngine()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.isFileURL {
            if engineReady { openWindow(url: pageURL(for: url), document: url) }
            else { pending.append(url) }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag && engineReady { openWindow(url: pageURL(for: nil), document: nil) }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        engine.stop()
    }

    // MARK: engine

    private func ensureEngine() {
        if readPreferences()["engine"] as? String == PythonMode.browser.rawValue {
            useBuiltInPython()
            return
        }
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            if Engine.isUp() {
                log("using the engine already on port \(port)")
                DispatchQueue.main.async { self.engineBecameReady() }
                return
            }
            guard let choice = Engine.choosePython() else {
                DispatchQueue.main.async { self.offerBuiltIn() }
                return
            }
            if !choice.hasKnuth {
                DispatchQueue.main.async { self.offerInstall(into: choice.path) }
                return
            }
            self.startEngine(with: choice.path)
        }
    }

    /// The built-in Python: no engine, the page from the bundle, Pyodide in
    /// the tab. Remembered, so later launches never go looking for Python.
    private func useBuiltInPython() {
        guard let webRoot = bundledWebRoot,
              FileManager.default.fileExists(atPath: webRoot.appendingPathComponent("index.html").path)
        else {
            fail(.startFailed("this build of Knuth.app does not carry the page (app/build.sh copies it)"))
            return
        }
        mode = .browser
        writePreference("engine", PythonMode.browser.rawValue)
        log("using the built-in Python (page served from the bundle)")
        engineBecameReady()
    }

    /// No Python at all: the built-in one is the answer, and a choice.
    private func offerBuiltIn() {
        let alert = NSAlert()
        alert.messageText = "Use Knuth’s built-in Python?"
        alert.informativeText =
            "No Python was found in the usual places (Anaconda, Homebrew, python.org). " +
            "Knuth can run Python inside the window instead — nothing to install, though " +
            "only the packages it ships with, and large data has a lower ceiling.\n\n" +
            "You can switch to a Python on this Mac later from the Knuth menu."
        alert.addButton(withTitle: "Use Built-in Python")
        alert.addButton(withTitle: "Choose Python…")
        alert.addButton(withTitle: "Quit")
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            useBuiltInPython()
        case .alertSecondButtonReturn:
            choosePythonManually()
        default:
            NSApp.terminate(nil)
        }
    }

    private func startEngine(with python: String) {
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            switch engine.start(with: python) {
            case .success:
                writePreference("python", python)
                DispatchQueue.main.async { self.engineBecameReady() }
            case .failure(let error):
                DispatchQueue.main.async { self.fail(error) }
            }
        }
    }

    private func engineBecameReady() {
        if mode == .engine { writePreference("engine", PythonMode.engine.rawValue) }
        engineReady = true
        let queued = pending
        pending = []
        for url in queued { openWindow(url: pageURL(for: url), document: url) }
        // Launched with nothing to open (Dock, Finder): show the app. Files
        // arriving at launch land before this, so a short wait is enough.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [self] in
            launching = false
            if windows.isEmpty { openWindow(url: pageURL(for: nil), document: nil) }
        }
    }

    private func offerInstall(into python: String) {
        let alert = NSAlert()
        alert.messageText = "Install the Knuth engine?"
        alert.informativeText =
            "Knuth runs Python on this Mac. The engine will be installed into\n\(python)\n\n" +
            "This needs the network and takes about half a minute. Choose a different " +
            "Python if this is not where your packages live."
        alert.addButton(withTitle: "Install")
        alert.addButton(withTitle: "Use Built-in Python")
        alert.addButton(withTitle: "Choose Python…")
        alert.addButton(withTitle: "Quit")
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            install(into: python)
        case .alertSecondButtonReturn:
            useBuiltInPython()
        case .alertThirdButtonReturn:
            choosePythonManually()
        default:
            NSApp.terminate(nil)
        }
    }

    private func choosePythonManually() {
        let panel = NSOpenPanel()
        panel.message = "Choose the python3 executable the engine should run in"
        panel.canChooseDirectories = false
        panel.showsHiddenFiles = true
        panel.directoryURL = URL(fileURLWithPath: "/opt")
        guard panel.runModal() == .OK, let url = panel.url else {
            NSApp.terminate(nil)
            return
        }
        let python = url.path
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            let ready = Engine.hasModule(python, "knuth")
            DispatchQueue.main.async {
                if ready { self.startEngine(with: python) } else { self.install(into: python) }
            }
        }
    }

    private func install(into python: String) {
        let progress = NSAlert()
        progress.messageText = "Installing the Knuth engine…"
        progress.informativeText = "Into \(python)"
        let spinner = NSProgressIndicator(frame: NSRect(x: 0, y: 0, width: 32, height: 32))
        spinner.style = .spinning
        spinner.startAnimation(nil)
        progress.accessoryView = spinner
        progress.addButton(withTitle: "Cancel")
        var cancelled = false
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            let result = Engine.install(into: python)
            DispatchQueue.main.async {
                if cancelled { return }
                NSApp.abortModal()
                switch result {
                case .success:
                    writePreference("python", python)
                    self.startEngine(with: python)
                case .failure(let error):
                    self.fail(error)
                }
            }
        }
        if progress.runModal() == .alertFirstButtonReturn {
            cancelled = true
            NSApp.terminate(nil)
        }
    }

    private func fail(_ error: EngineError) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        switch error {
        case .noPython:
            alert.messageText = "Knuth needs Python 3.11 or newer"
            alert.informativeText =
                "No Python was found in the usual places (Anaconda, Homebrew, python.org). " +
                "Install one, then open Knuth again."
            alert.addButton(withTitle: "Quit")
        case .installFailed(let detail):
            alert.messageText = "The engine could not be installed"
            alert.informativeText = "pip reported:\n\n\(detail)\n\nFull log: \(logURL.path)"
            alert.addButton(withTitle: "Quit")
        case .startFailed(let detail):
            alert.messageText = "The engine did not start"
            alert.informativeText = "\(detail)\n\nLog: \(logURL.path)"
            alert.addButton(withTitle: "Quit")
        }
        alert.runModal()
        NSApp.terminate(nil)
    }

    // MARK: windows

    func pageURL(for document: URL?) -> URL {
        var components = URLComponents(string: mode == .browser ? "\(appOrigin)/" : "\(origin)/")!
        if let path = document?.path {
            components.queryItems = [URLQueryItem(name: "open", value: path)]
        }
        return components.url!
    }

    func openWindow(url: URL, document: URL?) {
        let controller = DocumentWindow(url: url, document: document)
        if let last = windows.last?.window {
            controller.window.cascadeTopLeft(from: NSPoint(x: last.frame.minX, y: last.frame.maxY))
        }
        windows.append(controller)
    }

    func forget(_ controller: DocumentWindow) {
        windows.removeAll { $0 === controller }
    }

    // MARK: menu

    @objc func newWindow(_ sender: Any?) {
        guard engineReady else { return }
        openWindow(url: pageURL(for: nil), document: nil)
    }

    /// File → Open…: a document app opens each file in its own window.
    @objc func openDocument(_ sender: Any?) {
        guard engineReady else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.begin { [self] response in
            guard response == .OK else { return }
            for url in panel.urls { openWindow(url: pageURL(for: url), document: url) }
        }
    }

    @objc func showLog(_ sender: Any?) {
        NSWorkspace.shared.open(logURL)
    }

    // Switching Python applies to windows opened from now on; a window
    // keeps the session it has.
    @objc func switchToBuiltIn(_ sender: Any?) {
        useBuiltInPython()
    }

    @objc func switchToLocal(_ sender: Any?) {
        writePreference("engine", PythonMode.engine.rawValue)
        mode = .engine
        engineReady = false
        ensureEngine()
    }

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Knuth", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Use Python on This Mac…", action: #selector(switchToLocal(_:)), keyEquivalent: "")
        appMenu.addItem(withTitle: "Use Built-in Python", action: #selector(switchToBuiltIn(_:)), keyEquivalent: "")
        appMenu.addItem(withTitle: "Show Log", action: #selector(showLog(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Knuth", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Knuth", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let fileItem = NSMenuItem()
        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(withTitle: "New Window", action: #selector(newWindow(_:)), keyEquivalent: "n")
        fileMenu.addItem(withTitle: "Open…", action: #selector(openDocument(_:)), keyEquivalent: "o")
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = fileMenu
        main.addItem(fileItem)

        // Without an Edit menu, ⌘C/⌘V/⌘Z never reach the web view.
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        main.addItem(editItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
