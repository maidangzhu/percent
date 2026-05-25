use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager, Wry};

mod keyboard;
mod logger;
mod frontapp;
mod window;
mod screenshotter;

use keyboard::start_keyboard_listener;
use logger::LogStore;
use window::{set_bubble_hit_regions, setup_windows, BubbleHitRegions};

pub struct AppState {
    pub log_store: Mutex<LogStore>,
    pub screenshot_enabled: AtomicBool,
    pub log_dir: PathBuf,
}

impl Default for AppState {
    fn default() -> Self {
        let log_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("percent-tracker");
        Self {
            log_store: Mutex::new(LogStore::default()),
            screenshot_enabled: AtomicBool::new(true),
            log_dir,
        }
    }
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
        .manage(AppState::default())
        .manage(BubbleHitRegions::default())
        .invoke_handler(tauri::generate_handler![
            get_logs,
            show_main_window,
            get_enter_count,
            set_screenshot_enabled,
            get_screenshot_enabled,
            report_ai_result,
            emit_tasks_updated,
            set_mock_task_preview,
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
