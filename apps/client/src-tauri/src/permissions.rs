use serde::Serialize;
use std::process::Command;

#[derive(Clone, Serialize)]
pub struct PermissionStatus {
    pub id: String,
    pub name: String,
    pub description: String,
    pub granted: bool,
    pub required: bool,
}

#[tauri::command]
pub fn get_required_permissions() -> Vec<PermissionStatus> {
    platform_permissions()
}

#[tauri::command]
pub fn open_permission_settings(permission_id: String) -> Result<(), String> {
    let url = match permission_id.as_str() {
        "screen_recording" => "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        "input_monitoring" => "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
        "accessibility" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        _ => return Err(format!("Unknown permission: {}", permission_id)),
    };

    Command::new("open")
        .arg(url)
        .status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn request_permission(permission_id: String) -> bool {
    match permission_id.as_str() {
        "screen_recording" => request_screen_recording(),
        "input_monitoring" => request_input_monitoring(),
        "accessibility" => request_accessibility(),
        _ => false,
    }
}

#[cfg(target_os = "macos")]
fn platform_permissions() -> Vec<PermissionStatus> {
    vec![
        PermissionStatus {
            id: "screen_recording".to_string(),
            name: "屏幕录制".to_string(),
            description: "用于截取当前聊天窗口并进行多模态分析。".to_string(),
            granted: has_screen_recording(),
            required: true,
        },
        PermissionStatus {
            id: "accessibility".to_string(),
            name: "辅助功能".to_string(),
            description: "用于识别当前前台应用和聊天客户端。".to_string(),
            granted: has_accessibility(),
            required: true,
        },
    ]
}

#[cfg(not(target_os = "macos"))]
fn platform_permissions() -> Vec<PermissionStatus> {
    Vec::new()
}

#[cfg(target_os = "macos")]
fn has_screen_recording() -> bool {
    core_graphics::access::ScreenCaptureAccess.preflight()
}

#[cfg(not(target_os = "macos"))]
fn has_screen_recording() -> bool {
    true
}

#[cfg(target_os = "macos")]
fn request_screen_recording() -> bool {
    core_graphics::access::ScreenCaptureAccess.request()
}

#[cfg(not(target_os = "macos"))]
fn request_screen_recording() -> bool {
    true
}

#[cfg(target_os = "macos")]
fn has_accessibility() -> bool {
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> std::os::raw::c_uchar;
    }

    unsafe { AXIsProcessTrusted() != 0 }
}

#[cfg(not(target_os = "macos"))]
fn has_accessibility() -> bool {
    true
}

#[cfg(target_os = "macos")]
fn request_accessibility() -> bool {
    let _ = open_permission_settings("accessibility".to_string()).is_ok();
    has_accessibility()
}

#[cfg(not(target_os = "macos"))]
fn request_accessibility() -> bool {
    true
}

#[cfg(target_os = "macos")]
fn request_input_monitoring() -> bool {
    unsafe { IOHIDRequestAccess(K_IOHID_REQUEST_TYPE_LISTEN_EVENT) }
}

#[cfg(not(target_os = "macos"))]
fn request_input_monitoring() -> bool {
    true
}

#[cfg(target_os = "macos")]
const K_IOHID_REQUEST_TYPE_LISTEN_EVENT: u32 = 1;
#[cfg(target_os = "macos")]
#[allow(dead_code)]
const K_IOHID_ACCESS_TYPE_GRANTED: u32 = 0;

#[cfg(target_os = "macos")]
#[link(name = "IOKit", kind = "framework")]
extern "C" {
    #[allow(dead_code)]
    fn IOHIDCheckAccess(request_type: u32) -> u32;
    fn IOHIDRequestAccess(request_type: u32) -> bool;
}
