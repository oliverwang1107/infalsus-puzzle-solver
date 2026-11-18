//! 原生多執行緒求解器：`solver_native <輸入檔> <執行緒數> <時間上限毫秒>`
//! 輸入檔格式（小端）：u32 ints 長度、u32 floats 長度、i32[] ints、f64[] floats（由 src/solver_wasm.js 的 marshal() 產生）。
//! 輸出（stdout，每行一筆）：`I 值 節點數 pid:效能,…`（全域最佳改進時）、最後一行 `D 最佳值 節點數 停止(0/1) 統計×6 | pid:效能,…`。
use std::io::Read;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("用法：solver_native <輸入檔> <執行緒數> <時間上限毫秒>");
        std::process::exit(2);
    }
    let mut buf = Vec::new();
    std::fs::File::open(&args[1]).and_then(|mut f| f.read_to_end(&mut buf)).unwrap_or_else(|e| {
        eprintln!("讀取輸入檔失敗：{}", e);
        std::process::exit(2);
    });
    let threads: usize = args[2].parse().unwrap_or(1);
    let limit: f64 = args[3].parse().unwrap_or(60000.0);
    let ni = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
    let nf = u32::from_le_bytes(buf[4..8].try_into().unwrap()) as usize;
    let ints: Vec<i32> = buf[8..8 + ni * 4].chunks_exact(4).map(|c| i32::from_le_bytes(c.try_into().unwrap())).collect();
    let fls: Vec<f64> = buf[8 + ni * 4..8 + ni * 4 + nf * 8].chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect();
    let r = infalsus_solver::solve_native(&ints, &fls, threads, limit, true);
    let list: Vec<String> = r.best.as_ref().map(|b| b.iter().map(|&(p, e)| format!("{}:{}", p, e)).collect()).unwrap_or_default();
    println!(
        "D {} {} {} {} {} {} {} {} {} | {}",
        r.best_val, r.nodes, if r.stop { 1 } else { 0 }, r.st[0], r.st[1], r.st[2], r.st[3], r.st[4], r.st[5], list.join(",")
    );
}
