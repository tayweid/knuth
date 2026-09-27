// Knuth.app: a native window around Knuth, with a Python of its own.
//
// APP.md. The app never uses a Python that happens to be on the Mac. The
// first launch asks, inside the window, which of two it should run:
//
// - Full Python: the app downloads uv, uv installs its own Python, and
//   the engine (the knuth package, carried in this bundle) runs on it.
//   Every document gets its own environment from its PEP 723 header.
// - On the web: Pyodide runs the cells inside the window. Nothing is
//   installed; the shell serves the page and does the file I/O itself.
//
// Neither ships in the download, which is why the download is small. The
// shell owns a window per document, the native open/save dialogs, the
// setup, and the engine process's lifetime.
//
// Built by app/build.sh with swiftc alone — no Xcode project (not Tauri).

import AppKit
import WebKit

let environment = ProcessInfo.processInfo.environment
let logURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/Knuth.log")
// Everything the app installs or remembers lives in one folder, which is
// also the engine's own preference store (python/knuth/state.py).
// KNUTH_CONFIG_DIR, KNUTH_PORT, KNUTH_UV_ARCHIVE and KNUTH_CHOOSE are for
// development (`open --env`); a Finder launch has none of them.
let stateDir: URL = {
    if let override = environment["KNUTH_CONFIG_DIR"], !override.isEmpty {
        return URL(fileURLWithPath: override)
    }
    return FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Knuth")
}()
let preferencesURL = stateDir.appendingPathComponent("preferences.json")
/// Where uv's own installer puts uv, and where Knuth puts it when a Mac
/// has none: then it is an ordinary uv, usable from the terminal too.
let standardUV = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin/uv")

/// The uv on this Mac, wherever it came from: uv is uv. An app opened
/// from Finder gets a bare PATH, so the usual places are asked directly.
func findUV() -> URL? {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    var candidates = [environment["KNUTH_UV"] ?? ""]
    candidates += [standardUV.path, "/opt/homebrew/bin/uv", "/usr/local/bin/uv", "\(home)/.cargo/bin/uv"]
    candidates += (environment["PATH"] ?? "").split(separator: ":").map { "\($0)/uv" }
    return candidates.first { !$0.isEmpty && FileManager.default.isExecutableFile(atPath: $0) }
        .map { URL(fileURLWithPath: $0) }
}
let engineDir = stateDir.appendingPathComponent("engine")
let enginePython = engineDir.appendingPathComponent("bin/python")
/// The Python uv installs for the engine. Documents choose their own
/// through their headers; this is only what the engine itself runs on.
let enginePythonVersion = "3.13"
// The app's engine keeps to its own port, apart from a `knuth app` someone
// runs in a terminal on 5197: two engines, two Pythons, never confused.
let preferredPort = Int(environment["KNUTH_PORT"] ?? "") ?? 5187
// The knuth package, carried in the bundle: the engine's code and, inside
// it, the page. The app and its engine are therefore always one version.
let bundledPython = Bundle.main.resourceURL?.appendingPathComponent("python")
let bundledWebRoot = bundledPython?.appendingPathComponent("knuth/web")
let appScheme = "knuth"
let appOrigin = "\(appScheme)://app"

/// Which Python runs the cells: the engine on a Python uv installed, or
/// Pyodide in the window with the shell doing files.
enum PythonMode: String {
    case uv, browser
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
func run(
    _ executable: String, _ arguments: [String], timeout: TimeInterval = 30,
    environment child: [String: String]? = nil
) -> (Int32, String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    if let child = child { process.environment = child }
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

// MARK: - Setting up the full Python

enum SetupError: Error {
    case download(String)
    case install(String)
    case start(String)

    var message: String {
        switch self {
        case .download(let text), .install(let text), .start(let text): return text
        }
    }
}

/// What uv is told, always: use only Pythons it manages itself, so
/// nothing on the Mac (Anaconda, Homebrew, python.org) is touched or
/// relied on.
func uvEnvironment() -> [String: String] {
    var child = environment
    child["UV_PYTHON_PREFERENCE"] = "only-managed"
    child["UV_NO_PROGRESS"] = "1"
    return child
}

func lastLines(_ text: String, _ count: Int = 6) -> String {
    text.split(separator: "\n").suffix(count).joined(separator: "\n")
}

/// uv, then a Python, then the one package the engine needs. Each step is
/// skipped when its result is already in place, so a second run — or a
/// run after an interrupted first — picks up where things stand.
enum Installer {
    static var isInstalled: Bool {
        findUV() != nil && FileManager.default.isExecutableFile(atPath: enginePython.path)
    }

    static func install(progress: @escaping (String) -> Void) -> Result<Void, SetupError> {
        if findUV() == nil {
            progress("Downloading uv…")
            if case .failure(let error) = fetchUV() { return .failure(error) }
        }
        guard let uv = findUV() else { return .failure(.install("uv could not be found after installing it.")) }
        log("using uv at \(uv.path)")
        if !FileManager.default.isExecutableFile(atPath: enginePython.path) {
            progress("Installing Python \(enginePythonVersion)… (about a minute)")
            let (status, output) = run(
                uv.path, ["venv", "--python", enginePythonVersion, engineDir.path],
                timeout: 900, environment: uvEnvironment())
            log("uv venv: exit \(status)\n\(lastLines(output))")
            if status != 0 {
                return .failure(.install("Python could not be installed.\n\(lastLines(output, 3))"))
            }
        }
        progress("Preparing the engine…")
        let (status, output) = run(
            uv.path,
            ["pip", "install", "--python", enginePython.path, "websockets>=14.0"],
            timeout: 600, environment: uvEnvironment())
        log("uv pip install websockets: exit \(status)\n\(lastLines(output))")
        if status != 0 {
            return .failure(.install("The engine could not be prepared.\n\(lastLines(output, 3))"))
        }
        return .success(())
    }

    /// The uv release for this Mac's processor, from Astral's GitHub
    /// releases, put where uv's own installer would put it.
    private static func fetchUV() -> Result<Void, SetupError> {
        var system = utsname()
        uname(&system)
        let machine = withUnsafePointer(to: &system.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
        }
        let arch = machine == "arm64" ? "aarch64" : "x86_64"
        let source = environment["KNUTH_UV_ARCHIVE"]
            ?? "https://github.com/astral-sh/uv/releases/latest/download/uv-\(arch)-apple-darwin.tar.gz"
        let work = FileManager.default.temporaryDirectory
            .appendingPathComponent("knuth-uv-\(ProcessInfo.processInfo.processIdentifier)")
        try? FileManager.default.removeItem(at: work)
        defer { try? FileManager.default.removeItem(at: work) }
        do {
            try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        } catch {
            return .failure(.download("Could not create a working folder: \(error.localizedDescription)"))
        }
        let archive = work.appendingPathComponent("uv.tar.gz")
        if source.hasPrefix("/") {
            do {
                try FileManager.default.copyItem(atPath: source, toPath: archive.path)
            } catch {
                return .failure(.download("Could not read \(source): \(error.localizedDescription)"))
            }
        } else {
            guard let url = URL(string: source) else { return .failure(.download("Bad uv address: \(source)")) }
            var problem: String?
            let done = DispatchSemaphore(value: 0)
            URLSession.shared.downloadTask(with: url) { file, response, error in
                defer { done.signal() }
                if let error = error {
                    problem = error.localizedDescription
                    return
                }
                guard let file = file, let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                    problem = "the server answered \((response as? HTTPURLResponse)?.statusCode ?? 0)"
                    return
                }
                do {
                    try FileManager.default.moveItem(at: file, to: archive)
                } catch {
                    problem = error.localizedDescription
                }
            }.resume()
            if done.wait(timeout: .now() + 600) == .timedOut { problem = "the download timed out" }
            if let problem = problem {
                log("uv download failed: \(problem)")
                return .failure(.download("uv could not be downloaded: \(problem). Check the network and try again."))
            }
        }
        let (status, output) = run("/usr/bin/tar", ["-xzf", archive.path, "-C", work.path], timeout: 120)
        if status != 0 { return .failure(.download("uv could not be unpacked.\n\(lastLines(output, 3))")) }
        guard let found = FileManager.default.enumerator(at: work, includingPropertiesForKeys: nil)?
            .compactMap({ $0 as? URL }).first(where: { $0.lastPathComponent == "uv" })
        else { return .failure(.download("The uv download did not contain uv.")) }
        do {
            try FileManager.default.createDirectory(
                at: standardUV.deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileManager.default.moveItem(at: found, to: standardUV)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: standardUV.path)
        } catch {
            return .failure(.download("uv could not be put in place: \(error.localizedDescription)"))
        }
        let (versionStatus, version) = run(standardUV.path, ["--version"], timeout: 30)
        log("installed \(versionStatus == 0 ? version.trimmingCharacters(in: .whitespacesAndNewlines) : "uv (unverified)") at \(standardUV.path)")
        return versionStatus == 0 ? .success(()) : .failure(.download("The downloaded uv does not run on this Mac."))
    }
}

// MARK: - The engine

/// The knuth engine from this bundle, on the Python uv installed, as the
/// app's own child: started at launch, stopped at quit, and told the
/// app's pid so it stops by itself if the app is killed.
final class Engine {
    private var child: Process?
    private(set) var port = preferredPort

    var origin: String { "http://127.0.0.1:\(port)" }

    static func isFree(_ port: Int) -> Bool {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return false }
        defer { close(descriptor) }
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(port).bigEndian
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return result != 0
    }

    func isUp() -> Bool {
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

    var isRunning: Bool { child?.isRunning ?? false }

    func start() -> Result<Void, SetupError> {
        if isRunning { return .success(()) }
        guard let package = bundledPython,
              FileManager.default.fileExists(atPath: package.appendingPathComponent("knuth/server.py").path)
        else { return .failure(.start("This build of Knuth.app does not carry the engine (app/build.sh copies it).")) }
        port = preferredPort
        while !Engine.isFree(port) && port < preferredPort + 40 { port += 1 }

        let process = Process()
        process.executableURL = enginePython
        process.arguments = [
            "-m", "knuth", "serve", "--port", String(port),
            "--parent", String(ProcessInfo.processInfo.processIdentifier),
        ]
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        var child = uvEnvironment()
        child["PYTHONPATH"] = package.path
        if let uv = findUV() { child["KNUTH_UV"] = uv.path }
        child["KNUTH_CONFIG_DIR"] = stateDir.path
        child["PYTHONDONTWRITEBYTECODE"] = "1" // the bundle is not ours to write into
        process.environment = child
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
            return .failure(.start("The engine could not be started: \(error.localizedDescription)"))
        }
        self.child = process
        log("started engine on port \(port): \(enginePython.path) -m knuth serve (pid \(process.processIdentifier))")
        let deadline = Date().addingTimeInterval(25)
        while Date() < deadline {
            if isUp() { return .success(()) }
            if !process.isRunning {
                return .failure(.start("The engine stopped as it started (status \(process.terminationStatus)). The log has the reason."))
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return .failure(.start("The engine did not answer within 25 seconds."))
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
        case "choose":
            (NSApp.delegate as? AppDelegate)?.choose(body["python"], in: self)
        case "status":
            log("page: Python is \(body["state"] as? String ?? "?") (\(window.title))")
        case "error":
            log("page error: \(body["message"] as? String ?? "?") (\(window.title))")
        default:
            log("unknown shell message: \(type)")
        }
    }

    /// Tell the setup page something: `progress` or `failed`, with a line.
    func setup(_ kind: String, _ text: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: [text]),
              let array = String(data: data, encoding: .utf8)
        else { return }
        webView.evaluateJavaScript("window.knuthSetup && window.knuthSetup.\(kind)(\(array)[0])", completionHandler: nil)
    }

    /// Leave setup for a document (or a new one), in this same window.
    func show(_ url: URL, document: URL?) {
        documentURL = document
        window.representedURL = document
        window.title = document?.lastPathComponent ?? "Knuth"
        webView.load(URLRequest(url: url))
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
    /// nil until a Python is chosen and ready: documents wait in `pending`.
    private var mode: PythonMode?
    private var pending: [URL] = []
    private var installing = false

    func applicationWillFinishLaunching(_ notification: Notification) {
        buildMenu()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.activate(ignoringOtherApps: true)
        let remembered = (readPreferences()["python"] as? String).flatMap(PythonMode.init(rawValue:))
        switch remembered {
        case .browser:
            becomeReady(.browser, in: nil)
        case .uv where Installer.isInstalled:
            startEngine(in: nil)
        case .uv:
            // Chosen before, but its pieces are gone: set it up again.
            showSetup(choosing: PythonMode.uv.rawValue)
        case nil:
            showSetup(choosing: environment["KNUTH_CHOOSE"])
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.isFileURL {
            if mode != nil { openWindow(url: pageURL(for: url), document: url) }
            else { pending.append(url) }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            if mode != nil { openWindow(url: pageURL(for: nil), document: nil) }
            else if !installing { showSetup(choosing: nil) }
        }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        engine.stop()
    }

    // MARK: choosing a Python

    /// The choice, inside a window: the bundled setup page, which posts
    /// `choose` back and shows the progress the install reports.
    private func showSetup(choosing: String?) {
        var components = URLComponents(string: "\(appOrigin)/setup.html")!
        if let choosing = choosing, PythonMode(rawValue: choosing) != nil {
            components.queryItems = [URLQueryItem(name: "choose", value: choosing)]
        }
        let controller = DocumentWindow(url: components.url!, document: nil)
        controller.window.title = "Knuth"
        windows.append(controller)
    }

    func choose(_ value: Any?, in window: DocumentWindow) {
        guard let name = value as? String, let chosen = PythonMode(rawValue: name), !installing else { return }
        log("chosen: \(chosen.rawValue) Python")
        switch chosen {
        case .browser:
            becomeReady(.browser, in: window)
        case .uv:
            installing = true
            DispatchQueue.global(qos: .userInitiated).async { [self] in
                let installed = Installer.install { line in
                    log("setup: \(line)")
                    DispatchQueue.main.async { window.setup("progress", line) }
                }
                DispatchQueue.main.async { [self] in
                    installing = false
                    switch installed {
                    case .failure(let error):
                        log("setup failed: \(error.message)")
                        window.setup("failed", error.message)
                    case .success:
                        window.setup("progress", "Starting Python…")
                        startEngine(in: window)
                    }
                }
            }
        }
    }

    private func startEngine(in window: DocumentWindow?) {
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            let started = engine.start()
            DispatchQueue.main.async { [self] in
                switch started {
                case .success:
                    becomeReady(.uv, in: window)
                case .failure(let error):
                    log("engine failed: \(error.message)")
                    if let window = window { window.setup("failed", error.message) }
                    else { fail(error) }
                }
            }
        }
    }

    /// A Python is running: remember the choice, and open what was waiting
    /// — the first of it in the setup window, if that is where we are.
    private func becomeReady(_ chosen: PythonMode, in window: DocumentWindow?) {
        if chosen == .browser,
           bundledWebRoot.map({ FileManager.default.fileExists(atPath: $0.appendingPathComponent("index.html").path) }) != true {
            fail(.start("This build of Knuth.app does not carry the page (app/build.sh copies it)."))
            return
        }
        mode = chosen
        writePreference("python", chosen.rawValue)
        log("running the \(chosen == .uv ? "full Python (uv), engine on port \(engine.port)" : "Python on the web (Pyodide)")")
        var waiting = pending
        pending = []
        if let window = window {
            let first = waiting.isEmpty ? nil : waiting.removeFirst()
            window.show(pageURL(for: first), document: first)
        }
        for url in waiting { openWindow(url: pageURL(for: url), document: url) }
        // Launched with nothing to open (Dock, Finder): show the app. Files
        // arriving at launch land before this, so a short wait is enough.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [self] in
            if windows.isEmpty { openWindow(url: pageURL(for: nil), document: nil) }
        }
    }

    private func fail(_ error: SetupError) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Knuth could not start Python"
        alert.informativeText = "\(error.message)\n\nLog: \(logURL.path)"
        alert.addButton(withTitle: "Choose Python…")
        alert.addButton(withTitle: "Quit")
        if alert.runModal() == .alertFirstButtonReturn { showSetup(choosing: nil) }
        else { NSApp.terminate(nil) }
    }

    // MARK: windows

    func pageURL(for document: URL?) -> URL {
        var components = URLComponents(string: mode == .browser ? "\(appOrigin)/" : "\(engine.origin)/")!
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
        guard mode != nil else { return }
        openWindow(url: pageURL(for: nil), document: nil)
    }

    /// File → Open…: a document app opens each file in its own window.
    @objc func openDocument(_ sender: Any?) {
        guard mode != nil else { return }
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

    /// The same choice as the first launch. It applies to windows opened
    /// from then on; a window already open keeps the Python it has.
    @objc func choosePython(_ sender: Any?) {
        guard !installing else { return }
        showSetup(choosing: nil)
    }

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Knuth", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Choose Python…", action: #selector(choosePython(_:)), keyEquivalent: "")
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
