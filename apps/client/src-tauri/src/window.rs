use serde::{Deserialize, Serialize};
use std::sync::{Arc, RwLock};
use tauri::{App, AppHandle, Emitter, LogicalPosition, Manager, Position, WebviewWindow, Wry};

const BUBBLE_WIDTH: i32 = 760;
const BUBBLE_HEIGHT: i32 = 760;
const MARGIN: f64 = 28.0;
const BUBBLE_DIAMETER: f64 = 64.0;
const BUBBLE_RIGHT_OFFSET: f64 = 24.0;
const BUBBLE_BOTTOM_OFFSET: f64 = 24.0;
const HIT_TEST_INTERVAL_MS: u64 = 50;
const INITIAL_HIT_TEST_GRACE_TICKS: u32 = 40;

#[derive(Clone, Debug, Deserialize)]
pub struct BubbleHitRegion {
    pub name: Option<String>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Serialize)]
struct BubbleHoverPayload {
    name: String,
    hovering: bool,
}

#[derive(Clone, Default)]
pub struct BubbleHitRegions(pub Arc<RwLock<Vec<BubbleHitRegion>>>);

#[tauri::command]
pub fn set_bubble_hit_regions(
    regions: Vec<BubbleHitRegion>,
    state: tauri::State<BubbleHitRegions>,
) {
    if let Ok(mut current) = state.0.write() {
        *current = regions;
    }
}

#[tauri::command]
pub fn move_bubble_by_drag(delta_x: f64, delta_y: f64, app: AppHandle) {
    let Some(bubble) = app.get_webview_window("bubble") else {
        return;
    };
    let Ok(position) = bubble.outer_position() else {
        return;
    };
    let Ok(scale_factor) = bubble.scale_factor() else {
        return;
    };

    let current_x = position.x as f64 / scale_factor;
    let current_y = position.y as f64 / scale_factor;
    let target_x = current_x + delta_x;
    let target_y = current_y + delta_y;
    let (x, y) = clamp_bubble_window_position(&bubble, target_x, target_y)
        .unwrap_or((target_x, target_y));

    let _ = bubble.set_position(Position::Logical(LogicalPosition::new(x, y)));
}

pub fn setup_windows(app: &App) {
    let bubble = app.get_webview_window("bubble").unwrap();

    if let Some(main) = app.get_webview_window("main") {
        // 拦截关闭事件：点 X 只隐藏，不销毁窗口
        let main_clone = main.clone();
        main.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = main_clone.hide();
            }
        });

        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }

    let _ = bubble.set_ignore_cursor_events(false);
    start_bubble_hit_test_listener(app.handle().clone());

    #[cfg(target_os = "macos")]
    {
        set_window_level(&bubble, 25);
        configure_bubble_mouse_behavior(&bubble);
    }

    let app_handle = app.handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(800));
        position_bubble_window(&app_handle);
    });
}

fn start_bubble_hit_test_listener(app_handle: AppHandle) {
    std::thread::spawn(move || {
        let mut last_ignore = false;
        let mut empty_region_ticks = 0_u32;
        let mut last_hovered_region: Option<String> = None;

        loop {
            std::thread::sleep(std::time::Duration::from_millis(HIT_TEST_INTERVAL_MS));

            let Some(bubble) = app_handle.get_webview_window("bubble") else {
                continue;
            };
            let Some(state) = app_handle.try_state::<BubbleHitRegions>() else {
                continue;
            };
            let regions = state
                .0
                .read()
                .map(|regions| regions.clone())
                .unwrap_or_default();

            let mut hovered_region_name: Option<String> = None;
            let ignore = if regions.is_empty() {
                empty_region_ticks = empty_region_ticks.saturating_add(1);
                empty_region_ticks > INITIAL_HIT_TEST_GRACE_TICKS
            } else {
                empty_region_ticks = 0;
                let (Ok(window_position), Ok(cursor_position), Ok(scale_factor)) = (
                    bubble.outer_position(),
                    bubble.cursor_position(),
                    bubble.scale_factor(),
                ) else {
                    if !last_ignore {
                        let _ = bubble.set_ignore_cursor_events(true);
                        last_ignore = true;
                    }
                    continue;
                };

                !regions.iter().any(|region| {
                    let x_min = window_position.x as f64 + region.x * scale_factor;
                    let x_max = window_position.x as f64 + (region.x + region.width) * scale_factor;
                    let y_min = window_position.y as f64 + region.y * scale_factor;
                    let y_max = window_position.y as f64 + (region.y + region.height) * scale_factor;

                    let contains = cursor_position.x >= x_min
                        && cursor_position.x <= x_max
                        && cursor_position.y >= y_min
                        && cursor_position.y <= y_max;
                    if contains {
                        hovered_region_name = region.name.clone();
                    }
                    contains
                })
            };

            if hovered_region_name != last_hovered_region {
                if let Some(name) = last_hovered_region.take() {
                    let _ = bubble.emit(
                        "bubble-native-hover",
                        BubbleHoverPayload {
                            name,
                            hovering: false,
                        },
                    );
                }

                if let Some(name) = hovered_region_name.clone() {
                    let _ = bubble.emit(
                        "bubble-native-hover",
                        BubbleHoverPayload {
                            name,
                            hovering: true,
                        },
                    );
                }

                last_hovered_region = hovered_region_name;
            }

            if ignore != last_ignore {
                let _ = bubble.set_ignore_cursor_events(ignore);
                last_ignore = ignore;
            }
        }
    });
}

fn get_monitor_for_window(app_handle: &AppHandle, label: &str) -> Option<tauri::Monitor> {
    let window = app_handle.get_webview_window(label)?;
    let monitor = window.primary_monitor().ok().flatten()
        .or_else(|| window.current_monitor().ok().flatten())?;
    Some(monitor)
}

pub fn position_bubble_window(app_handle: &AppHandle) {
    position_bubble_window_with_size(
        app_handle,
        BUBBLE_WIDTH,
        BUBBLE_HEIGHT,
    );
}

fn position_bubble_window_with_size(app_handle: &AppHandle, width: i32, height: i32) {
    if let Some(bubble) = app_handle.get_webview_window("bubble") {
        if let Some(monitor) = get_monitor_for_window(app_handle, "bubble") {
            let scale_factor = monitor.scale_factor();
            let work_area = monitor.work_area();
            let work_area_size = work_area.size.to_logical::<f64>(scale_factor);
            let work_area_position = work_area.position.to_logical::<f64>(scale_factor);
            let x = work_area_position.x + work_area_size.width - f64::from(width) - MARGIN;
            let y = work_area_position.y + work_area_size.height - f64::from(height) - MARGIN;

            eprintln!("[window] positioning bubble at ({}, {}) on monitor {}x{}",
                x, y, work_area_size.width, work_area_size.height);

            let _ = bubble.set_position(Position::Logical(LogicalPosition::new(x, y)));
            let _ = bubble.show();
            let _ = bubble.set_focus();
        } else {
            let x = 1920.0 - f64::from(width) - MARGIN;
            let y = 1080.0 - f64::from(height) - MARGIN;
            let _ = bubble.set_position(Position::Logical(LogicalPosition::new(x, y)));
            let _ = bubble.show();
            let _ = bubble.set_focus();
        }
    }
}

fn clamp_bubble_window_position(window: &WebviewWindow<Wry>, x: f64, y: f64) -> Option<(f64, f64)> {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())?;
    let scale_factor = monitor.scale_factor();
    let work_area = monitor.work_area();
    let work_area_size = work_area.size.to_logical::<f64>(scale_factor);
    let work_area_position = work_area.position.to_logical::<f64>(scale_factor);

    let bubble_left_in_window = f64::from(BUBBLE_WIDTH) - BUBBLE_RIGHT_OFFSET - BUBBLE_DIAMETER;
    let bubble_top_in_window = f64::from(BUBBLE_HEIGHT) - BUBBLE_BOTTOM_OFFSET - BUBBLE_DIAMETER;

    let min_x = work_area_position.x + MARGIN - bubble_left_in_window;
    let max_x = work_area_position.x + work_area_size.width - MARGIN - bubble_left_in_window - BUBBLE_DIAMETER;
    let min_y = work_area_position.y + MARGIN - bubble_top_in_window;
    let max_y = work_area_position.y + work_area_size.height - MARGIN - bubble_top_in_window - BUBBLE_DIAMETER;

    Some((x.clamp(min_x, max_x), y.clamp(min_y, max_y)))
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

#[cfg(target_os = "macos")]
fn configure_bubble_mouse_behavior(window: &WebviewWindow<Wry>) {
    use objc2::msg_send;
    use objc2_foundation::NSObject;

    if let Ok(ns_window) = window.ns_window() {
        unsafe {
            let _: () = msg_send![ns_window as *mut NSObject, setAcceptsMouseMovedEvents: true];
        }
    }
}
