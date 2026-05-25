use tauri::{App, AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, Wry};

const BUBBLE_SIZE: i32 = 60;
const MARGIN: i32 = 80;

pub fn setup_windows(app: &App) {
    let bubble = app.get_webview_window("bubble").unwrap();

    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();

        // 拦截关闭事件：点 X 只隐藏，不销毁窗口
        let main_clone = main.clone();
        main.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = main_clone.hide();
            }
        });
    }

    let _ = bubble.set_ignore_cursor_events(false);

    // 开发时打开 bubble 的 DevTools 方便调试
    #[cfg(debug_assertions)]
    bubble.open_devtools();

    #[cfg(target_os = "macos")]
    {
        set_window_level(&bubble, 25);
    }

    let app_handle = app.handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(800));
        position_bubble_window(&app_handle);
    });
}

fn get_monitor_for_window(app_handle: &AppHandle, label: &str) -> Option<(PhysicalPosition<i32>, PhysicalSize<u32>)> {
    let window = app_handle.get_webview_window(label)?;
    let monitor = window.primary_monitor().ok().flatten()
        .or_else(|| window.current_monitor().ok().flatten())?;
    Some((*monitor.position(), *monitor.size()))
}

pub fn position_bubble_window(app_handle: &AppHandle) {
    if let Some(bubble) = app_handle.get_webview_window("bubble") {
        if let Some((pos, size)) = get_monitor_for_window(app_handle, "bubble") {
            let x = pos.x + size.width as i32 - BUBBLE_SIZE - MARGIN;
            let y = pos.y + size.height as i32 - BUBBLE_SIZE - MARGIN;

            eprintln!("[window] positioning bubble at ({}, {}) on monitor {}x{}",
                x, y, size.width, size.height);

            let _ = bubble.set_position(PhysicalPosition::new(x, y));
            let _ = bubble.show();
            let _ = bubble.set_focus();
        } else {
            let x = 1920 - BUBBLE_SIZE - MARGIN;
            let y = 1080 - BUBBLE_SIZE - MARGIN;
            let _ = bubble.set_position(PhysicalPosition::new(x, y));
            let _ = bubble.show();
            let _ = bubble.set_focus();
        }
    }
}

#[cfg(target_os = "macos")]
fn set_window_level(window: &WebviewWindow<Wry>, level: isize) {
    use objc2::msg_send;
    use objc2_foundation::NSObject;

    if let Ok(ns_window) = window.ns_window() {
        unsafe {
            let _: () = msg_send![ns_window as *mut NSObject, setLevel: level];
        }
    }
}
