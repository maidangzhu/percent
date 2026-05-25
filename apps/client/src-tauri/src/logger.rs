use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub id: usize,
    pub timestamp: String,
    pub app_name: String,
    pub app_bundle_id: String,
    pub is_send: bool,
    pub ai_result: Option<String>,
}

pub struct LogStore {
    entries: Vec<LogEntry>,
    log_file: PathBuf,
    pub log_dir: PathBuf,
}

impl Default for LogStore {
    fn default() -> Self {
        let log_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("percent-tracker");

        let _ = create_dir_all(&log_dir);

        let mut store = Self {
            entries: Vec::new(),
            log_file: log_dir.join("enter-log.txt"),
            log_dir,
        };

        store.load_existing();
        store
    }
}

impl LogStore {
    pub fn add_entry(&mut self, app_name: String, app_bundle_id: String, is_send: bool) -> usize {
        let now: DateTime<Local> = Local::now();
        let id = self.entries.len() + 1;
        let entry = LogEntry {
            id,
            timestamp: now.format("%Y-%m-%d %H:%M:%S%.3f").to_string(),
            app_name: app_name.clone(),
            app_bundle_id: app_bundle_id.clone(),
            is_send,
            ai_result: None,
        };

        self.entries.push(entry.clone());

        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_file)
        {
            let send_str = if is_send { "SEND" } else { "NEWLINE" };
            let _ = writeln!(
                file,
                "[{}] {} | {} ({}) | {}",
                entry.timestamp, send_str, app_name, app_bundle_id, id
            );
        }

        id
    }

    /// TS 层 AI 分析完成后回传结果，写内存 + 追加持久化
    pub fn set_ai_result(&mut self, entry_id: usize, summary: String) {
        if let Some(entry) = self.entries.iter_mut().find(|e| e.id == entry_id) {
            entry.ai_result = Some(summary.clone());
        }
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.log_dir.join("ai-result.txt"))
        {
            let _ = writeln!(file, "[entry #{}] {}", entry_id, summary);
        }
    }

    pub fn get_all(&self) -> Vec<LogEntry> {
        self.entries.iter().rev().cloned().collect()
    }

    pub fn count(&self) -> usize {
        self.entries.len()
    }

    pub fn send_count(&self) -> usize {
        self.entries.iter().filter(|e| e.is_send).count()
    }

    pub fn clear_local_files(&mut self) -> std::io::Result<usize> {
        self.entries.clear();

        let mut removed = 0_usize;
        for path in [&self.log_file, &self.log_dir.join("ai-result.txt")] {
            if path.exists() {
                std::fs::remove_file(path)?;
                removed += 1;
            }
        }

        Ok(removed)
    }

    fn load_existing(&mut self) {
        if let Ok(content) = std::fs::read_to_string(&self.log_file) {
            for (i, line) in content.lines().enumerate() {
                if let Some(ts) = line.strip_prefix("[").and_then(|s| s.split("]").next()) {
                    let parts: Vec<&str> = line.splitn(4, " | ").collect();
                    let is_send = line.contains("] SEND |");
                    let app_name = parts.get(1).map(|s| s.trim().to_string()).unwrap_or_default();
                    let (name, bundle) = parse_app_field(&app_name);
                    self.entries.push(LogEntry {
                        id: i + 1,
                        timestamp: ts.to_string(),
                        app_name: name,
                        app_bundle_id: bundle,
                        is_send,
                        ai_result: None,
                    });
                }
            }
        }
    }
}

fn parse_app_field(s: &str) -> (String, String) {
    if let (Some(p), Some(e)) = (s.rfind('('), s.rfind(')')) {
        if p < e {
            let name = s[..p].trim().to_string();
            let bundle = s[p + 1..e].to_string();
            return (name, bundle);
        }
    }
    (s.to_string(), String::new())
}
