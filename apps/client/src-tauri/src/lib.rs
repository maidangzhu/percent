use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, RwLock};
use chrono::Local;
use serde::Serialize;
use tauri::{Emitter, Manager, Wry};

mod keyboard;
mod logger;
mod frontapp;
mod window;
mod screenshotter;

use keyboard::{start_keyboard_listener, ShortcutConfig};
use logger::LogStore;
use screenshotter::capture_screen_without_bubble;
use window::{move_bubble_by_drag, set_bubble_hit_regions, setup_windows, BubbleHitRegions};

pub struct AppState {
    pub log_store: Mutex<LogStore>,
    pub screenshot_enabled: AtomicBool,
    pub log_dir: PathBuf,
    pub shortcut: RwLock<ShortcutConfig>,
}

impl Default for AppState {
    fn default() -> Self {
        let log_dir = persistent_dir();
        Self {
            log_store: Mutex::new(LogStore::default()),
            screenshot_enabled: AtomicBool::new(true),
            shortcut: RwLock::new(load_shortcut_config(&log_dir)),
            log_dir,
        }
    }
}

fn persistent_dir() -> PathBuf {
    std::env::var("PERCENT_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".percent-tracker")
        })
}

fn settings_file(log_dir: &PathBuf) -> PathBuf {
    log_dir.join("settings.json")
}

fn load_shortcut_config(log_dir: &PathBuf) -> ShortcutConfig {
    let path = settings_file(log_dir);
    std::fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<ShortcutConfig>(&content).ok())
        .unwrap_or_default()
}

fn save_shortcut_config(log_dir: &PathBuf, shortcut: &ShortcutConfig) -> Result<(), String> {
    std::fs::create_dir_all(log_dir).map_err(|e| e.to_string())?;
    let content = serde_json::to_string_pretty(shortcut).map_err(|e| e.to_string())?;
    std::fs::write(settings_file(log_dir), content).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_logs(state: tauri::State<AppState>) -> Vec<logger::LogEntry> {
    let store = state.log_store.lock().unwrap();
    store.get_all()
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle<Wry>) {
    if let Some(main) = app.get_webview_window("main") {
        // macOS: Accessory 应用需要先激活自身才能抢到前台
        #[cfg(target_os = "macos")]
        activate_app(&main);

        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

#[cfg(target_os = "macos")]
fn activate_app(window: &tauri::WebviewWindow) {
    use objc2::msg_send;
    use objc2_foundation::NSObject;

    if let Ok(ns_win) = window.ns_window() {
        unsafe {
            // [nsWindow makeKeyAndOrderFront:nil]
            let nil: *mut NSObject = std::ptr::null_mut();
            let _: () = msg_send![ns_win as *mut NSObject, makeKeyAndOrderFront: nil];

            // 换个思路：用 NSRunningApplication
            let running_app_cls: *mut NSObject = msg_send![
                class_ref("NSRunningApplication"),
                currentApplication
            ];
            let opts: u64 = 1 << 0; // NSApplicationActivateIgnoringOtherApps
            let _: bool = msg_send![running_app_cls, activateWithOptions: opts];
        }
    }
}

#[cfg(target_os = "macos")]
fn class_ref(name: &str) -> *mut objc2_foundation::NSObject {
    use std::ffi::CString;
    let cname = CString::new(name).unwrap();
    unsafe {
        let cls = objc2::ffi::objc_getClass(cname.as_ptr());
        cls as *mut objc2_foundation::NSObject
    }
}

#[tauri::command]
fn get_enter_count(state: tauri::State<AppState>) -> usize {
    let store = state.log_store.lock().unwrap();
    store.count()
}

#[tauri::command]
fn get_shortcut_config(state: tauri::State<AppState>) -> ShortcutConfig {
    state
        .shortcut
        .read()
        .map(|shortcut| shortcut.clone())
        .unwrap_or_default()
}

#[tauri::command]
fn set_shortcut_config(shortcut: ShortcutConfig, state: tauri::State<AppState>) -> Result<ShortcutConfig, String> {
    shortcut.validate()?;
    save_shortcut_config(&state.log_dir, &shortcut)?;
    if let Ok(mut current) = state.shortcut.write() {
        *current = shortcut.clone();
    }
    eprintln!("[settings] shortcut updated: {}", shortcut.label());
    Ok(shortcut)
}

#[tauri::command]
fn clear_local_cache(state: tauri::State<AppState>) -> Result<usize, String> {
    let mut removed = 0_usize;
    let screenshots_dir = state.log_dir.join("screenshots");
    if screenshots_dir.exists() {
        for entry in std::fs::read_dir(&screenshots_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.is_file() {
                std::fs::remove_file(&path).map_err(|e| e.to_string())?;
                removed += 1;
            }
        }
    }

    {
        let mut store = state.log_store.lock().unwrap();
        removed += store.clear_local_files().map_err(|e| e.to_string())?;
    }

    eprintln!("[settings] cleared local cache files: {}", removed);
    Ok(removed)
}

#[derive(Clone, Serialize)]
struct CaptureContext {
    occurred_at: String,
    app_name: String,
    app_bundle_id: String,
    is_send: bool,
    is_wechat: bool,
    screenshot_path: Option<String>,
}

#[tauri::command]
fn capture_current_context(
    app: tauri::AppHandle<Wry>,
    state: tauri::State<AppState>,
) -> CaptureContext {
    let front = frontapp::get_frontmost_app();
    let is_send = frontapp::is_send_action(&front);
    let is_wechat = front.bundle_id == "com.tencent.xinWeChat"
        || front.name.to_lowercase().contains("wechat")
        || front.name.contains("微信");
    let screenshot_path = capture_screen_without_bubble(&app, &state.log_dir)
        .map(|path| path.to_string_lossy().to_string());

    CaptureContext {
        occurred_at: Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string(),
        app_name: front.name,
        app_bundle_id: front.bundle_id,
        is_send,
        is_wechat,
        screenshot_path,
    }
}

#[tauri::command]
fn set_screenshot_enabled(enabled: bool, state: tauri::State<AppState>) {
    state.screenshot_enabled.store(enabled, Ordering::SeqCst);
    eprintln!("[screenshot] capture enabled: {}", enabled);
}

#[tauri::command]
fn get_screenshot_enabled(state: tauri::State<AppState>) -> bool {
    state.screenshot_enabled.load(Ordering::SeqCst)
}

/// 读取任意本地文件，返回 base64 字符串（供 bubble.tsx 读截图用）
#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(base64_encode(&buf))
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 { chunk[1] as usize } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as usize } else { 0 };
        out.push(CHARS[(b0 >> 2) & 0x3F] as char);
        out.push(CHARS[((b0 << 4) | (b1 >> 4)) & 0x3F] as char);
        out.push(if chunk.len() > 1 { CHARS[((b1 << 2) | (b2 >> 6)) & 0x3F] as char } else { '=' });
        out.push(if chunk.len() > 2 { CHARS[b2 & 0x3F] as char } else { '=' });
    }
    out
}

/// TS 层 AI 分析完成后回调，把结果写回 log store 并 emit 刷新事件
#[tauri::command]
fn report_ai_result(
    entry_id: usize,
    partner: String,
    topic: String,
    is_chat: bool,
    app: tauri::AppHandle<Wry>,
    state: tauri::State<AppState>,
) {
    let summary = if is_chat {
        format!("与{}聊天 | 主题：{}", partner, topic)
    } else {
        "非聊天场景".to_string()
    };

    eprintln!("[ai] entry #{} → {}", entry_id, summary);

    {
        let mut store = state.log_store.lock().unwrap();
        store.set_ai_result(entry_id, summary);
    }

    // 通知所有窗口刷新日志
    let _ = app.emit("ai-result-updated", entry_id);
}

#[tauri::command]
fn emit_tasks_updated(app: tauri::AppHandle<Wry>) {
    let _ = app.emit("tasks-updated", ());
}

#[tauri::command]
fn set_mock_task_preview(enabled: bool, app: tauri::AppHandle<Wry>) {
    let _ = app.emit("mock-task-preview", enabled);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 加载项目根目录的 .env 文件（开发时有效；打包后不依赖此文件）
    let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap_or(std::path::Path::new("."));
    let _ = dotenvy::from_path(project_root.join(".env"));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::default())
        .manage(BubbleHitRegions::default())
        .invoke_handler(tauri::generate_handler![
            get_logs,
            show_main_window,
            get_enter_count,
            get_shortcut_config,
            set_shortcut_config,
            clear_local_cache,
            capture_current_context,
            set_screenshot_enabled,
            get_screenshot_enabled,
            report_ai_result,
            emit_tasks_updated,
            set_mock_task_preview,
            move_bubble_by_drag,
            set_bubble_hit_regions,
            read_file_base64,
        ])
        .setup(|app| {
            // macOS: 不显示 Dock 图标
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            setup_windows(app);
            start_keyboard_listener(app.handle().clone());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
