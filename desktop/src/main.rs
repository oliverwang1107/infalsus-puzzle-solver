//! In Falsus 製卡最佳化：桌面版（Rust 原生視窗＋系統內建 WebView2）。
//! - 介面就是 infalsus_solver.html（編譯時內嵌），用自訂協定載入，localStorage 存在 %LOCALAPPDATA%\InFalsusSolver。
//! - 求解：網頁把攤平後的問題用 IPC 丟給本程式；本程式再以 `--solve` 模式啟動自己（子行程，用滿所有 CPU 核心）
//!   跑 `infalsus_solver::solve_native`，把每行輸出（I＝改進、D＝結束）送回網頁。按「停止」就是把子行程殺掉。
#![windows_subsystem = "windows"]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use base64::Engine;
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::{Icon, WindowBuilder};
use wry::http::Response;
use wry::{WebContext, WebViewBuilder};

const HTML: &str = include_str!("../../infalsus_solver.html");

enum Ev {
    /// (求解編號, 腳本)：在網頁裡執行
    Script(String),
}

type Children = Arc<Mutex<HashMap<u64, Child>>>;

/// 子行程模式：`InFalsusSolver --solve <輸入檔> <執行緒數> <時間上限毫秒>`，輸出格式同 solver_native
fn solve_mode(args: &[String]) -> ! {
    let mut buf = Vec::new();
    std::fs::File::open(&args[2]).and_then(|mut f| f.read_to_end(&mut buf)).unwrap_or_else(|_| std::process::exit(2));
    let threads: usize = args[3].parse().unwrap_or(1);
    let limit: f64 = args[4].parse().unwrap_or(60000.0);
    let ni = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
    let nf = u32::from_le_bytes(buf[4..8].try_into().unwrap()) as usize;
    let ints: Vec<i32> = buf[8..8 + ni * 4].chunks_exact(4).map(|c| i32::from_le_bytes(c.try_into().unwrap())).collect();
    let fls: Vec<f64> = buf[8 + ni * 4..8 + ni * 4 + nf * 8].chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect();
    let r = infalsus_solver::solve_native(&ints, &fls, threads, limit, true);
    let list: Vec<String> = r.best.as_ref().map(|b| b.iter().map(|&(p, e)| format!("{}:{}", p, e)).collect()).unwrap_or_default();
    let out = format!(
        "D {} {} {} {} {} {} {} {} {} | {}\n",
        r.best_val, r.nodes, if r.stop { 1 } else { 0 }, r.st[0], r.st[1], r.st[2], r.st[3], r.st[4], r.st[5], list.join(",")
    );
    let _ = std::io::stdout().write_all(out.as_bytes());
    let _ = std::io::stdout().flush();
    std::process::exit(0);
}

fn js_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

fn start_solve(id: u64, threads: u64, limit: f64, data: &str, children: &Children, proxy: &EventLoopProxy<Ev>) {
    let say = |code: &str| { let _ = proxy.send_event(Ev::Script(code.to_string())); };
    let bytes = match base64::engine::general_purpose::STANDARD.decode(data) {
        Ok(b) => b,
        Err(_) => { say(&format!("window.__desk&&__desk.end({},1,\"資料解碼失敗\")", id)); return; }
    };
    let file = std::env::temp_dir().join(format!("infalsus-{}-{}.bin", std::process::id(), id));
    if std::fs::write(&file, &bytes).is_err() { say(&format!("window.__desk&&__desk.end({},1,\"寫入暫存檔失敗\")", id)); return; }
    let exe = match std::env::current_exe() { Ok(e) => e, Err(_) => { say(&format!("window.__desk&&__desk.end({},1,\"找不到自己的執行檔\")", id)); return; } };
    let mut child = match Command::new(exe).arg("--solve").arg(&file).arg(threads.to_string()).arg(format!("{}", limit))
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(c) => c,
        Err(e) => { say(&format!("window.__desk&&__desk.end({},1,{})", id, js_str(&e.to_string()))); return; }
    };
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    children.lock().unwrap().insert(id, child);
    let children = children.clone();
    let proxy = proxy.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = proxy.send_event(Ev::Script(format!("window.__desk&&__desk.line({},{})", id, js_str(&line))));
        }
        let mut err = String::new();
        let _ = stderr.read_to_string(&mut err);
        let code = match children.lock().unwrap().remove(&id) {
            Some(mut c) => c.wait().ok().and_then(|s| s.code()).unwrap_or(-1),
            None => -2, // 已被「停止」殺掉
        };
        let _ = std::fs::remove_file(&file);
        let _ = proxy.send_event(Ev::Script(format!("window.__desk&&__desk.end({},{},{})", id, code, js_str(err.trim()))));
    });
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 5 && args[1] == "--solve" { solve_mode(&args); }

    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let event_loop = EventLoopBuilder::<Ev>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let window = WindowBuilder::new()
        .with_title("In Falsus 製卡最佳化")
        .with_window_icon(Icon::from_rgba(include_bytes!("../icon_64.rgba").to_vec(), 64, 64).ok())
        .with_inner_size(LogicalSize::new(1400.0, 900.0))
        .build(&event_loop)
        .expect("建立視窗失敗");

    let data_dir = std::env::var_os("LOCALAPPDATA").map(|p| std::path::PathBuf::from(p).join("InFalsusSolver"));
    let mut ctx = WebContext::new(data_dir);
    let children: Children = Arc::new(Mutex::new(HashMap::new()));
    let ipc_children = children.clone();
    let ipc_proxy = proxy.clone();

    let init = format!("window.__DESKTOP={{cores:{}}};", cores);
    let webview = WebViewBuilder::new_with_web_context(&mut ctx)
        .with_initialization_script(&init)
        .with_custom_protocol("app".into(), |_id, _req| {
            Response::builder().header("content-type", "text/html; charset=utf-8").header("cache-control", "no-store")
                .body(HTML.as_bytes().to_vec()).unwrap().map(Into::into)
        })
        .with_url("http://app.localhost/")
        .with_ipc_handler(move |req| {
            let v: serde_json::Value = match serde_json::from_str(req.body()) { Ok(v) => v, Err(_) => return };
            let id = v["id"].as_u64().unwrap_or(0);
            match v["t"].as_str() {
                Some("solve") => start_solve(id, v["threads"].as_u64().unwrap_or(cores as u64).max(1), v["limit"].as_f64().unwrap_or(60000.0), v["data"].as_str().unwrap_or(""), &ipc_children, &ipc_proxy),
                Some("stop") => { if let Some(mut c) = ipc_children.lock().unwrap().remove(&id) { let _ = c.kill(); let _ = c.wait(); } }
                _ => {}
            }
        })
        .build(&window)
        .expect("建立網頁視窗失敗（需要 Windows 內建的 WebView2）");

    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(Ev::Script(js)) => { let _ = webview.evaluate_script(&js); }
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                for (_, mut c) in children.lock().unwrap().drain() { let _ = c.kill(); }
                *flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}
