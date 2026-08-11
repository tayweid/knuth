#[cfg(target_os = "macos")]
#[macro_use]
extern crate objc;

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

#[derive(Serialize, Deserialize)]
struct FileResult {
    content: String,
    path: String,
}

/// Manages the Python sidecar process
struct PythonSidecar {
    process: Option<Child>,
    port: u16,
}

impl Drop for PythonSidecar {
    fn drop(&mut self) {
        if let Some(ref mut child) = self.process {
            let _ = child.kill();
        }
    }
}

/// Log to a file for debugging (Tauri apps can't write to stderr easily)
fn log(msg: &str) {
    let log_path = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("pymd-debug.log");
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&log_path) {
        let _ = writeln!(f, "[{}] {}", chrono_now(), msg);
    }
}

fn chrono_now() -> String {
    use std::time::SystemTime;
    let d = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", d.as_secs())
}

/// Find a free port
fn find_free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

/// Find a python executable that has pymd_server installed
fn find_python() -> Option<String> {
    let candidates = [
        "/opt/anaconda3/bin/python",
        "/opt/anaconda3/bin/python3",
        "/opt/homebrew/bin/python3",
        "/opt/homebrew/bin/python",
        "/usr/local/bin/python3",
        "/usr/local/bin/python",
    ];

    for candidate in &candidates {
        log(&format!("Trying python: {}", candidate));
        if !Path::new(candidate).exists() {
            log(&format!("  Not found at path"));
            continue;
        }
        match Command::new(candidate)
            .args(["-c", "import pymd_server; print('ok')"])
            .output()
        {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                log(&format!("  exit={} stdout={} stderr={}", output.status, stdout.trim(), stderr.trim()));
                if output.status.success() {
                    return Some(candidate.to_string());
                }
            }
            Err(e) => {
                log(&format!("  Error running: {}", e));
            }
        }
    }

    None
}

/// Start the sidecar and return the port
fn start_python_sidecar() -> Result<(Child, u16), String> {
    log("=== Starting sidecar ===");

    let python = match find_python() {
        Some(p) => p,
        None => {
            let msg = "No Python with pymd_server found. Install with: cd python && pip install -e .";
            log(msg);
            return Err(msg.to_string());
        }
    };

    let port = find_free_port();
    log(&format!("Using {} on port {}", python, port));

    let mut child = Command::new(&python)
        .args(["-m", "pymd_server", "--port", &port.to_string()])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            let msg = format!("Failed to spawn {}: {}", python, e);
            log(&msg);
            msg
        })?;

    log(&format!("Spawned PID {}", child.id()));

    // Wait for server to be ready
    std::thread::sleep(std::time::Duration::from_millis(1500));

    // Check if it died and capture stderr
    match child.try_wait() {
        Ok(Some(status)) => {
            let stderr = child.stderr.take()
                .map(|mut s| {
                    let mut buf = String::new();
                    use std::io::Read;
                    let _ = s.read_to_string(&mut buf);
                    buf
                })
                .unwrap_or_default();
            let stdout = child.stdout.take()
                .map(|mut s| {
                    let mut buf = String::new();
                    use std::io::Read;
                    let _ = s.read_to_string(&mut buf);
                    buf
                })
                .unwrap_or_default();
            log(&format!("Process died immediately! status={}", status));
            log(&format!("stdout: {}", stdout));
            log(&format!("stderr: {}", stderr));
            return Err(format!("Sidecar died: {}", stderr));
        }
        Ok(None) => {
            log("Process still running after 1.5s - good");
        }
        Err(e) => {
            log(&format!("Error checking process: {}", e));
        }
    }

    Ok((child, port))
}

/// Get the port the sidecar is running on (starts it if needed)
#[tauri::command]
async fn get_sidecar_port(state: tauri::State<'_, Mutex<PythonSidecar>>) -> Result<u16, String> {
    let mut sidecar = state.lock().map_err(|e| format!("Lock error: {}", e))?;

    // Check if process is still alive
    if let Some(ref mut child) = sidecar.process {
        match child.try_wait() {
            Ok(None) => {
                log(&format!("Sidecar still running on port {}", sidecar.port));
                return Ok(sidecar.port);
            }
            Ok(Some(status)) => {
                log(&format!("Sidecar died with status {}, restarting", status));
            }
            Err(e) => {
                log(&format!("Error checking sidecar: {}", e));
            }
        }
    }

    match start_python_sidecar() {
        Ok((child, port)) => {
            sidecar.process = Some(child);
            sidecar.port = port;
            Ok(port)
        }
        Err(e) => Err(e),
    }
}

/// Stores the file path received from macOS open-with
struct OpenedFile(Mutex<Option<String>>);

/// Get the file path if the app was opened with a file
#[tauri::command]
async fn get_opened_file(state: tauri::State<'_, OpenedFile>) -> Result<Option<String>, String> {
    // First check the stored path from macOS Apple Events
    let stored = state.0.lock().map_err(|e| e.to_string())?.clone();
    if stored.is_some() {
        return Ok(stored);
    }
    // Then check CLI args
    let args: Vec<String> = std::env::args().collect();
    for arg in args.iter().skip(1) {
        let path = std::path::Path::new(arg);
        if path.exists() && !arg.starts_with("-") {
            return Ok(Some(arg.clone()));
        }
    }
    Ok(None)
}

#[tauri::command]
async fn set_window_title(app: tauri::AppHandle, title: String) -> Result<(), String> {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        window.set_title(&title).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn read_file(path: String) -> Result<FileResult, String> {
    let content = fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(FileResult { content, path })
}

#[tauri::command]
async fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, &content).map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn save_image(filename: String, bytes: Vec<u8>) -> Result<String, String> {
    let assets_dir = Path::new("assets");
    fs::create_dir_all(assets_dir).map_err(|e| format!("Failed to create assets dir: {}", e))?;

    let safe_name = filename
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect::<String>();

    let target = assets_dir.join(&safe_name);

    let final_path = if target.exists() {
        let stem = target.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let ext = target.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        let mut i = 1;
        loop {
            let candidate = assets_dir.join(format!("{}-{}{}", stem, i, ext));
            if !candidate.exists() {
                break candidate;
            }
            i += 1;
        }
    } else {
        target
    };

    fs::write(&final_path, &bytes).map_err(|e| format!("Failed to save image: {}", e))?;

    Ok(format!("./{}", final_path.to_string_lossy()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    log("=== pymd app starting ===");

    // Start sidecar on launch
    let (process, port) = match start_python_sidecar() {
        Ok((child, port)) => {
            log(&format!("Sidecar ready on port {}", port));
            (Some(child), port)
        }
        Err(e) => {
            log(&format!("Failed to start sidecar: {}", e));
            (None, 0)
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(Mutex::new(PythonSidecar { process, port }))
        .manage(OpenedFile(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            save_image,
            get_sidecar_port,
            set_window_title,
            get_opened_file
        ])
        .setup(|app| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                {
                    use cocoa::appkit::NSWindow;
                    use cocoa::base::{id, nil};
                    let ns_window = window.ns_window().unwrap() as id;
                    unsafe {
                        // 1. Force light appearance
                        let appearance_name: id = msg_send![
                            class!(NSString),
                            stringWithUTF8String: "NSAppearanceNameAqua\0".as_ptr()
                        ];
                        let appearance: id = msg_send![
                            class!(NSAppearance),
                            appearanceNamed: appearance_name
                        ];
                        let _: () = msg_send![ns_window, setAppearance: appearance];

                        // 2. Set window background to white
                        let white = cocoa::appkit::NSColor::colorWithRed_green_blue_alpha_(
                            nil, 1.0, 1.0, 1.0, 1.0
                        );
                        ns_window.setBackgroundColor_(white);

                        // 3. Remove titlebar separator for cleaner look
                        let _: () = msg_send![ns_window, setTitlebarSeparatorStyle: 0i64];
                    }
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Opened { urls } = event {
                use tauri::{Manager, Emitter};
                for url in &urls {
                    if let Ok(path) = url.to_file_path() {
                        let path_str = path.to_string_lossy().to_string();
                        log(&format!("macOS opened file: {}", path_str));
                        // Store for frontend to poll
                        if let Some(state) = app_handle.try_state::<OpenedFile>() {
                            if let Ok(mut stored) = state.0.lock() {
                                *stored = Some(path_str.clone());
                            }
                        }
                        // Also emit in case frontend is already loaded
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.emit("file-opened", &path_str);
                        }
                    }
                }
            }
        });
}
