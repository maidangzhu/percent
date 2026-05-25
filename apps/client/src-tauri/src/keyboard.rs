use device_query::{DeviceQuery, DeviceState, Keycode};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
use chrono::Local;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::frontapp::{get_frontmost_app, is_send_action};
use crate::screenshotter::capture_screen_without_bubble;
use crate::AppState;

const WECHAT_BUNDLE_ID: &str = "com.tencent.xinWeChat";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ShortcutConfig {
    pub key: String,
    pub modifiers: Vec<String>,
}

impl Default for ShortcutConfig {
    fn default() -> Self {
        Self {
            key: "Enter".to_string(),
            modifiers: Vec::new(),
        }
    }
}

impl ShortcutConfig {
    pub fn validate(&self) -> Result<(), String> {
        if keycode_from_name(&self.key).is_none() {
            return Err(format!("Unsupported shortcut key: {}", self.key));
        }
        for modifier in &self.modifiers {
            if !matches!(modifier.as_str(), "Command" | "Control" | "Shift" | "Alt") {
                return Err(format!("Unsupported shortcut modifier: {}", modifier));
            }
        }
        Ok(())
    }

    pub fn label(&self) -> String {
        let mut parts = self.modifiers.clone();
        parts.push(self.key.clone());
        parts.join("+")
    }
}

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
            let shortcut = app_handle
                .state::<AppState>()
                .shortcut
                .read()
                .map(|shortcut| shortcut.clone())
                .unwrap_or_default();
            let is_pressed = shortcut_matches(&keys, &shortcut);
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

fn shortcut_matches(keys: &[Keycode], shortcut: &ShortcutConfig) -> bool {
    let Some(main_key) = keycode_from_name(&shortcut.key) else {
        return false;
    };
    if !keys.contains(&main_key) {
        return false;
    }

    shortcut.modifiers.iter().all(|modifier| match modifier.as_str() {
        "Command" => keys.contains(&Keycode::Command) || keys.contains(&Keycode::LMeta) || keys.contains(&Keycode::RMeta),
        "Control" => keys.contains(&Keycode::LControl) || keys.contains(&Keycode::RControl),
        "Shift" => keys.contains(&Keycode::LShift) || keys.contains(&Keycode::RShift),
        "Alt" => keys.contains(&Keycode::LAlt) || keys.contains(&Keycode::RAlt) || keys.contains(&Keycode::LOption) || keys.contains(&Keycode::ROption),
        _ => false,
    })
}

fn keycode_from_name(name: &str) -> Option<Keycode> {
    match name {
        "Enter" => Some(Keycode::Enter),
        "NumpadEnter" => Some(Keycode::NumpadEnter),
        "Space" => Some(Keycode::Space),
        "Tab" => Some(Keycode::Tab),
        "Escape" => Some(Keycode::Escape),
        "Backspace" => Some(Keycode::Backspace),
        "Delete" => Some(Keycode::Delete),
        "Up" => Some(Keycode::Up),
        "Down" => Some(Keycode::Down),
        "Left" => Some(Keycode::Left),
        "Right" => Some(Keycode::Right),
        "A" => Some(Keycode::A),
        "B" => Some(Keycode::B),
        "C" => Some(Keycode::C),
        "D" => Some(Keycode::D),
        "E" => Some(Keycode::E),
        "F" => Some(Keycode::F),
        "G" => Some(Keycode::G),
        "H" => Some(Keycode::H),
        "I" => Some(Keycode::I),
        "J" => Some(Keycode::J),
        "K" => Some(Keycode::K),
        "L" => Some(Keycode::L),
        "M" => Some(Keycode::M),
        "N" => Some(Keycode::N),
        "O" => Some(Keycode::O),
        "P" => Some(Keycode::P),
        "Q" => Some(Keycode::Q),
        "R" => Some(Keycode::R),
        "S" => Some(Keycode::S),
        "T" => Some(Keycode::T),
        "U" => Some(Keycode::U),
        "V" => Some(Keycode::V),
        "W" => Some(Keycode::W),
        "X" => Some(Keycode::X),
        "Y" => Some(Keycode::Y),
        "Z" => Some(Keycode::Z),
        "Key0" => Some(Keycode::Key0),
        "Key1" => Some(Keycode::Key1),
        "Key2" => Some(Keycode::Key2),
        "Key3" => Some(Keycode::Key3),
        "Key4" => Some(Keycode::Key4),
        "Key5" => Some(Keycode::Key5),
        "Key6" => Some(Keycode::Key6),
        "Key7" => Some(Keycode::Key7),
        "Key8" => Some(Keycode::Key8),
        "Key9" => Some(Keycode::Key9),
        "F1" => Some(Keycode::F1),
        "F2" => Some(Keycode::F2),
        "F3" => Some(Keycode::F3),
        "F4" => Some(Keycode::F4),
        "F5" => Some(Keycode::F5),
        "F6" => Some(Keycode::F6),
        "F7" => Some(Keycode::F7),
        "F8" => Some(Keycode::F8),
        "F9" => Some(Keycode::F9),
        "F10" => Some(Keycode::F10),
        "F11" => Some(Keycode::F11),
        "F12" => Some(Keycode::F12),
        _ => None,
    }
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
            let screenshot_path = capture_screen_without_bubble(&app_handle_clone, &log_dir)
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
