/// 获取当前前台应用信息
#[derive(Debug, Clone)]
pub struct FrontApp {
    pub name: String,
    pub bundle_id: String,
}

#[cfg(target_os = "macos")]
pub fn get_frontmost_app() -> FrontApp {
    use std::process::Command;

    // 用 osascript 拿前台 app，不需要任何权限
    let output = Command::new("osascript")
        .arg("-e")
        .arg(r#"tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set appName to name of frontApp
  set bundleId to bundle identifier of frontApp
  return appName & "|" & bundleId
end tell"#)
        .output();

    match output {
        Ok(out) if out.status.success() => {
            let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let parts: Vec<&str> = raw.splitn(2, '|').collect();
            FrontApp {
                name: parts.first().unwrap_or(&"").trim().to_string(),
                bundle_id: parts.get(1).unwrap_or(&"").trim().to_string(),
            }
        }
        _ => FrontApp {
            name: "Unknown".into(),
            bundle_id: String::new(),
        },
    }
}

#[cfg(not(target_os = "macos"))]
pub fn get_frontmost_app() -> FrontApp {
    FrontApp {
        name: "Unknown".into(),
        bundle_id: String::new(),
    }
}

/// 根据 bundle ID 或 app 名判断 Enter 是否为"发送消息"
pub fn is_send_action(app: &FrontApp) -> bool {
    // 用 bundle ID 匹配（精准）
    let send_bundles = [
        "com.tencent.xinWeChat",        // 微信
        "com.bytedance.lark",            // 飞书国内
        "com.bytedance.lark.enterprise", // 飞书企业
        "com.electron.lark",             // 飞书旧版
        "com.tencent.qq",                // QQ
        "ru.keepcoder.Telegram",         // Telegram
        "com.tinyspeck.slackmacgap",     // Slack
        "com.hnc.Discord",               // Discord
        "com.apple.MobileSMS",           // iMessage
        "com.whatsapp.WhatsApp",         // WhatsApp
        "com.alibabainc.dingtalk",        // 钉钉
        "com.alibabainc.DingTalkMacOS",  // 钉钉
        "com.zoom.xos",                  // Zoom
        "com.microsoft.teams2",          // Teams
        "com.microsoft.teams",           // Teams 旧版
        "com.skype.skype",               // Skype
        "jp.naver.line.mac",             // LINE
    ];

    if send_bundles.contains(&app.bundle_id.as_str()) {
        return true;
    }

    // 兜底：app 名模糊匹配
    let name_lower = app.name.to_lowercase();
    let send_names = [
        "wechat", "微信",
        "lark", "feishu", "飞书",
        "telegram", "slack", "discord",
        "messages", "信息",
        "whatsapp", "dingtalk", "钉钉",
        "qq", "teams", "skype", "line", "zoom",
    ];

    send_names.iter().any(|n| name_lower.contains(n))
}
