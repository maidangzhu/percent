use std::path::PathBuf;
use std::process::Command;
use chrono::Local;

/// 截取当前屏幕，保存到 ~/.percent-tracker/screenshots/
/// 文件名格式: screenshot_2026-05-22_15-30-00-123.png
/// 返回保存路径，失败返回 None
pub fn capture_screen(log_dir: &PathBuf) -> Option<PathBuf> {
    let screenshots_dir = log_dir.join("screenshots");
    if let Err(e) = std::fs::create_dir_all(&screenshots_dir) {
        eprintln!("[screenshot] failed to create dir: {}", e);
        return None;
    }

    let timestamp = Local::now().format("%Y-%m-%d_%H-%M-%S-%3f").to_string();
    let filename = format!("screenshot_{}.png", timestamp);
    let output_path = screenshots_dir.join(&filename);

    // macOS 内置 screencapture 命令，-x 静默（不播放快门声）
    let status = Command::new("screencapture")
        .arg("-x")                              // 静默，不播放声音
        .arg("-t").arg("png")                   // 格式
        .arg(output_path.to_str().unwrap_or(""))
        .status();

    match status {
        Ok(s) if s.success() => {
            eprintln!("[screenshot] saved to {:?}", output_path);
            Some(output_path)
        }
        Ok(s) => {
            eprintln!("[screenshot] screencapture exited with: {}", s);
            None
        }
        Err(e) => {
            eprintln!("[screenshot] failed to run screencapture: {}", e);
            None
        }
    }
}
