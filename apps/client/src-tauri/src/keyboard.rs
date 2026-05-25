use device_query::{DeviceQuery, DeviceState, Keycode};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
use chrono::Local;
use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::frontapp::{get_frontmost_app, is_send_action};
use crate::screenshotter::capture_screen;
use crate::AppState;

const WECHAT_BUNDLE_ID: &str = "com.tencent.xinWeChat";

/// enter-pressed 事件的 payload
#[derive(Clone, Serialize)]
pub struct EnterEvent {
    pub entry_id: usize,
    pub occurred_at: String,
    pub app_name: String,
    pub app_bundle_id: String,
    pub is_send: bool,
    pub is_wechat: bool,
    /// 截图文件的绝对路径，仅在微信 & 截图开关开启时有值
    pub screenshot_path: Option<String>,
}

pub fn start_keyboard_listener(app_handle: tauri::AppHandle) {
    thread::spawn(move || {
        let device_state = DeviceState::new();
        let was_pressed = AtomicBool::new(false);

        loop {
            let keys = device_state.get_keys();
            let is_pressed = keys.contains(&Keycode::Enter);
            let was = was_pressed.load(Ordering::SeqCst);

            if is_pressed && !was {
                was_pressed.store(true, Ordering::SeqCst);
                handle_enter_pressed(&app_handle);
            } else if !is_pressed && was {
                was_pressed.store(false, Ordering::SeqCst);
            }

            thread::sleep(Duration::from_millis(20));
        }
    });
}

fn handle_enter_pressed(app_handle: &tauri::AppHandle) {
    let front = get_frontmost_app();
    let is_send = is_send_action(&front);
    let is_wechat = front.bundle_id == WECHAT_BUNDLE_ID
        || front.name.to_lowercase().contains("wechat")
        || front.name.contains("微信");

    let occurred_at = Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string();

    eprintln!(
        "[keyboard] Enter in '{}' ({}) → {} (wechat={})",
        front.name, front.bundle_id,
        if is_send { "SEND" } else { "NEWLINE" },
        is_wechat
    );

    // 写基础日志
    let state = app_handle.state::<AppState>();
    let entry_id = {
        let mut store = state.log_store.lock().unwrap();
        store.add_entry(front.name.clone(), front.bundle_id.clone(), is_send)
    };

    let screenshot_enabled = state.screenshot_enabled.load(Ordering::SeqCst);

    // 如果是微信 & 截图开关打开，先截图再 emit（截图很快，<200ms）
    // 否则直接 emit
    if is_wechat && screenshot_enabled {
        let log_dir = state.log_dir.clone();
        let app_handle_clone = app_handle.clone();
        let app_name = front.name.clone();
        let bundle_id = front.bundle_id.clone();

        thread::spawn(move || {
            let screenshot_path = capture_screen(&log_dir)
                .map(|p| p.to_string_lossy().to_string());

            eprintln!("[keyboard] screenshot: {:?}", screenshot_path);

            let event = EnterEvent {
                entry_id,
                occurred_at,
                app_name,
                app_bundle_id: bundle_id,
                is_send,
                is_wechat: true,
                screenshot_path,
            };

            let _ = app_handle_clone.emit("enter-pressed", &event);
            let count = {
                let state = app_handle_clone.state::<AppState>();
                let store = state.log_store.lock().unwrap();
                store.count()
            };
            let _ = app_handle_clone.emit("count-updated", count);
        });
    } else {
        let event = EnterEvent {
            entry_id,
            occurred_at,
            app_name: front.name.clone(),
            app_bundle_id: front.bundle_id.clone(),
            is_send,
            is_wechat,
            screenshot_path: None,
        };
        let _ = app_handle.emit("enter-pressed", &event);
        let count = {
            let store = state.log_store.lock().unwrap();
            store.count()
        };
        let _ = app_handle.emit("count-updated", count);
    }
}
