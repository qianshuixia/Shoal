// Desktop shell for Shoal: a webview window on the local server (WebView2 on Windows, WKWebView on macOS), plus tray and
// single instance. The installer carries the whole server (resources/app: a pinned Node runtime, server/, web/dist,
// node_modules), so it needs nothing else on the machine except the agent CLIs. Quitting the shell stops the server
// along with the agents; if the shell crashes or is killed, the server and agents keep running.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::fs::File;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
#[cfg(target_os = "macos")]
use tauri::menu::Submenu;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, Url, UserAttentionType, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

// The bundled runtime under resources/app.
#[cfg(windows)]
const NODE_BIN: &str = "node.exe";
#[cfg(not(windows))]
const NODE_BIN: &str = "node";
// Where the splash page (frontendDist) is served from: Tauri's custom protocol differs per platform.
#[cfg(windows)]
const SPLASH_URL: &str = "http://tauri.localhost/index.html";
#[cfg(not(windows))]
const SPLASH_URL: &str = "tauri://localhost/index.html";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
#[cfg(windows)]
const SYNCHRONIZE: u32 = 0x0010_0000;
#[cfg(windows)]
const WAIT_OBJECT_0: u32 = 0;
#[cfg(windows)]
const ERROR_ACCESS_DENIED: u32 = 5;

#[cfg(windows)]
extern "system" {
    fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> *mut std::ffi::c_void;
    fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    fn GetLastError() -> u32;
}

#[cfg(unix)]
extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}
#[cfg(unix)]
const SIGTERM: i32 = 15;
#[cfg(unix)]
const SIGKILL: i32 = 9;
#[cfg(unix)]
const ESRCH: i32 = 3;

// The server process this shell started. On Unix a child that has exited stays a zombie (and still answers
// kill(pid, 0)) until it is waited for, so exits of our own child are read through this handle. It is only reaped under
// this lock, and `status` records that: while it is None the child's PID (and so its process group ID) is still ours.
struct OwnServer {
    child: Child,
    status: Option<std::process::ExitStatus>,
}
static SERVER_CHILD: Mutex<Option<OwnServer>> = Mutex::new(None);
// Servers replaced by a restart while still running (one that closed its port and is still winding down): kept until
// they exit so they are reaped rather than left as zombies. Never signalled.
static RETIRED: Mutex<Vec<Child>> = Mutex::new(Vec::new());
// Serializes "spawn the server and record it" (start_server) with "stop it before exiting" (stop_server_for_exit), so
// an exit never misses a server started a moment earlier and nothing is started once the stop has begun.
static LIFECYCLE: Mutex<()> = Mutex::new(());
// Set (under LIFECYCLE) when the final stop begins; the app exits after it, so it is never cleared.
static STOPPING: AtomicBool = AtomicBool::new(false);

fn lifecycle() -> std::sync::MutexGuard<'static, ()> {
    LIFECYCLE.lock().unwrap_or_else(|e| e.into_inner())
}

fn server_child() -> std::sync::MutexGuard<'static, Option<OwnServer>> {
    SERVER_CHILD.lock().unwrap_or_else(|e| e.into_inner())
}

impl OwnServer {
    // Reaps the child once it has exited and remembers its status.
    fn poll(&mut self) -> Option<std::process::ExitStatus> {
        if self.status.is_none() {
            self.status = self.child.try_wait().ok().flatten();
        }
        self.status
    }
}

fn retired() -> std::sync::MutexGuard<'static, Vec<Child>> {
    RETIRED.lock().unwrap_or_else(|e| e.into_inner())
}

// Reaps retired servers that have exited since the last call.
fn reap_retired() {
    retired().retain_mut(|c| matches!(c.try_wait(), Ok(None)));
}

// Exit status of our server child `pid` once it has exited; None while it runs or when `pid` is not our child.
fn own_child_status(pid: u32) -> Option<std::process::ExitStatus> {
    server_child().as_mut().filter(|c| c.child.id() == pid)?.poll()
}

#[cfg(unix)]
fn pid_gone(pid: u32) -> bool {
    if let Some(own) = server_child().as_mut().filter(|c| c.child.id() == pid) {
        return own.poll().is_some();
    }
    let Ok(p) = i32::try_from(pid) else { return true };
    // EPERM means it exists under another user: still running, like ERROR_ACCESS_DENIED on Windows.
    let failed = unsafe { kill(p, 0) } != 0;
    failed && std::io::Error::last_os_error().raw_os_error() == Some(ESRCH)
}

#[cfg(unix)]
fn wait_for_pid_exit(pid: u32, timeout: Duration) -> bool {
    if pid == 0 {
        return true;
    }
    let deadline = Instant::now() + timeout;
    loop {
        if pid_gone(pid) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

// The server leads its own process group (start_server), so signalling the group reaches the Node helpers it started.
// Agent PTYs run in sessions of their own and get SIGHUP when the server's end of their terminal closes. SIGTERM first
// gives the server a moment to stop its sessions itself.
//
// Only the server this shell started and has not reaped yet is signalled: under the SERVER_CHILD lock its PID, running
// or a zombie, cannot be reused, so neither can the group ID it leads. Once reaped it is gone and gets nothing. A server
// we did not start (one run from a terminal, known only from the PID /api/shutdown reported) is never signalled on
// Unix: that PID carries no identity, so such a server only gets the HTTP shutdown.
#[cfg(unix)]
fn kill_pid_tree(pid: u32) {
    let Ok(p) = i32::try_from(pid) else { return };
    if p <= 0 {
        return;
    }
    let signal = |sig: i32| -> bool {
        let guard = server_child();
        if !guard.as_ref().is_some_and(|c| c.child.id() == pid && c.status.is_none()) {
            return false;
        }
        unsafe {
            if kill(-p, sig) != 0 {
                kill(p, sig);
            }
        }
        true
    };
    if !signal(SIGTERM) || wait_for_pid_exit(pid, Duration::from_secs(3)) {
        return;
    }
    if signal(SIGKILL) {
        let _ = wait_for_pid_exit(pid, Duration::from_secs(5));
    }
}

#[cfg(windows)]
fn wait_for_pid_exit(pid: u32, timeout: Duration) -> bool {
    if pid == 0 {
        return true;
    }
    let handle = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        return unsafe { GetLastError() } != ERROR_ACCESS_DENIED;
    }
    let ms = timeout.as_millis().min(u128::from(u32::MAX - 1)) as u32;
    let res = unsafe { WaitForSingleObject(handle, ms) };
    unsafe {
        CloseHandle(handle);
    }
    res == WAIT_OBJECT_0
}

#[cfg(windows)]
fn kill_pid_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    let _ = Command::new("taskkill.exe")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = wait_for_pid_exit(pid, Duration::from_secs(5));
}

static CONNECTING: AtomicBool = AtomicBool::new(false);
static QUITTING: AtomicBool = AtomicBool::new(false);
static WATCHDOG_ARMED: AtomicBool = AtomicBool::new(false);
// PID of the server this shell started (0: none, or it was already running).
static SERVER_PID: AtomicU32 = AtomicU32::new(0);
// Sessions waiting for the user, as the page last put it in its title ("(3) Shoal").
static WAITING: AtomicU32 = AtomicU32::new(0);

fn port() -> u16 {
    std::env::var("WORKBENCH_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(47800)
}

fn server_url() -> Url {
    Url::parse(&format!("http://127.0.0.1:{}/", port())).expect("valid server url")
}

// Same rule as defaultStateDir in server/platform.ts: WORKBENCH_STATE_DIR; else on Windows
// %LOCALAPPDATA%\agent-workbench while an install from before the rename left one and %LOCALAPPDATA%\Shoal has no
// state.json yet, else %LOCALAPPDATA%\Shoal (the Shoal folder alone says nothing: the installer puts the app itself
// there); on macOS ~/Library/Application Support/Shoal. start_server passes the result on, so both sides use one folder.
fn state_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("WORKBENCH_STATE_DIR") {
        return PathBuf::from(dir);
    }
    default_state_dir()
}

#[cfg(target_os = "macos")]
fn default_state_dir() -> PathBuf {
    home_dir().join("Library").join("Application Support").join("Shoal")
}

#[cfg(all(unix, not(target_os = "macos")))]
fn default_state_dir() -> PathBuf {
    match std::env::var_os("XDG_DATA_HOME").filter(|d| !d.is_empty()) {
        Some(dir) => PathBuf::from(dir).join("Shoal"),
        None => home_dir().join(".local").join("share").join("Shoal"),
    }
}

#[cfg(unix)]
fn home_dir() -> PathBuf {
    std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(windows)]
fn default_state_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    let (dir, old) = (base.join("Shoal"), base.join("agent-workbench"));
    if !dir.join("state.json").is_file() && old.is_dir() { old } else { dir }
}

// Minimal HTTP/1.0 client for the local server: 1.0 keeps Node from chunking the body. No Origin header, so the
// server's Origin check lets it through.
fn request(port: u16, method: &str, path: &str) -> Option<(u16, String)> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    let body = if method == "POST" { "{}" } else { "" };
    let req = format!(
        "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(req.as_bytes()).ok()?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).ok()?;
    let raw = String::from_utf8_lossy(&raw);
    let status = raw.split(' ').nth(1)?.parse().ok()?;
    Some((status, raw.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default()))
}

fn server_ready(port: u16) -> bool {
    matches!(request(port, "GET", "/api/state"), Some((200, _)))
}

// Agent sessions still running; None when the server is not reachable.
fn live_sessions(port: u16) -> Option<usize> {
    let (status, body) = request(port, "GET", "/api/state")?;
    if status != 200 {
        return None;
    }
    let state: serde_json::Value = serde_json::from_str(&body).ok()?;
    let sessions = state.get("sessions")?.as_array()?;
    Some(sessions.iter().filter(|s| s.get("status").and_then(|v| v.as_str()) != Some("exited")).count())
}

fn port_taken(port: u16) -> bool {
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(300)).is_ok()
}

fn tail(path: &PathBuf, lines: usize) -> String {
    let text = std::fs::read(path).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    let all: Vec<&str> = text.trim_end().lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

// Starts resources/app/server/main.ts on the bundled Node, detached from the shell: own process group (and a hidden
// console on Windows), so agents keep running if the shell dies. Waits until the server answers.
fn start_server(app: &AppHandle, port: u16) -> Result<(), String> {
    if port_taken(port) {
        return Err(format!("端口 {port} 被其他程序占用。\n可以用环境变量 WORKBENCH_PORT 换一个端口后再启动 Shoal。"));
    }
    let res = app.path().resource_dir().map_err(|e| format!("找不到安装目录：{e}"))?;
    let dir = PathBuf::from(res.to_string_lossy().trim_start_matches(r"\\?\")).join("app");
    let node = dir.join(NODE_BIN);
    if !node.is_file() {
        return Err(format!("安装不完整，缺少 {}。\n请重新安装 Shoal。", node.display()));
    }
    let state = state_dir();
    std::fs::create_dir_all(&state).map_err(|e| format!("无法创建 {}：{e}", state.display()))?;
    let (out_path, err_path) = (state.join("server.log"), state.join("server.err.log"));
    // Keep the previous run's logs: after a crash they hold the reason. Best-effort on Windows in case an antivirus or
    // dying child handle still holds the old file for a moment.
    for (cur, prev) in [(&out_path, "server.prev.log"), (&err_path, "server.err.prev.log")] {
        if cur.is_file() {
            let _ = std::fs::rename(cur, state.join(prev));
        }
    }
    let open_log = |primary: &PathBuf, fallback_name: &str| -> Result<File, String> {
        File::create(primary)
            .or_else(|_| File::create(state.join(fallback_name)))
            .map_err(|e| format!("无法写入 {}：{e}", primary.display()))
    };
    let out = open_log(&out_path, "server.restart.log")?;
    let err = open_log(&err_path, "server.err.restart.log")?;
    let mut cmd = Command::new(&node);
    cmd.args(["server/main.ts", "--port", &port.to_string()])
        .current_dir(&dir)
        // Only the bundled runtime decides how the server runs: no inherited Node flags, preloads or module paths.
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env("WORKBENCH_BUNDLED", "1")
        // The server must use the folder this shell reads its logs from.
        .env("WORKBENCH_STATE_DIR", &state)
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    // Own process group: signals meant for the shell's group (Ctrl+C in a terminal that started it) skip the server.
    #[cfg(unix)]
    cmd.process_group(0);
    let pid = {
        let _lifecycle = lifecycle();
        if STOPPING.load(Ordering::SeqCst) {
            return Err("Shoal 正在退出。".into());
        }
        let child = cmd.spawn().map_err(|e| format!("无法启动 {}：{e}", node.display()))?;
        let pid = child.id();
        SERVER_PID.store(pid, Ordering::SeqCst);
        // Replacing the handle of a server the watchdog restarts: reap it if it has exited, otherwise keep its handle
        // until it does, so it never stays behind as a zombie.
        if let Some(mut old) = server_child().replace(OwnServer { child, status: None }) {
            if old.poll().is_none() {
                retired().push(old.child);
            }
        }
        pid
    };
    let deadline = Instant::now() + Duration::from_secs(30);
    while !server_ready(port) {
        if let Some(status) = own_child_status(pid) {
            SERVER_PID.store(0, Ordering::SeqCst);
            return Err(format!("服务启动失败（{status}），日志：{}\n\n{}", err_path.display(), tail(&err_path, 20)));
        }
        if Instant::now() > deadline {
            kill_pid_tree(pid);
            SERVER_PID.store(0, Ordering::SeqCst);
            return Err(format!("30 秒内服务没有就绪，日志：{}", out_path.display()));
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    Ok(())
}

// Same path as Ctrl+C on the server: it waits for freshly started claude sessions before killing them. If it does
// not stop in time and this shell started it (or /api/shutdown reported its pid), end its process tree.
fn stop_server(port: u16, has_live_sessions: bool) {
    let mut pid = SERVER_PID.load(Ordering::SeqCst);
    let grace = if has_live_sessions { Duration::from_secs(12) } else { Duration::from_secs(5) };
    if let Some((202, body)) = request(port, "POST", "/api/shutdown") {
        if let Some(p) = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("pid").and_then(|x| x.as_u64()))
            .and_then(|x| u32::try_from(x).ok())
            .filter(|&x| x != 0)
        {
            pid = p;
        }
        if pid != 0 {
            if wait_for_pid_exit(pid, grace) {
                SERVER_PID.store(0, Ordering::SeqCst);
                return;
            }
        } else {
            let deadline = Instant::now() + grace;
            while port_taken(port) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(200));
            }
            if !port_taken(port) {
                return;
            }
        }
    }
    if pid != 0 {
        kill_pid_tree(pid);
        SERVER_PID.store(0, Ordering::SeqCst);
    }
}

// Window close and the tray's 退出 both end here: confirm if agents are running, stop the server, exit.
fn quit(app: &AppHandle) {
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let port = port();
        let live = live_sessions(port);
        if let Some(n) = live.filter(|&n| n > 0) {
            show(&app);
            let mut dialog = app
                .dialog()
                .message(format!("还有 {n} 个 agent 会话在运行，退出会结束它们（之后可以在面板里续接）。"))
                .title("退出 Shoal")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom("全部退出".into(), "取消".into()));
            if let Some(w) = app.get_webview_window("main") {
                dialog = dialog.parent(&w);
            }
            let ok = dialog.blocking_show();
            if !ok {
                QUITTING.store(false, Ordering::SeqCst);
                return;
            }
        }
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.hide();
        }
        stop_server_for_exit(port, live);
        app.exit(0);
    });
}

// `live`: what live_sessions(port) returned just before. Runs at most once; a second caller (macOS: RunEvent::Exit
// while quit() is still stopping the server) waits for the first to finish and returns.
fn stop_server_for_exit(port: u16, live: Option<usize>) {
    let _lifecycle = lifecycle();
    if STOPPING.swap(true, Ordering::SeqCst) {
        return;
    }
    if live.is_some() || SERVER_PID.load(Ordering::SeqCst) != 0 {
        stop_server(port, live.unwrap_or(0) > 0);
    }
}

fn call(w: &WebviewWindow, func: &str, text: &str) {
    let _ = w.eval(format!("window.{func}({})", serde_json::Value::from(text)));
}

// Runs once the splash page has loaded: start the server if needed, then switch the window over to it.
fn connect(w: WebviewWindow) {
    if CONNECTING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let port = port();
        let result = if server_ready(port) {
            Ok(())
        } else {
            call(&w, "setStatus", "正在启动工作台服务…");
            start_server(w.app_handle(), port)
        };
        match result {
            Ok(()) => {
                WATCHDOG_ARMED.store(true, Ordering::SeqCst);
                if let Err(e) = w.navigate(server_url()) {
                    call(&w, "setError", &format!("打开工作台失败：{e}"));
                }
            }
            Err(e) => call(&w, "setError", &e),
        }
        CONNECTING.store(false, Ordering::SeqCst);
    });
}

// Restarts the bundled server automatically if it dies unexpectedly while the desktop shell is still open.
// Once restarted, the page's WebSocket reconnect loop picks up the new server and shows the one-click resume banner.
fn spawn_watchdog(app: AppHandle) {
    std::thread::spawn(move || {
        let port = port();
        let mut missed: u32 = 0;
        let mut failures: u32 = 0;
        loop {
            std::thread::sleep(Duration::from_secs(3));
            reap_retired();
            if STOPPING.load(Ordering::SeqCst) {
                break;
            }
            // A quit waiting for its confirmation may still be cancelled: skip this round, keep watching.
            if QUITTING.load(Ordering::SeqCst) {
                missed = 0;
                continue;
            }
            if !WATCHDOG_ARMED.load(Ordering::SeqCst) || CONNECTING.load(Ordering::SeqCst) {
                missed = 0;
                continue;
            }
            if port_taken(port) {
                missed = 0;
                failures = 0;
                continue;
            }
            missed += 1;
            if missed < 2 || failures >= 3 {
                continue;
            }
            if CONNECTING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
                continue;
            }
            let ok = if !QUITTING.load(Ordering::SeqCst) && !port_taken(port) {
                start_server(&app, port).is_ok()
            } else {
                true
            };
            CONNECTING.store(false, Ordering::SeqCst);
            missed = 0;
            if ok {
                failures = 0;
            } else {
                failures += 1;
                std::thread::sleep(Duration::from_secs(5 * u64::from(failures)));
            }
        }
    });
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn splash_url() -> Url {
    Url::parse(SPLASH_URL).expect("valid splash url")
}

#[cfg(windows)]
fn is_splash(url: &Url) -> bool {
    url.host_str() == splash_url().host_str()
}

#[cfg(not(windows))]
fn is_splash(url: &Url) -> bool {
    let splash = splash_url();
    url.scheme() == splash.scheme() && url.host_str() == splash.host_str()
}

fn is_internal(url: &Url) -> bool {
    if is_splash(url) {
        return true;
    }
    match url.host_str() {
        Some("127.0.0.1") => url.port() == Some(port()),
        _ => url.scheme() == "about",
    }
}

fn open_external(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

// "(3) Shoal" -> 3; anything else -> 0.
fn waiting_count(title: &str) -> u32 {
    title.strip_prefix('(').and_then(|t| t.split_once(')')).and_then(|(n, _)| n.parse().ok()).unwrap_or(0)
}

fn create_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let nav_app = app.clone();
    let popup_app = app.clone();
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()));
    // For the shell's e2e: expose CDP. Tauri passes its own browser args, so WebView2 ignores
    // WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS; repeat Tauri's defaults when overriding them.
    #[cfg(windows)]
    if let Ok(p) = std::env::var("WORKBENCH_DEVTOOLS_PORT") {
        builder = builder.additional_browser_args(&format!(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={p}"
        ));
    }
    let w = builder
        .title("Shoal")
        // The page is dark only; a light system title bar on top of it was the brightest thing on screen.
        .theme(Some(tauri::Theme::Dark))
        .inner_size(1440.0, 900.0)
        .min_inner_size(800.0, 500.0)
        .visible(false)
        // Let drops reach the page: it saves dragged-in images and pastes their paths into the terminal.
        .disable_drag_drop_handler()
        // Web links in the terminal (window.open) go to the default browser instead of a bare popup.
        .on_new_window(move |url, _| {
            open_external(&popup_app, &url);
            NewWindowResponse::Deny
        })
        .on_navigation(move |url| {
            let ok = is_internal(url);
            if !ok {
                open_external(&nav_app, url);
            }
            ok
        })
        // The page puts the number of sessions waiting for the user in its title; mirror it on the window and flash the
        // taskbar button when it goes up while the window is in the background (Windows stops the flash on focus).
        .on_document_title_changed(|w, title| {
            let _ = w.set_title(&title);
            let n = waiting_count(&title);
            let before = WAITING.swap(n, Ordering::SeqCst);
            if n > before && !w.is_focused().unwrap_or(true) {
                let _ = w.request_user_attention(Some(UserAttentionType::Informational));
            }
        })
        .on_page_load(|w, payload| {
            if payload.event() == PageLoadEvent::Finished && is_splash(payload.url()) {
                connect(w.clone());
            }
        })
        .build()?;

    // Hand Ctrl+F, Ctrl+P, Ctrl+R, F5 and the like to the page (and the terminal) instead of WebView2. WKWebView has no
    // such shortcuts of its own; on macOS only the app menu (create_app_menu) claims keys.
    #[cfg(windows)]
    w.with_webview(|pw| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
        use windows_core::Interface;
        if let Ok(settings) = pw.controller().CoreWebView2().and_then(|c| c.Settings()) {
            if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
            }
        }
    })?;

    let quit_app = app.clone();
    w.on_window_event(move |e| {
        if let WindowEvent::CloseRequested { api, .. } = e {
            api.prevent_close();
            on_close_requested(&quit_app);
        }
    });
    w.show()?;
    Ok(w)
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "show", "显示工作台", true, None::<&str>)?,
            &MenuItem::with_id(app, "browser", "在浏览器中打开", true, None::<&str>)?,
            &MenuItem::with_id(app, "reload", "重新加载", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?,
        ],
    )?;
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().expect("bundled icon").clone())
        .tooltip("Shoal")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show(app),
            "browser" => open_external(app, &server_url()),
            "reload" => {
                if let Some(w) = app.get_webview_window("main") {
                    WATCHDOG_ARMED.store(false, Ordering::SeqCst);
                    // Back to the splash page, which reconnects (and restarts the server if it has stopped).
                    let _ = w.navigate(splash_url());
                    show(app);
                }
            }
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

// Windows: closing the window quits (the tray icon keeps the workbench reachable only while it runs).
#[cfg(not(target_os = "macos"))]
fn on_close_requested(app: &AppHandle) {
    quit(app);
}

// macOS: closing the window only hides it, as Mac apps do; the Dock icon brings it back (RunEvent::Reopen) and
// Cmd+Q, the menu bar icon's 退出 or the Dock's Quit end the app.
#[cfg(target_os = "macos")]
fn on_close_requested(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

#[cfg(target_os = "macos")]
const MENU_QUIT: &str = "app-quit";

// Tauri's default macOS menu, except Quit: the predefined item sends terminate: and the process ends at once, skipping
// the confirmation for running agents. Without the Edit menu, Cmd+C / Cmd+V would not reach the webview.
#[cfg(target_os = "macos")]
fn create_app_menu(app: &AppHandle) -> tauri::Result<()> {
    let app_menu = Submenu::with_items(
        app,
        "Shoal",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("关于 Shoal"), None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some("服务"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some("隐藏 Shoal"))?,
            &PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?,
            &PredefinedMenuItem::show_all(app, Some("全部显示"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, MENU_QUIT, "退出 Shoal", true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("撤销"))?,
            &PredefinedMenuItem::redo(app, Some("重做"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("剪切"))?,
            &PredefinedMenuItem::copy(app, Some("拷贝"))?,
            &PredefinedMenuItem::paste(app, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(app, Some("全选"))?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("最小化"))?,
            &PredefinedMenuItem::maximize(app, Some("缩放"))?,
            &PredefinedMenuItem::fullscreen(app, Some("切换全屏幕"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some("关闭窗口"))?,
        ],
    )?;
    app.set_menu(Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])?)?;
    app.on_menu_event(|app, event| {
        if event.id().as_ref() == MENU_QUIT {
            quit(app);
        }
    });
    Ok(())
}

#[cfg(target_os = "macos")]
fn on_run_event(app: &AppHandle, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::Reopen { .. } => show(app),
        // Every exit ends here, also one that did not come through quit() or came while its confirmation was still open
        // (the Dock's Quit, logging out): Tauri cannot cancel it, so stop the server, without asking, before the process
        // ends. While quit() is stopping it this waits for that stop; after it, it returns at once.
        tauri::RunEvent::Exit => {
            QUITTING.store(true, Ordering::SeqCst);
            let port = port();
            let live = if STOPPING.load(Ordering::SeqCst) { None } else { live_sessions(port) };
            stop_server_for_exit(port, live);
        }
        _ => {}
    }
}

#[cfg(not(target_os = "macos"))]
fn on_run_event(_app: &AppHandle, _event: tauri::RunEvent) {}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // The window is often hidden in the tray when the shell quits; always come back visible.
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .setup(|app| {
            #[cfg(target_os = "macos")]
            create_app_menu(app.handle())?;
            create_window(app.handle())?;
            create_tray(app.handle())?;
            spawn_watchdog(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Shoal")
        .run(on_run_event);
}
