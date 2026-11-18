//! In Falsus 製卡求解器的搜尋核心（對應 `src/solver.js` 的 `searchJS`，逐行對照移植）。
//!
//! 題目由 JS 端 `prepare()` 算好（所有合法擺放、遮罩、區域、粒子堆疊…），攤平成 `ints`／`floats` 兩個陣列
//! 寫進 WASM 記憶體再呼叫 `run`；結果寫在固定的輸出緩衝區（`out_*_ptr`）。
//! 搜尋順序、剪枝與同分時的取捨都和 JS 版一樣，所以兩邊的最佳值一定相同（測試逐題比對）。
//!
//! 搜尋法是「區域組合＋鋪法輪廓上界」（說明見 `src/solver.js` 的 `buildPlan`；效能紀錄見 `notes_perf.md`）：
//! 區域組合的清單與上界由 JS 的 `buildPlan()` 算好一起傳進來，塊與鋪法輪廓由這邊用同一套算法邊搜邊算。
//! 區域太多（`plan_ok` 為 false）或 `flags` 帶 8 時用舊版的 `dfs_zone`。
//!
//! JS 要提供的匯入（模組名 `env`）：`now_ms`、`should_stop`、`on_progress`、`on_improve`。
#![allow(static_mut_refs)]

use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasherDefault, Hasher};

#[cfg(target_arch = "wasm32")]
mod host {
    extern "C" {
        fn now_ms() -> f64;
        fn should_stop() -> i32;
        fn on_progress(nodes: f64, ms: f64, best: f64);
        fn on_improve(value: f64, nodes: f64, ms: f64);
    }
    pub fn now() -> f64 {
        unsafe { now_ms() }
    }
    pub fn stop_requested() -> bool {
        unsafe { should_stop() != 0 }
    }
    pub fn progress(nodes: f64, ms: f64, best: f64) {
        unsafe { on_progress(nodes, ms, best) }
    }
    pub fn improve(value: f64, nodes: f64, ms: f64) {
        unsafe { on_improve(value, nodes, ms) }
    }
}
#[cfg(not(target_arch = "wasm32"))]
mod host {
    use std::sync::OnceLock;
    use std::time::Instant;
    static START: OnceLock<Instant> = OnceLock::new();
    pub fn now() -> f64 {
        START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
    }
    pub fn stop_requested() -> bool {
        false
    }
    pub fn progress(_nodes: f64, _ms: f64, _best: f64) {}
    pub fn improve(_value: f64, _nodes: f64, _ms: f64) {}
}

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// 原生多執行緒版：各執行緒共用的最佳值（互相幫忙剪枝）、第一層候選擺放的認領表（動態分工）、輸出鎖。
pub struct Sink {
    best: AtomicU64,
    claims: Vec<Vec<AtomicBool>>,
    // 「區域組合」搜尋：每個組合被第幾輪認領過、是否已搜完、最後一輪第一顆粒子的候選擺放發到第幾個
    stage: Vec<AtomicU32>,
    fin: Vec<AtomicBool>,
    next_k: Vec<AtomicUsize>,
    lock: Mutex<()>,
    print: bool,
}
impl Sink {
    fn best(&self) -> f64 {
        f64::from_bits(self.best.load(Ordering::Relaxed))
    }
    /// 回報一個新的最佳值；比目前全域最佳更好才回傳 true
    fn raise(&self, v: f64) -> bool {
        loop {
            let cur = self.best.load(Ordering::Acquire);
            if v <= f64::from_bits(cur) + 1e-9 {
                return false;
            }
            if self.best.compare_exchange(cur, v.to_bits(), Ordering::AcqRel, Ordering::Acquire).is_ok() {
                return true;
            }
        }
    }
    fn claim(&self, zi: usize, k: usize) -> bool {
        self.claims[zi][k].compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_ok()
    }
}

const MAX_OUT: usize = 256;
static mut OUT_PID: [i32; MAX_OUT] = [0; MAX_OUT];
static mut OUT_EFF: [f64; MAX_OUT] = [0.0; MAX_OUT];
// 0 bestVal, 1 nodes, 2 stop(0/1), 3 最佳擺放的粒子數（-1＝沒有）, 4.. 統計：leaves tiles extrasCalls extrasCands pruneZone pruneTile
static mut OUT_INFO: [f64; 16] = [0.0; 16];

#[no_mangle]
pub extern "C" fn max_out() -> usize {
    MAX_OUT
}
#[no_mangle]
pub extern "C" fn out_pid_ptr() -> usize {
    unsafe { OUT_PID.as_ptr() as usize }
}
#[no_mangle]
pub extern "C" fn out_eff_ptr() -> usize {
    unsafe { OUT_EFF.as_ptr() as usize }
}
#[no_mangle]
pub extern "C" fn out_info_ptr() -> usize {
    unsafe { OUT_INFO.as_ptr() as usize }
}

// 8 位元組對齊的緩衝區（給 JS 寫入 Int32Array／Float64Array 用）
#[no_mangle]
pub extern "C" fn alloc(bytes: usize) -> usize {
    let mut v: Vec<u64> = Vec::with_capacity((bytes + 7) / 8 + 1);
    let p = v.as_mut_ptr() as usize;
    std::mem::forget(v);
    p
}
#[no_mangle]
pub extern "C" fn dealloc(ptr: usize, bytes: usize) {
    unsafe {
        drop(Vec::from_raw_parts(ptr as *mut u64, 0, (bytes + 7) / 8 + 1));
    }
}

#[derive(Default, Clone, Copy)]
struct Fx(u64);
impl Hasher for Fx {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0.rotate_left(5) ^ b as u64).wrapping_mul(0x517c_c1b7_2722_0a95);
        }
    }
    fn write_u64(&mut self, i: u64) {
        self.0 = (self.0.rotate_left(5) ^ i).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
}
type FxSet = HashSet<u64, BuildHasherDefault<Fx>>;
type FxMap = HashMap<u64, u32, BuildHasherDefault<Fx>>;

type PairMap = HashMap<(u64, u64), u32, BuildHasherDefault<Fx>>;

/// 塊與鋪法輪廓的表（prof／hull 每個輪廓各佔 max_pieces+1 個數／W 個字）
struct Store {
    comps: Vec<Comp>,
    comp_idx: HashMap<u32, usize>,
    prof: Vec<f64>,
    pmin: Vec<usize>,
    pmax: Vec<i32>,
    hull: Vec<i32>,
}

/// 「區域組合」搜尋的一塊（組合裡同色、互相牽連的區域）。見 src/solver.js 的 buildPlan
struct Comp {
    color: usize,
    big: bool,          // 格子太多：輪廓改用粗略版（只看還有幾格沒蓋）
    cells: Vec<usize>,  // 第 i 個位元對應的板子格
    cell_bit: Vec<i8>,  // 板子格 → 位元（-1＝不在這一塊）
    zpos: Vec<usize>,   // 這一塊的區域（在 order 裡的位置）
    all: u64,           // 所有格子的位元
    memo: PairMap,      // (還沒蓋的格子, 已蓋住的格子) → 輪廓索引
    memo_big: FxMap,    // 還沒蓋的格數 → 輪廓索引
    root: i64,          // 從頭開始（都還沒蓋）的輪廓索引；-1＝還沒算
    n_states: usize,    // 已經記了幾個輪廓狀態
}

struct Zone {
    color: usize,
    must: bool,
    waive: i32,
    wtype: u8, // 0 乖離 disc、1 過載 over、2 重疊 overlap、3 整體 all
    cells: Vec<usize>,
    mask: Vec<i32>,
    atk: f64,
    def: f64,
    u: f64,
}
struct Stack {
    effs: Vec<f64>,
}
struct Pl {
    s: usize,
    color: usize,
    out: bool, // 有任何一格在板子外（粒子超界）
    cells: Vec<usize>,
}

const F_U: u8 = 0;
const F_ATK: u8 = 1;
const F_DEF: u8 = 2;

struct Search {
    n_cells: usize,
    w: usize,
    limit: i32,
    allow_overlap: bool,
    cap: i32,
    max_pieces: usize,
    max_size: [usize; 5],
    wd: i32,
    wo: i32,
    wv: i32,
    wu: i32,
    wa: i32,
    gw: [i32; 5], // 固定免除：乖離、過載、重疊、整體、超界
    has_w: bool,
    order: Vec<usize>,
    island_of: Vec<usize>,
    nb_cell: Vec<i32>,
    zones: Vec<Zone>,
    waive_z: Vec<usize>,
    must_idx: Vec<usize>,
    stacks: Vec<Stack>,
    pl: Vec<Pl>,
    pl_mask: Vec<i32>,
    pl_nb: Vec<i32>,
    cover_by: Vec<Vec<usize>>,
    by_stack: Vec<Vec<usize>>,
    mult: Vec<f64>,
    min_a: f64,
    min_d: f64,
    has_base: bool,
    g_e: Vec<f64>,
    g_s: Vec<usize>,
    g_j: Vec<usize>,
    z1: Vec<i64>,
    z2: Vec<i64>,
    lv: Vec<Vec<Vec<i32>>>,
    // 狀態
    occ: Vec<i32>,
    cov: Vec<i32>,
    snap_occ: Vec<Vec<i32>>,
    snap_cov: Vec<Vec<i32>>,
    pcs: Vec<usize>,
    eff_of: Vec<f64>,
    ov_arr: Vec<i32>,
    used: Vec<usize>,
    n: usize,
    sum_eff: f64,
    ov: i32,
    out_n: i32,
    isl_cnt: Vec<i32>,
    active_isl: i32,
    par: Vec<usize>,
    comp_of: Vec<usize>,
    col_tmp: [Vec<f64>; 5],
    dp_a: Vec<f64>,
    dp_b: Vec<f64>,
    tb: Vec<f64>,
    // 搜尋
    nodes: u64,
    stop: bool,
    best_val: f64,
    best: Option<Vec<(usize, f64)>>,
    t0: f64,
    last_prog: f64,
    time_limit: f64,
    flags: i32,
    sink: Option<Arc<Sink>>,
    split_k: usize,
    split_m: usize,
    st: [f64; 6],
    // 「區域組合」搜尋（plan_ok 為 false 時用舊版 dfs_zone）
    plan_ok: bool,
    sp_mask: Vec<u32>,
    blk: Vec<u32>,
    z_isl: Vec<u32>,
    isl_ok: bool,
    ctop: Vec<f64>,
    masks: Vec<u32>,
    rbs: Vec<f64>,
    // 塊與鋪法輪廓的表。單執行緒（WASM）時邊搜邊長；原生多執行緒時由主執行緒先算好（warm），各執行緒唯讀共用（frozen）
    store: Arc<Store>,
    frozen: bool,
    free_idx: usize,
    cur_t: u32,
    ut: f64,
    tw: [i32; 5], // 這個組合能免除的懲罰：乖離、過載、重疊、超界、整體
    isl_t: i32,
    c_used: Vec<bool>,
    // 每一塊「從頭開始時、樂觀估計下還有可能贏」的第一顆擺放：v_buf[v_start[q] .. v_start[q]+v_len[q])；v_len = -1：不設限
    v_start: Vec<usize>,
    v_len: Vec<i32>,
    v_buf: Vec<usize>,
    sxv: Vec<f64>,
    // 額外粒子用：每個堆疊「同一顆會一起蓋到的格子」（lk）與蓋到每一格的擺放清單（sc_start／sc_list）
    lk: Vec<i32>,
    sc_start: Vec<usize>,
    sc_list: Vec<usize>,
    x_stamp: Vec<u32>,
    x_stamp_id: u32,
    t_comp: Vec<usize>,
    n_tc: usize,
    sx0: Vec<f64>,
    sx1: Vec<f64>,
    sxa: Vec<f64>,
    ho: Vec<i32>,
    oth: Vec<bool>,
    cv_tmp: Vec<f64>,
    bail: bool,
    node_limit: u64,
    cur_sub: usize,
    use_claim: bool,
    in_plan: bool,
    nodes0: u64,
    skip_seed: bool,
    // 目前已放粒子的連通群（隨放隨更新）：第 n 層有 cm_n[n] 群，每群一個遮罩＝該群所有粒子的「本身＋相鄰格」聯集
    cw: usize,
    cm_n: Vec<usize>,
    cm: Vec<i32>,
}

#[inline]
fn pop32(x: i32) -> i32 {
    (x as u32).count_ones() as i32
}

impl Search {
    // ---------------------------------------------------------------- 基本操作
    #[inline]
    fn mult_of(&self, p: i32) -> f64 {
        if p >= self.cap {
            0.0
        } else {
            self.mult[p as usize]
        }
    }
    // 免除懲罰的有效懲罰下界（見 JS 版 lbEff）
    #[inline]
    fn lb_eff(&self, o: i32, v: i32, d: i32, u: i32) -> i32 {
        ((o - self.wo).max(0) + (v - self.wv).max(0) + (d - self.wd).max(0) + (u - self.wu).max(0) - self.wa).max(0)
    }
    #[inline]
    fn bound(&self) -> f64 {
        match &self.sink {
            Some(sk) => self.best_val.max(sk.best()),
            None => self.best_val,
        }
    }
    #[inline]
    fn pnd_now(&self) -> i32 {
        self.lb_eff((self.n as i32 - self.limit).max(0), self.ov, (self.active_isl - 1).max(0), self.out_n)
    }
    fn overlap_of(&self, pid: usize) -> i32 {
        let w = self.w;
        let mut c = 0;
        for k in 0..w {
            let x = self.occ[k] & self.pl_mask[pid * w + k];
            if x != 0 {
                c += pop32(x);
            }
        }
        c
    }
    fn touches(&self, pid: usize) -> bool {
        let w = self.w;
        for k in 0..w {
            if self.occ[k] & self.pl_nb[pid * w + k] != 0 {
                return true;
            }
        }
        false
    }
    fn apply(&mut self, pid: usize, ovl: i32) {
        let w = self.w;
        let n = self.n;
        {
            let d0 = n * self.cw;
            let d1 = d0 + self.cw;
            let pb = pid * w;
            let mut nc = 1;
            for k in 0..w {
                self.cm[d1 + k] = self.pl_mask[pb + k] | self.pl_nb[pb + k];
            }
            for j in 0..self.cm_n[n] {
                let o = d0 + j * w;
                let mut t = false;
                for k in 0..w {
                    if self.cm[o + k] & self.pl_mask[pb + k] != 0 {
                        t = true;
                        break;
                    }
                }
                if t {
                    for k in 0..w {
                        self.cm[d1 + k] |= self.cm[o + k];
                    }
                } else {
                    let o2 = d1 + nc * w;
                    for k in 0..w {
                        self.cm[o2 + k] = self.cm[o + k];
                    }
                    nc += 1;
                }
            }
            self.cm_n[n + 1] = nc;
        }
        self.snap_occ[n].copy_from_slice(&self.occ);
        self.snap_cov[n].copy_from_slice(&self.cov);
        let s = self.pl[pid].s;
        let e = self.stacks[s].effs[self.used[s]];
        self.pcs[n] = pid;
        self.eff_of[n] = e;
        self.ov_arr[n] = ovl;
        self.used[s] += 1;
        self.sum_eff += e;
        self.ov += ovl;
        self.n += 1;
        if self.pl[pid].out {
            self.out_n += 1;
        }
        let isl = self.island_of[self.pl[pid].cells[0]];
        if self.isl_cnt[isl] == 0 {
            self.active_isl += 1;
        }
        self.isl_cnt[isl] += 1;
        let base = self.pl[pid].color * w;
        for k in 0..w {
            let m = self.pl_mask[pid * w + k];
            self.occ[k] |= m;
            self.cov[base + k] |= m;
        }
    }
    fn undo(&mut self) {
        self.n -= 1;
        let n = self.n;
        let pid = self.pcs[n];
        let s = self.pl[pid].s;
        self.used[s] -= 1;
        self.sum_eff -= self.eff_of[n];
        self.ov -= self.ov_arr[n];
        if self.pl[pid].out {
            self.out_n -= 1;
        }
        let isl = self.island_of[self.pl[pid].cells[0]];
        self.isl_cnt[isl] -= 1;
        if self.isl_cnt[isl] == 0 {
            self.active_isl -= 1;
        }
        self.occ.copy_from_slice(&self.snap_occ[n]);
        self.cov.copy_from_slice(&self.snap_cov[n]);
    }
    fn zone_uncovered(&self, zi: usize) -> usize {
        let z = &self.zones[zi];
        let b = z.color * self.w;
        let mut c = 0;
        for k in 0..self.w {
            c += pop32(z.mask[k] & !self.cov[b + k]);
        }
        c as usize
    }
    fn zone_done(&self, zi: usize) -> bool {
        let z = &self.zones[zi];
        let b = z.color * self.w;
        for k in 0..self.w {
            if z.mask[k] & !self.cov[b + k] != 0 {
                return false;
            }
        }
        true
    }
    fn current_u(&self) -> f64 {
        let mut u = 0.0;
        for i in 0..self.zones.len() {
            if self.zones[i].u > 0.0 && self.zone_done(i) {
                u += self.zones[i].u;
            }
        }
        u
    }
    fn base_now(&self, f: u8) -> f64 {
        let mut s = 0.0;
        for i in 0..self.zones.len() {
            let v = if f == F_ATK { self.zones[i].atk } else { self.zones[i].def };
            if v > 0.0 && self.zone_done(i) {
                s += v;
            }
        }
        s
    }
    fn base_met(&self) -> bool {
        (self.min_d <= 0.0 || self.base_now(F_DEF) >= self.min_d) && (self.min_a <= 0.0 || self.base_now(F_ATK) >= self.min_a)
    }
    // 目前已放粒子的連通群數；各粒子所屬群寫在 comp_of
    fn components(&mut self) -> i32 {
        let n = self.n;
        let w = self.w;
        for i in 0..n {
            self.par[i] = i;
        }
        let mut comps = n as i32;
        for i in 0..n {
            let a = self.pcs[i];
            for j in (i + 1)..n {
                let b = self.pcs[j];
                let mut t = false;
                for k in 0..w {
                    if ((self.pl_nb[a * w + k] & self.pl_mask[b * w + k]) | (self.pl_mask[a * w + k] & self.pl_mask[b * w + k])) != 0 {
                        t = true;
                        break;
                    }
                }
                if t {
                    let ra = self.find(i);
                    let rb = self.find(j);
                    if ra != rb {
                        self.par[ra] = rb;
                        comps -= 1;
                    }
                }
            }
        }
        for i in 0..n {
            self.comp_of[i] = self.find(i);
        }
        comps
    }
    fn find(&mut self, mut x: usize) -> usize {
        while self.par[x] != x {
            let g = self.par[self.par[x]];
            self.par[x] = g;
            x = self.par[x];
        }
        x
    }
    fn write_out(&self) {
        unsafe {
            match &self.best {
                Some(b) => {
                    for (i, &(pid, e)) in b.iter().enumerate().take(MAX_OUT) {
                        OUT_PID[i] = pid as i32;
                        OUT_EFF[i] = e;
                    }
                    OUT_INFO[3] = b.len() as f64;
                }
                None => OUT_INFO[3] = -1.0,
            }
            OUT_INFO[0] = self.best_val;
            OUT_INFO[1] = self.nodes as f64;
            OUT_INFO[2] = if self.stop { 1.0 } else { 0.0 };
            for i in 0..6 {
                OUT_INFO[4 + i] = self.st[i];
            }
        }
    }

    // ---------------------------------------------------------------- 計分與上界
    fn eval_current(&mut self) -> f64 {
        if self.n == 0 {
            return 0.0;
        }
        for i in 0..self.must_idx.len() {
            if !self.zone_done(self.must_idx[i]) {
                return 0.0;
            }
        }
        if self.has_base && !self.base_met() {
            return 0.0;
        }
        let u = self.current_u();
        if u <= 0.0 {
            return 0.0;
        }
        let (mut wd, mut wo, mut wv, mut wa, mut wu) = (self.gw[0], self.gw[1], self.gw[2], self.gw[3], self.gw[4]);
        if self.has_w {
            for i in 0..self.waive_z.len() {
                let zi = self.waive_z[i];
                if self.zone_done(zi) {
                    let z = &self.zones[zi];
                    match z.wtype {
                        1 => wo += z.waive,
                        2 => wv += z.waive,
                        3 => wa += z.waive,
                        4 => wu += z.waive,
                        _ => wd += z.waive,
                    }
                }
            }
        }
        let comps = self.cm_n[self.n] as i32;
        let p = (((self.n as i32 - self.limit).max(0) - wo).max(0) + (self.ov - wv).max(0) + (comps - 1 - wd).max(0) + (self.out_n - wu).max(0) - wa).max(0);
        let v = (u * (self.sum_eff / self.n as f64) / 100.0) * self.mult_of(p);
        let tie = match &self.best {
            Some(b) => v > 0.0 && (v - self.best_val).abs() <= 1e-9 && self.n < b.len(),
            None => false,
        };
        if v > self.best_val + 1e-9 || tie {
            let improved = v > self.best_val + 1e-9;
            self.best_val = v;
            let mut b = Vec::with_capacity(self.n);
            for i in 0..self.n {
                b.push((self.pcs[i], self.eff_of[i]));
            }
            self.best = Some(b);
            if improved && (self.flags & 2) != 0 {
                self.write_out();
                host::improve(v, self.nodes as f64, host::now() - self.t0);
            }
            if improved {
                if let (Some(sk), Some(b)) = (&self.sink, &self.best) {
                    if sk.raise(v) && sk.print {
                        #[cfg(not(target_arch = "wasm32"))]
                        {
                            let _g = sk.lock.lock().unwrap();
                            let list: Vec<String> = b.iter().map(|&(pid, e)| format!("{}:{}", pid, e)).collect();
                            println!("I {} {} {}", v, self.nodes, list.join(","));
                            use std::io::Write;
                            let _ = std::io::stdout().flush();
                        }
                    }
                }
            }
        }
        v
    }

    // 再多放 k 顆（取剩餘庫存中最好的）時，平均效能的上界。skip_s／skip_j：略過某一顆（已被假設放下）
    fn avg_ub_k(&self, n_now: i32, s_now: f64, k: i32, skip_s: i64, skip_j: i64) -> f64 {
        let mut b = if n_now != 0 { s_now / n_now as f64 } else { 0.0 };
        let mut sum = s_now;
        let mut cnt = n_now;
        let mut taken = 0;
        let mut i = 0;
        while i < self.g_e.len() && taken < k {
            let si = self.g_s[i];
            let j = self.g_j[i];
            if j < self.used[si] || (si as i64 == skip_s && j as i64 == skip_j) {
                i += 1;
                continue;
            }
            sum += self.g_e[i];
            cnt += 1;
            taken += 1;
            let a = sum / cnt as f64;
            if a > b {
                b = a;
            }
            i += 1;
        }
        b
    }
    fn ub_value(&self, uopt: f64, n_now: i32, s_now: f64, pnd: i32) -> f64 {
        uopt * self.avg_ub_k(n_now, s_now, self.max_pieces as i32 - n_now, -1, -1) / 100.0 * self.mult_of(pnd)
    }

    // 剩餘區域的價值上界（背包）。forced：必須選入的區域；回傳 -inf 表示放不下
    fn knap(&mut self, zi: usize, budget: i32, forced: i64, field: u8) -> f64 {
        if budget < 0 {
            return f64::NEG_INFINITY;
        }
        let budget = budget as usize;
        for c in 0..5 {
            self.col_tmp[c].clear();
        }
        for k in zi..self.order.len() {
            let zid = self.order[k];
            let unc = self.zone_uncovered(zid);
            if unc == 0 {
                continue;
            }
            let z = &self.zones[zid];
            let val = match field {
                F_ATK => z.atk,
                F_DEF => z.def,
                _ => z.u,
            };
            let f = if zid as i64 == forced || z.must { 1.0 } else { 0.0 };
            let col = z.color;
            self.col_tmp[col].push(val);
            self.col_tmp[col].push(unc as f64);
            self.col_tmp[col].push(f);
        }
        for b in 0..=budget {
            self.dp_a[b] = 0.0;
        }
        for c in 0..5 {
            let m = self.col_tmp[c].len() / 3;
            if m == 0 {
                continue;
            }
            let mut fmask: u32 = 0;
            for i in 0..m {
                if self.col_tmp[c][i * 3 + 2] != 0.0 {
                    fmask |= 1u32 << i;
                }
            }
            for b in 0..=budget {
                self.tb[b] = f64::NEG_INFINITY;
            }
            let total: u64 = 1u64 << m;
            let mut mask: u64 = 0;
            while mask < total {
                let mk = mask as u32;
                if (mk & fmask) == fmask {
                    let mut su = 0.0;
                    let mut sc = 0.0;
                    for i in 0..m {
                        if mk & (1u32 << i) != 0 {
                            su += self.col_tmp[c][i * 3];
                            sc += self.col_tmp[c][i * 3 + 1];
                        }
                    }
                    let kk = if sc != 0.0 { (sc / self.max_size[c] as f64).ceil() as usize } else { 0 };
                    if kk <= budget && su > self.tb[kk] {
                        self.tb[kk] = su;
                    }
                }
                mask += 1;
            }
            for b in 0..=budget {
                let mut bestv = f64::NEG_INFINITY;
                for kk in 0..=b {
                    if self.tb[kk] == f64::NEG_INFINITY || self.dp_a[b - kk] == f64::NEG_INFINITY {
                        continue;
                    }
                    let v = self.dp_a[b - kk] + self.tb[kk];
                    if v > bestv {
                        bestv = v;
                    }
                }
                self.dp_b[b] = bestv;
            }
            for b in 0..=budget {
                self.dp_a[b] = self.dp_b[b];
            }
        }
        self.dp_a[budget]
    }

    fn tick(&mut self) {
        self.nodes += 1;
        if self.nodes >= self.node_limit {
            self.bail = true;
        }
        if self.nodes & 1023 == 0 {
            let t = host::now();
            if t - self.t0 > self.time_limit {
                self.stop = true;
            }
            if (self.flags & 4) != 0 && host::stop_requested() {
                self.stop = true;
            }
            if (self.flags & 1) != 0 && t - self.last_prog > 250.0 {
                self.last_prog = t;
                host::progress(self.nodes as f64, t - self.t0, self.best_val);
            }
        }
    }

    // 基礎攻防門檻的剪枝（見 JS 版 baseReachable）
    fn base_reachable(&mut self, zi: usize, forced: i64) -> bool {
        let budget = self.max_pieces as i32 - self.n as i32;
        if self.min_d > 0.0 {
            let k = self.knap(zi, budget, forced, F_DEF);
            if k == f64::NEG_INFINITY || self.base_now(F_DEF) + k < self.min_d {
                return false;
            }
        }
        if self.min_a > 0.0 {
            let k = self.knap(zi, budget, forced, F_ATK);
            if k == f64::NEG_INFINITY || self.base_now(F_ATK) + k < self.min_a {
                return false;
            }
        }
        true
    }

    // ---------------------------------------------------------------- 搜尋
    fn dfs_zone(&mut self, zi: usize) {
        if self.stop || self.bail {
            return;
        }
        self.tick();
        if zi == self.order.len() {
            if self.n > 0 && (!self.has_base || self.base_met()) {
                self.st[0] += 1.0;
                self.eval_current();
                self.extras_search();
            }
            return;
        }
        let zid = self.order[zi];
        let budget = self.max_pieces as i32 - self.n as i32;
        let kn = self.knap(zi, budget, -1, F_U);
        if kn == f64::NEG_INFINITY {
            self.st[4] += 1.0;
            return;
        }
        if self.has_base && !self.base_reachable(zi, -1) {
            self.st[4] += 1.0;
            return;
        }
        let ub = self.ub_value(self.current_u() + kn, self.n as i32, self.sum_eff, self.pnd_now());
        if ub <= self.bound() + 1e-9 {
            self.st[4] += 1.0;
            return;
        }
        if self.zone_done(zid) {
            self.dfs_zone(zi + 1);
            return;
        }
        self.tile(zi);
        if !self.zones[zid].must {
            self.dfs_zone(zi + 1); // 必觸發的區域不能略過
        }
    }

    fn tile(&mut self, zi: usize) {
        if self.stop || self.bail {
            return;
        }
        let zid = self.order[zi];
        let color = self.zones[zid].color;
        let w = self.w;
        let mut c: i64 = -1;
        for &ci in &self.zones[zid].cells {
            if self.cov[color * w + (ci >> 5)] & (1i32 << (ci & 31)) == 0 {
                c = ci as i64;
                break;
            }
        }
        if c < 0 {
            self.dfs_zone(zi + 1);
            return;
        }
        if self.n >= self.max_pieces {
            return;
        }
        let need = ((self.zone_uncovered(zid) as f64) / self.max_size[color] as f64).ceil() as i64;
        if need > self.max_pieces as i64 - self.n as i64 {
            return;
        }
        let budget = self.max_pieces as i32 - self.n as i32;
        let ubase = self.current_u() + self.knap(zi, budget, zid as i64, F_U);
        if !(ubase > 0.0) || self.ub_value(ubase, self.n as i32, self.sum_eff, self.pnd_now()) <= self.bound() + 1e-9 {
            self.st[5] += 1.0;
            return;
        }
        if self.has_base && !self.base_reachable(zi, zid as i64) {
            self.st[5] += 1.0;
            return;
        }
        self.st[1] += 1.0;
        let key = (c as usize) * 5 + color;
        let rest_k = self.max_pieces as i32 - self.n as i32 - 1;
        let len = self.cover_by[key].len();
        for k in 0..len {
            if self.n == 0 {
                if let Some(sk) = &self.sink {
                    if !sk.claim(zi, k) {
                        continue; // 原生多執行緒：第一顆粒子的候選擺放，誰先認領誰搜
                    }
                } else if self.split_m > 1 && k % self.split_m != self.split_k {
                    continue; // 平行搜尋：第一顆粒子的候選擺放輪流分給各份
                }
            }
            let pid = self.cover_by[key][k];
            let si = self.pl[pid].s;
            if self.used[si] >= self.stacks[si].effs.len() {
                continue;
            }
            let ovl = self.overlap_of(pid);
            if ovl != 0 && !self.allow_overlap {
                continue;
            }
            let pc = self.lb_eff((self.n as i32 + 1 - self.limit).max(0), self.ov + ovl, (self.active_isl - 1).max(0), self.out_n + if self.pl[pid].out { 1 } else { 0 });
            if pc >= self.cap {
                continue;
            }
            // 前置過濾：放這顆之後，就算其餘都補到最好，也贏不了目前最佳 → 不展開
            let e = self.stacks[si].effs[self.used[si]];
            if ubase * self.avg_ub_k(self.n as i32 + 1, self.sum_eff + e, rest_k, si as i64, self.used[si] as i64) / 100.0 * self.mult_of(pc) <= self.bound() + 1e-9 {
                continue;
            }
            self.tick();
            if self.stop || self.bail {
                return;
            }
            self.apply(pid, ovl);
            self.tile(zi);
            self.undo();
        }
    }

    // 額外粒子：用來拉高平均效能、或把分離的粒子群接起來
    fn extras_search(&mut self) {
        let k = self.max_pieces as i32 - self.n as i32;
        if k <= 0 {
            return;
        }
        let ub = self.ub_value(self.current_u(), self.n as i32, self.sum_eff, self.pnd_now());
        if ub <= self.bound() + 1e-9 {
            return;
        }
        self.st[2] += 1.0;
        let u = self.current_u();
        let mut visited = FxSet::default();
        self.extras_rec(k, &mut visited, u, 0, 0);
    }

    // 距離 d 以內（不含自身）的鄰近格遮罩（JS 版 nbOf）
    fn nb_of(&mut self, pid: usize, d: usize) -> Vec<i32> {
        let w = self.w;
        if self.lv[pid].is_empty() {
            self.lv[pid].push(Vec::new());
            let nb: Vec<i32> = self.pl_nb[pid * w..(pid + 1) * w].to_vec();
            self.lv[pid].push(nb);
        }
        while self.lv[pid].len() <= d {
            let prev = self.lv[pid].last().unwrap().clone();
            let mut e = vec![0i32; w];
            for i in 0..self.n_cells {
                if prev[i >> 5] & (1i32 << (i & 31)) != 0 {
                    for k in 0..w {
                        e[k] |= self.nb_cell[i * w + k];
                    }
                }
            }
            for k in 0..w {
                e[k] = (e[k] | prev[k]) & !self.pl_mask[pid * w + k];
            }
            self.lv[pid].push(e);
        }
        self.lv[pid][d].clone()
    }

    /// 額外粒子的把關（JS 版 x0）：再放一顆效能 e 的粒子，放完乖離 d0，「就停在這裡」有沒有可能贏
    fn x0(&self, e: f64, d0: i32, out2: i32, u: f64) -> bool {
        let n2 = self.n as i32 + 1;
        let p0 = self.lb_x(if n2 > self.limit { n2 - self.limit } else { 0 }, self.ov, d0, out2);
        p0 < self.cap && (u * ((self.sum_eff + e) / n2 as f64) / 100.0) * self.mult[p0 as usize] > self.bound() + 1e-9
    }
    /// （JS 版 xFut）：放了堆疊 s 的下一顆之後，最多再補 k-1 顆最好的粒子（乖離最好降到 d_i）有沒有可能贏
    fn x_fut(&self, s: usize, e: f64, d_i: i32, out2: i32, k: i32, u: f64) -> bool {
        let n2 = self.n as i32 + 1;
        let target = self.bound() + 1e-9;
        let mut sum = self.sum_eff + e;
        let mut cnt = 0;
        let mut i = 0;
        while i < self.g_e.len() && cnt < k - 1 {
            let si = self.g_s[i];
            let j = self.g_j[i];
            if j < self.used[si] || (si == s && j == self.used[s]) {
                i += 1;
                continue;
            }
            cnt += 1;
            sum += self.g_e[i];
            let nn = n2 + cnt;
            let pp = self.lb_x(if nn > self.limit { nn - self.limit } else { 0 }, self.ov, d_i, out2);
            if pp < self.cap && (u * (sum / nn as f64) / 100.0) * self.mult[pp as usize] > target {
                return true;
            }
            i += 1;
        }
        false
    }
    /// 堆疊 s 的擺放裡，有可能同時碰到兩個群的（JS 版 bridgeList）。fr_m／fr_c：各群旁邊還空著的格子（遮罩／清單）
    fn bridge_list(&mut self, s: usize, nc0: usize, fr_m: &[i32], fr_c: &[Vec<usize>]) -> Vec<usize> {
        let w = self.w;
        let nn = self.n_cells;
        let mut out: Vec<usize> = Vec::new();
        self.x_stamp_id += 1;
        let st = self.x_stamp_id;
        for i in 0..nc0.saturating_sub(1) {
            for &a in &fr_c[i] {
                let o = (s * nn + a) * w;
                let mut reach = false;
                let mut j = i + 1;
                while j < nc0 && !reach {
                    for q in 0..w {
                        if self.lk[o + q] & fr_m[j * w + q] != 0 {
                            reach = true;
                            break;
                        }
                    }
                    j += 1;
                }
                if !reach {
                    continue;
                }
                for y in self.sc_start[s * nn + a]..self.sc_start[s * nn + a + 1] {
                    let pid = self.sc_list[y];
                    if self.x_stamp[pid] != st {
                        self.x_stamp[pid] = st;
                        out.push(pid);
                    }
                }
            }
        }
        out
    }
    fn extras_rec(&mut self, k: i32, visited: &mut FxSet, u: f64, h1: i64, h2: i64) {
        if self.stop || self.bail {
            return;
        }
        let w = self.w;
        let comps = self.components();
        let avg = self.sum_eff / self.n as f64;
        let mut comp_mask: Vec<Vec<i32>> = Vec::new();
        if comps > 1 {
            let mut roots: Vec<usize> = Vec::new();
            for i in 0..self.n {
                let root = self.comp_of[i];
                let idx = match roots.iter().position(|&r| r == root) {
                    Some(x) => x,
                    None => {
                        roots.push(root);
                        comp_mask.push(vec![0i32; w]);
                        roots.len() - 1
                    }
                };
                let pid = self.pcs[i];
                for q in 0..w {
                    comp_mask[idx][q] |= self.pl_mask[pid * w + q];
                }
            }
        }
        let mut ord: Vec<usize> = Vec::new();
        for s in 0..self.stacks.len() {
            if self.used[s] < self.stacks[s].effs.len() {
                ord.push(s);
            }
        }
        {
            let stacks = &self.stacks;
            let used = &self.used;
            ord.sort_by(|&a, &b| {
                let ea = stacks[a].effs[used[a]];
                let eb = stacks[b].effs[used[b]];
                eb.partial_cmp(&ea).unwrap_or(std::cmp::Ordering::Equal)
            });
        }
        let p_after = self.lb_eff((self.n as i32 + 1 - self.limit).max(0), self.ov, (self.active_isl - 1).max(0), self.out_n);
        let d_in = (if self.in_plan && self.isl_t > self.active_isl { self.isl_t } else { self.active_isl } - 1).max(0);
        // 各連通群「旁邊還空著的格子」（用到才算）
        let nc0 = self.cm_n[self.n];
        let mut fr_ready = false;
        let mut fr_m: Vec<i32> = vec![0; nc0 * w];
        let mut fr_c: Vec<Vec<usize>> = Vec::new();
        for &s in &ord {
            let e = self.stacks[s].effs[self.used[s]];
            // 前置過濾：就算之後再補最好的粒子，也贏不過目前最佳 → 這種粒子不用試
            if u * self.avg_ub_k(self.n as i32 + 1, self.sum_eff + e, k - 1, s as i64, self.used[s] as i64) / 100.0 * self.mult_of(p_after) <= self.bound() + 1e-9 {
                continue;
            }
            let mut gen: Option<Vec<usize>> = None;
            if !self.x0(e, d_in, self.out_n, u) {
                if !self.x_fut(s, e, d_in, self.out_n, k, u) {
                    continue; // 這種粒子就算一放就把所有群接起來也贏不了
                }
            } else if nc0 > 1 && !self.x_fut(s, e, d_in, self.out_n, k, u) {
                // 只有「放了就停」才可能贏：算出至少要一次碰到幾群；要兩群以上的話，只看「形狀上搆得到兩群」的擺放
                let mut need = 0usize;
                while need < nc0 && !self.x0(e, (nc0 - need) as i32, self.out_n, u) {
                    need += 1;
                }
                if need >= 2 {
                    if !fr_ready {
                        fr_ready = true;
                        let base = self.n * self.cw;
                        for j in 0..nc0 {
                            let mut cl: Vec<usize> = Vec::new();
                            for q in 0..w {
                                let mut x = (self.cm[base + j * w + q] & !self.occ[q]) as u32;
                                fr_m[j * w + q] = x as i32;
                                while x != 0 {
                                    cl.push(q * 32 + x.trailing_zeros() as usize);
                                    x &= x - 1;
                                }
                            }
                            fr_c.push(cl);
                        }
                    }
                    let g = self.bridge_list(s, nc0, &fr_m, &fr_c);
                    if g.is_empty() {
                        continue;
                    }
                    gen = Some(g);
                }
            }
            // 索引：0＝板內、1＝超界（超界的粒子多 +1 懲罰，不能互相代表）
            let mut plain_done = [false, false];
            let mut far_done = [false, false];
            let len = match &gen {
                Some(g) => g.len(),
                None => self.by_stack[s].len(),
            };
            for idx in 0..len {
                let pid = match &gen {
                    Some(g) => g[idx],
                    None => self.by_stack[s][idx],
                };
                let mut hit = false;
                for q in 0..w {
                    if self.occ[q] & self.pl_mask[pid * w + q] != 0 {
                        hit = true;
                        break;
                    }
                }
                if hit {
                    continue;
                }
                let oi = if self.pl[pid].out { 1 } else { 0 };
                // 事前把關（不用真的放上去）：放了這顆之後連通群數是確定的
                {
                    let pb = pid * w;
                    let mut tc = 0usize;
                    for j in 0..self.cm_n[self.n] {
                        let o = self.n * self.cw + j * w;
                        for q in 0..w {
                            if self.cm[o + q] & self.pl_mask[pb + q] != 0 {
                                tc += 1;
                                break;
                            }
                        }
                    }
                    let isl = self.island_of[self.pl[pid].cells[0]];
                    let ai = self.active_isl + if self.isl_cnt[isl] == 0 { 1 } else { 0 };
                    let d_i = (if self.in_plan && self.isl_t > ai { self.isl_t } else { ai } - 1).max(0);
                    let out2 = self.out_n + oi as i32;
                    if !self.x0(e, (self.cm_n[self.n] - tc) as i32, out2, u) && !self.x_fut(s, e, d_i, out2, k, u) {
                        continue;
                    }
                }
                let mut allowed = false;
                if self.touches(pid) {
                    if comps == 1 {
                        if e > avg && !plain_done[oi] {
                            allowed = true;
                            plain_done[oi] = true;
                        }
                    } else {
                        // 直接接合兩群 → 一定考慮；若還有 k-1 顆可補，距離夠近的鏈式橋接也考慮
                        let mut touched = 0;
                        let mut near = 0;
                        let reach = self.nb_of(pid, (k.min(5)) as usize);
                        for cm in &comp_mask {
                            let mut t = false;
                            let mut t2 = false;
                            for q in 0..w {
                                if cm[q] & self.pl_nb[pid * w + q] != 0 {
                                    t = true;
                                }
                                if cm[q] & reach[q] != 0 {
                                    t2 = true;
                                }
                            }
                            if t {
                                touched += 1;
                            }
                            if t2 {
                                near += 1;
                            }
                        }
                        if touched >= 2 {
                            allowed = true;
                        } else if k >= 2 && near >= 2 {
                            allowed = true;
                        } else if e > avg && !plain_done[oi] {
                            allowed = true;
                            plain_done[oi] = true;
                        }
                    }
                } else if !far_done[oi] {
                    allowed = true;
                    far_done[oi] = true;
                }
                if !allowed {
                    continue;
                }
                self.tick();
                if self.stop || self.bail {
                    return;
                }
                self.st[3] += 1.0;
                let nh1 = h1 ^ self.z1[pid];
                let nh2 = h2 ^ self.z2[pid];
                let sig = (nh1 as u64) * 67_108_864u64 + nh2 as u64;
                if visited.insert(sig) {
                    self.apply(pid, 0);
                    self.eval_current();
                    if k > 1 && self.ub_value(u, self.n as i32, self.sum_eff, self.pnd_now()) > self.bound() + 1e-9 {
                        self.extras_rec(k - 1, visited, u, nh1, nh2);
                    }
                    self.undo();
                }
            }
        }
    }
}

// ---------------------------------------------------------------- 「區域組合」搜尋（對應 JS 版的 buildPlan／runPlan／dfsT／tileT）
const NEG: f64 = f64::NEG_INFINITY;
const CBITS: usize = 52;
// 一塊／全部最多記幾個輪廓狀態（超過改用粗略輪廓；和 JS 版同樣的數字）
const COMP_CAP: usize = 40000;
const PROF_CAP: usize = 250000;
const SEED_NODES: u64 = 3000;

impl Search {
    fn seed(&mut self) {
        self.in_plan = false;
        self.nodes0 = self.nodes;
        self.bail = false;
        self.node_limit = self.nodes + SEED_NODES;
        self.dfs_zone(0);
        self.bail = false;
        self.node_limit = u64::MAX;
    }
    fn search(&mut self) {
        self.in_plan = false;
        if !self.plan_ok {
            self.dfs_zone(0);
            return;
        }
        // 先用舊版搜尋跑一小段，拿到一個起點（JS 版 runPlan 開頭）。原生多執行緒時主執行緒已經跑過（skip_seed）
        if !self.skip_seed {
            self.seed();
        }
        if self.stop {
            return;
        }
        self.in_plan = true;
        if false {
        } else if self.sink.is_some() {
            self.run_plan_shared();
        } else {
            self.run_plan();
        }
    }

    /// 原生多執行緒用：把所有區域組合會用到的塊與輪廓先算好（之後各執行緒唯讀共用，不用各算一份）
    #[cfg(not(target_arch = "wasm32"))]
    fn warm(&mut self) {
        let k1 = self.max_pieces + 1;
        // 最寬鬆的輪廓：至少一顆、效能取全庫存最高的幾顆（任何還沒蓋滿的狀態都適用）
        let mut rr = vec![NEG; k1];
        let mut acc = 0.0;
        for k in 1..k1 {
            if k > self.g_e.len() {
                break;
            }
            acc += self.g_e[k - 1];
            rr[k] = acc;
        }
        let hh = vec![-1i32; self.w];
        self.free_idx = self.add_prof(&rr, &hh);
        let mut parts: Vec<u32> = Vec::new();
        for i in 0..self.masks.len() {
            if self.rbs[i] <= self.best_val + 1e-9 {
                break; // 依上界排序過：起點解已經贏過的組合之後不會被搜到，不用準備
            }
            parts.clear();
            self.split_into(self.masks[i], &mut parts);
            for q in 0..parts.len() {
                let ci = self.comp_of(parts[q]);
                self.root_of(ci);
            }
        }
        // 超過狀態上限（或格子太多）的塊：把各種「還剩幾格」的粗略輪廓備好
        let capped = self.store.pmin.len() >= PROF_CAP;
        for ci in 0..self.store.comps.len() {
            if capped || self.store.comps[ci].big || self.store.comps[ci].n_states >= COMP_CAP {
                for unc in 1..=self.store.comps[ci].cells.len() {
                    self.resid_big(ci, unc);
                }
            }
        }
    }

    /// 把一組區域（位元遮罩）拆成互相牽連的塊（JS 版 splitInto）
    fn split_into(&self, mask_b: u32, out: &mut Vec<u32>) {
        let mut rest = mask_b;
        while rest != 0 {
            let low = rest & rest.wrapping_neg();
            let mut comp = low;
            let mut front = low;
            while front != 0 {
                let b = front.trailing_zeros() as usize;
                front &= front - 1;
                let add = self.sp_mask[b] & mask_b & !comp;
                comp |= add;
                front |= add;
            }
            out.push(comp);
            rest &= !comp;
        }
    }
    /// 取得（沒有就建立）一塊（JS 版 compOf）
    fn comp_of(&mut self, mask: u32) -> usize {
        if let Some(&i) = self.store.comp_idx.get(&mask) {
            return i;
        }
        let mut c = Comp { color: 0, big: false, cells: Vec::new(), cell_bit: vec![-1i8; self.n_cells], zpos: Vec::new(), all: 0, memo: PairMap::default(), memo_big: FxMap::default(), root: -1, n_states: 0 };
        for pos in 0..self.order.len() {
            if mask & (1u32 << pos) == 0 {
                continue;
            }
            let z = &self.zones[self.order[pos]];
            c.zpos.push(pos);
            c.color = z.color;
            for &cell in &z.cells {
                if c.cell_bit[cell] >= 0 || c.cells.len() >= CBITS {
                    c.big = true;
                } else {
                    c.cell_bit[cell] = c.cells.len() as i8;
                }
                c.cells.push(cell);
            }
        }
        if !c.big {
            for i in 0..c.cells.len() {
                c.all |= 1u64 << i;
            }
        }
        let ci = self.store.comps.len();
        let st = Arc::get_mut(&mut self.store).expect("輪廓表已共用，不能再新增塊");
        st.comps.push(c);
        st.comp_idx.insert(mask, ci);
        ci
    }
    fn add_prof(&mut self, rr: &[f64], hh: &[i32]) -> usize {
        let k1 = self.max_pieces + 1;
        let mut lo = k1;
        let mut hi: i32 = -1;
        for k in 0..k1 {
            if rr[k] != NEG {
                if lo > k {
                    lo = k;
                }
                hi = k as i32;
            }
        }
        let idx = self.store.pmin.len();
        let st = Arc::get_mut(&mut self.store).expect("輪廓表已共用，不能再新增輪廓");
        st.prof.extend_from_slice(rr);
        st.hull.extend_from_slice(hh);
        st.pmin.push(lo);
        st.pmax.push(hi);
        idx
    }
    /// 鋪法輪廓（JS 版 resid）：把格子 m 全部蓋滿、恰好再用 k 顆，最多能拿到的效能總和。回傳輪廓索引
    fn resid(&mut self, ci: usize, m: u64, o: u64) -> usize {
        if m == 0 {
            return 0;
        }
        if let Some(&i) = self.store.comps[ci].memo.get(&(m, o)) {
            return i as usize;
        }
        if self.frozen {
            // 共用的表裡沒有（主執行緒算的時候超過狀態上限）→ 用粗略輪廓，不新增
            return self.resid_big(ci, m.count_ones() as usize);
        }
        if self.store.comps[ci].n_states >= COMP_CAP || self.store.pmin.len() >= PROF_CAP {
            let ix = self.resid_big(ci, m.count_ones() as usize);
            Arc::get_mut(&mut self.store).unwrap().comps[ci].memo.insert((m, o), ix as u32);
            return ix;
        }
        Arc::get_mut(&mut self.store).unwrap().comps[ci].n_states += 1;
        let k1 = self.max_pieces + 1;
        let kk = self.max_pieces;
        let w = self.w;
        let mut rr = vec![NEG; k1];
        let mut hh = vec![0i32; w];
        let color = self.store.comps[ci].color;
        let lkey = self.store.comps[ci].cells[m.trailing_zeros() as usize] * 5 + color;
        let len = self.cover_by[lkey].len();
        for i in 0..len {
            let pid = self.cover_by[lkey][i];
            let mut pm: u64 = 0;
            {
                let cb = &self.store.comps[ci].cell_bit;
                for &cell in &self.pl[pid].cells {
                    let bb = cb[cell];
                    if bb >= 0 {
                        pm |= 1u64 << bb;
                    }
                }
            }
            if !self.allow_overlap && (pm & o) != 0 {
                continue;
            }
            let e = self.stacks[self.pl[pid].s].effs[0];
            let ci2 = self.resid(ci, m & !pm, if self.allow_overlap { 0 } else { o | pm });
            if self.store.pmax[ci2] < 0 {
                continue; // 這樣放之後剩下的格子蓋不滿
            }
            let base = ci2 * k1;
            for k in 0..kk {
                let v = self.store.prof[base + k];
                if v != NEG && e + v > rr[k + 1] {
                    rr[k + 1] = e + v;
                }
            }
            for q in 0..w {
                hh[q] |= self.pl_mask[pid * w + q] | self.store.hull[ci2 * w + q];
            }
        }
        for k in 0..=kk {
            let c = self.ctop[color * k1 + k];
            if rr[k] > c {
                rr[k] = c;
            }
        }
        let idx = self.add_prof(&rr, &hh);
        Arc::get_mut(&mut self.store).unwrap().comps[ci].memo.insert((m, o), idx as u32);
        idx
    }
    /// 格子太多的塊的粗略輪廓（JS 版 residBig）
    fn resid_big(&mut self, ci: usize, unc: usize) -> usize {
        if unc == 0 {
            return 0;
        }
        if let Some(&i) = self.store.comps[ci].memo_big.get(&(unc as u64)) {
            return i as usize;
        }
        if self.frozen {
            return self.free_idx; // 連粗略輪廓都沒備好（不該發生）→ 用最寬鬆的
        }
        let k1 = self.max_pieces + 1;
        let color = self.store.comps[ci].color;
        let mut rr = vec![NEG; k1];
        let kmin = (unc as f64 / self.max_size[color] as f64).ceil() as usize;
        for k in kmin..=self.max_pieces {
            rr[k] = self.ctop[color * k1 + k];
        }
        let hh = vec![-1i32; self.w];
        let idx = self.add_prof(&rr, &hh);
        Arc::get_mut(&mut self.store).unwrap().comps[ci].memo_big.insert(unc as u64, idx as u32);
        idx
    }
    /// 有效懲罰下界：「區域組合」搜尋中用這個組合的免除（lb_t），舊版搜尋用全部區域的（lb_eff）
    #[inline]
    fn lb_x(&self, o: i32, v: i32, d: i32, u: i32) -> i32 {
        if self.in_plan {
            self.lb_t(o, v, d, u)
        } else {
            self.lb_eff(o, v, d, u)
        }
    }
    #[inline]
    fn lb_t(&self, o: i32, v: i32, d: i32, u: i32) -> i32 {
        ((o - self.tw[1]).max(0) + (v - self.tw[2]).max(0) + (d - self.tw[0]).max(0) + (u - self.tw[3]).max(0) - self.tw[4]).max(0)
    }
    /// 一塊從頭開始（都還沒蓋）的輪廓（JS 版 rootOf）
    fn root_of(&mut self, ci: usize) -> usize {
        if self.store.comps[ci].root < 0 {
            let r = if self.store.comps[ci].big {
                let unc = self.store.comps[ci].cells.len();
                self.resid_big(ci, unc)
            } else {
                let all = self.store.comps[ci].all;
                self.resid(ci, all, 0)
            };
            if self.frozen {
                return r;
            }
            Arc::get_mut(&mut self.store).unwrap().comps[ci].root = r as i64;
        }
        self.store.comps[ci].root as usize
    }
    fn setup_t(&mut self, mask: u32) {
        self.cur_t = mask;
        self.ut = 0.0;
        // gw：乖離、過載、重疊、整體、超界 → tw：乖離、過載、重疊、超界、整體
        self.tw = [self.gw[0], self.gw[1], self.gw[2], self.gw[4], self.gw[3]];
        let mut isl: u32 = 0;
        for pos in 0..self.order.len() {
            if mask & (1u32 << pos) == 0 {
                continue;
            }
            let zid = self.order[pos];
            self.ut += self.zones[zid].u;
            isl |= self.z_isl[pos];
            let wv = self.zones[zid].waive;
            if wv > 0 {
                match self.zones[zid].wtype {
                    1 => self.tw[1] += wv,
                    2 => self.tw[2] += wv,
                    3 => self.tw[4] += wv,
                    4 => self.tw[3] += wv,
                    _ => self.tw[0] += wv,
                }
            }
        }
        self.isl_t = if self.isl_ok { isl.count_ones() as i32 } else { 1 };
        let mut parts: Vec<u32> = Vec::new();
        self.split_into(mask, &mut parts);
        self.n_tc = parts.len();
        for q in 0..parts.len() {
            let ci = self.comp_of(parts[q]);
            self.t_comp[q] = ci;
            self.c_used[q] = false;
        }
        // 每一塊的「可行的第一顆」（JS 版 setupT 後半）
        self.v_buf.clear();
        let d_i = (self.isl_t - 1).max(0);
        let mp = self.max_pieces;
        let w = self.w;
        let _ = w;
        for q in 0..self.n_tc {
            let ci = self.t_comp[q];
            self.v_start[q] = self.v_buf.len();
            if self.store.comps[ci].big || self.n_tc < 2 {
                self.v_len[q] = -1;
                continue;
            }
            self.sxv[0] = 0.0;
            for j in 1..=mp {
                self.sxv[j] = if j <= self.g_e.len() { self.sxv[j - 1] + self.g_e[j - 1] } else { NEG };
            }
            for q2 in 0..self.n_tc {
                if q2 != q {
                    let r2 = self.root_of(self.t_comp[q2]);
                    self.conv(3, 0, r2, mp);
                }
            }
            let color = self.store.comps[ci].color;
            let all = self.store.comps[ci].all;
            let lkey = self.store.comps[ci].cells[0] * 5 + color;
            let len = self.cover_by[lkey].len();
            for k in 0..len {
                let pid = self.cover_by[lkey][k];
                if !self.allow_overlap && (self.blk[pid] & mask) != 0 {
                    continue;
                }
                let mut pm: u64 = 0;
                {
                    let cbit = &self.store.comps[ci].cell_bit;
                    for &cell in &self.pl[pid].cells {
                        let bb = cbit[cell];
                        if bb >= 0 {
                            pm |= 1u64 << bb;
                        }
                    }
                }
                let ri = self.resid(ci, all & !pm, if self.allow_overlap { 0 } else { pm });
                let e = self.stacks[self.pl[pid].s].effs[0];
                if !self.cb(ri, 3, 0, 1, e, 0, if self.pl[pid].out { 1 } else { 0 }, d_i) {
                    continue;
                }
                self.v_buf.push(pid);
            }
            self.v_len[q] = (self.v_buf.len() - self.v_start[q]) as i32;
        }
    }
    /// 塊 ci 的格子目前哪些已經被同色粒子蓋住
    fn c_state(&self, ci: usize) -> u64 {
        let c = &self.store.comps[ci];
        let b = c.color * self.w;
        let mut cv: u64 = 0;
        for (i, &cell) in c.cells.iter().enumerate() {
            if self.cov[b + (cell >> 5)] & (1i32 << (cell & 31)) != 0 {
                cv |= 1u64 << i;
            }
        }
        cv
    }
    fn c_prof(&mut self, ci: usize) -> usize {
        if self.store.comps[ci].big {
            let mut unc = 0;
            for i in 0..self.store.comps[ci].zpos.len() {
                let pos = self.store.comps[ci].zpos[i];
                unc += self.zone_uncovered(self.order[pos]);
            }
            return self.resid_big(ci, unc);
        }
        let cv = self.c_state(ci);
        let m = self.store.comps[ci].all & !cv;
        self.resid(ci, m, if self.allow_overlap { 0 } else { cv })
    }
    /// 上界檢查的核心（JS 版 cb）。which：0＝SX0、1＝SX1、2＝SXA
    fn cb(&self, ri: usize, which: u8, ti: usize, n1: usize, se1: f64, ov1: i32, out1: i32, d: i32) -> bool {
        let k1 = self.max_pieces + 1;
        let rb = ri * k1;
        let sb = ti * k1;
        let sx: &[f64] = match which {
            0 => &self.sx0,
            1 => &self.sx1,
            3 => &self.sxv,
            _ => &self.sxa,
        };
        let lo = self.store.pmin[ri];
        let hi = self.store.pmax[ri];
        let kr = self.max_pieces - n1;
        let target = self.bound() + 1e-9;
        let mut t = lo;
        while t <= kr {
            let mut y = NEG;
            let mut k = lo;
            while (k as i32) <= hi && k <= t {
                let rv = self.store.prof[rb + k];
                if rv != NEG {
                    let av = sx[sb + t - k];
                    if av != NEG && av + rv > y {
                        y = av + rv;
                    }
                }
                k += 1;
            }
            if y != NEG {
                let nn = n1 + t;
                if nn != 0 {
                    let over = if nn as i32 > self.limit { nn as i32 - self.limit } else { 0 };
                    let p = self.lb_t(over, ov1, d, out1);
                    if p < self.cap && (self.ut * ((se1 + y) / nn as f64) / 100.0) * self.mult[p as usize] > target {
                        return true;
                    }
                }
            }
            t += 1;
        }
        false
    }
    /// 已放好的粒子群裡，有幾群之後鋪區域的粒子不可能碰到（JS 版 strand）
    fn strand(&self, ti: usize, ri: usize, pid: i64) -> i32 {
        let w = self.w;
        let hb = ri * w;
        let ob = ti * w;
        let any = ri != 0 || self.oth[ti];
        let mut cnt = 0;
        let base = self.n * self.cw;
        let nc = self.cm_n[self.n];
        if pid < 0 {
            for j in 0..nc {
                let o = base + j * w;
                let mut t = false;
                for q in 0..w {
                    if self.cm[o + q] & (self.store.hull[hb + q] | self.ho[ob + q]) != 0 {
                        t = true;
                        break;
                    }
                }
                if !t {
                    cnt += 1;
                }
            }
            return cnt;
        }
        let pb = pid as usize * w;
        let mut link = false;
        for q in 0..w {
            if (self.pl_mask[pb + q] | self.pl_nb[pb + q]) & (self.store.hull[hb + q] | self.ho[ob + q]) != 0 {
                link = true;
                break;
            }
        }
        for j in 0..nc {
            let o = base + j * w;
            let mut tp = false;
            let mut th = false;
            for q in 0..w {
                let x = self.cm[o + q];
                if x & self.pl_mask[pb + q] != 0 {
                    tp = true;
                }
                if x & (self.store.hull[hb + q] | self.ho[ob + q]) != 0 {
                    th = true;
                }
            }
            if tp {
                if th {
                    link = true;
                }
            } else if !th {
                cnt += 1;
            }
        }
        cnt + if any && !link { 1 } else { 0 }
    }
    fn can_beat(&self, ti: usize, ri: usize, n1: usize, se1: f64, ov1: i32, out1: i32, d_i: i32, pid: i64) -> bool {
        if !self.cb(ri, 2, ti, n1, se1, ov1, out1, d_i) {
            return false;
        }
        let d_c = self.strand(ti, ri, pid);
        if d_c <= d_i {
            return true;
        }
        self.cb(ri, 0, ti, n1, se1, ov1, out1, d_c) || self.cb(ri, 1, ti, n1, se1, ov1, out1, d_i)
    }
    /// 把輪廓 ri 併進合併輪廓（JS 版 conv）。which：0＝SX0、1＝SX1、3＝sxv（ti 傳 0）
    fn conv(&mut self, which: u8, ti: usize, ri: usize, kr: usize) {
        let k1 = self.max_pieces + 1;
        let rb = ri * k1;
        let sb = ti * k1;
        let lo = self.store.pmin[ri];
        let hi = self.store.pmax[ri];
        for j in 0..=kr {
            let mut b = NEG;
            let mut k = lo;
            while (k as i32) <= hi && k <= j {
                let rv = self.store.prof[rb + k];
                if rv != NEG {
                    let av = match which {
                        0 => self.sx0[sb + j - k],
                        1 => self.sx1[sb + j - k],
                        _ => self.sxv[sb + j - k],
                    };
                    if av != NEG && av + rv > b {
                        b = av + rv;
                    }
                }
                k += 1;
            }
            self.cv_tmp[j] = b;
        }
        for j in 0..=kr {
            match which {
                0 => self.sx0[sb + j] = self.cv_tmp[j],
                1 => self.sx1[sb + j] = self.cv_tmp[j],
                _ => self.sxv[sb + j] = self.cv_tmp[j],
            }
        }
    }
    #[inline]
    fn d_isl(&self, ai: i32) -> i32 {
        (ai.max(self.isl_t) - 1).max(0)
    }

    /// 組合裡的區域都鋪完了：計分，再看要不要補額外粒子（JS 版 leafT）
    fn leaf_t(&mut self) {
        if !(self.n > 0 && (!self.has_base || self.base_met())) {
            return;
        }
        self.st[0] += 1.0;
        self.eval_current();
        let k = self.max_pieces as i32 - self.n as i32;
        if k <= 0 {
            return;
        }
        let d = self.d_isl(self.active_isl);
        let target = self.bound() + 1e-9;
        let mut sum = self.sum_eff;
        let mut cnt = 0;
        let mut ok = false;
        let mut i = 0;
        while i < self.g_e.len() && cnt < k {
            if self.g_j[i] < self.used[self.g_s[i]] {
                i += 1;
                continue;
            }
            cnt += 1;
            sum += self.g_e[i];
            let nn = self.n as i32 + cnt;
            let p = self.lb_t(if nn > self.limit { nn - self.limit } else { 0 }, self.ov, d, self.out_n);
            if p < self.cap && (self.ut * (sum / nn as f64) / 100.0) * self.mult[p as usize] > target {
                ok = true;
                break;
            }
            i += 1;
        }
        if !ok {
            return;
        }
        self.st[2] += 1.0;
        let u = self.current_u();
        let mut visited = FxSet::default();
        self.extras_rec(k, &mut visited, u, 0, 0);
    }

    /// 選下一塊來鋪（JS 版 dfsT）：挑「還放得下的可行第一顆」最少的；有任何一塊已經沒有可行的第一顆 → 剪掉
    fn dfs_t(&mut self, ti: usize) {
        if self.stop || self.bail {
            return;
        }
        self.tick();
        let w = self.w;
        let mut bq: i64 = -1;
        let mut bc: i64 = 0x7fff_ffff;
        for q in 0..self.n_tc {
            if self.c_used[q] {
                continue;
            }
            let mut cnt: i64 = 0x7fff_fffe;
            let len = self.v_len[q];
            if len >= 0 {
                if self.allow_overlap {
                    cnt = len as i64;
                } else {
                    cnt = 0;
                    let mut x = self.v_start[q];
                    let xe = x + len as usize;
                    while x < xe && cnt < bc {
                        let pb = self.v_buf[x] * w;
                        let mut hit = false;
                        for k in 0..w {
                            if self.occ[k] & self.pl_mask[pb + k] != 0 {
                                hit = true;
                                break;
                            }
                        }
                        if !hit {
                            cnt += 1;
                        }
                        x += 1;
                    }
                }
                if cnt == 0 {
                    self.st[4] += 1.0;
                    return;
                }
            }
            if cnt < bc {
                bc = cnt;
                bq = q as i64;
            }
        }
        if bq < 0 {
            self.leaf_t();
            return;
        }
        let bq = bq as usize;
        if self.n >= self.max_pieces {
            return;
        }
        let kr = self.max_pieces - self.n;
        let k1 = self.max_pieces + 1;
        let sb = ti * k1;
        // 其餘隨便放的粒子：剩餘庫存裡效能最高的 x 顆。sx0 = 一顆都不放、sx1 = 至少放一顆
        self.sx0[sb] = 0.0;
        self.sx1[sb] = NEG;
        let mut cnt = 0;
        let mut acc = 0.0;
        let mut i = 0;
        while i < self.g_e.len() && cnt < kr {
            if self.g_j[i] < self.used[self.g_s[i]] {
                i += 1;
                continue;
            }
            cnt += 1;
            acc += self.g_e[i];
            self.sx1[sb + cnt] = acc;
            self.sx0[sb + cnt] = NEG;
            i += 1;
        }
        for j in (cnt + 1)..=kr {
            self.sx1[sb + j] = NEG;
            self.sx0[sb + j] = NEG;
        }
        // 併入其他還沒鋪的塊的輪廓（都還沒動過，所以是「從頭開始」的輪廓）
        let mut oth = false;
        for q in 0..w {
            self.ho[ti * w + q] = 0;
        }
        for q in 0..self.n_tc {
            if self.c_used[q] || q == bq {
                continue;
            }
            let ri = self.root_of(self.t_comp[q]);
            oth = true;
            self.conv(0, ti, ri, kr);
            self.conv(1, ti, ri, kr);
            for x in 0..w {
                self.ho[ti * w + x] |= self.store.hull[ri * w + x];
            }
        }
        self.oth[ti] = oth;
        for j in 0..=kr {
            let a = self.sx0[sb + j];
            let b = self.sx1[sb + j];
            self.sxa[sb + j] = if a > b { a } else { b };
        }
        let cc = self.t_comp[bq];
        let ri = self.root_of(cc);
        let d_i = self.d_isl(self.active_isl);
        if !self.can_beat(ti, ri, self.n, self.sum_eff, self.ov, self.out_n, d_i, -1) {
            self.st[4] += 1.0;
            return;
        }
        self.c_used[bq] = true;
        let all = self.store.comps[cc].all;
        self.tile_t(ti, cc, all, 0);
        self.c_used[bq] = false;
    }

    /// 鋪塊 cc（JS 版 tileT）：每次挑它還沒蓋到的第一格，試所有蓋得到的同色擺放。m＝還沒蓋的格子、o＝已蓋的格子
    fn tile_t(&mut self, ti: usize, cc: usize, m: u64, o: u64) {
        if self.stop || self.bail {
            return;
        }
        let big = self.store.comps[cc].big;
        let color = self.store.comps[cc].color;
        let w = self.w;
        let mut c: i64 = -1;
        if big {
            'outer: for x in 0..self.store.comps[cc].zpos.len() {
                let zid = self.order[self.store.comps[cc].zpos[x]];
                for &ci in &self.zones[zid].cells {
                    if self.cov[color * w + (ci >> 5)] & (1i32 << (ci & 31)) == 0 {
                        c = ci as i64;
                        break 'outer;
                    }
                }
            }
        } else if m != 0 {
            c = self.store.comps[cc].cells[m.trailing_zeros() as usize] as i64;
        }
        if c < 0 {
            self.dfs_t(ti + 1);
            return;
        }
        if self.n >= self.max_pieces {
            return;
        }
        self.st[1] += 1.0;
        let key = (c as usize) * 5 + color;
        let len = self.cover_by[key].len();
        let mut seq = 0usize;
        loop {
            let k;
            if self.n == 0 && self.use_claim {
                // 原生多執行緒（最後一輪）：第一顆粒子的候選擺放由各執行緒輪流領
                k = match &self.sink {
                    Some(sk) => sk.next_k[self.cur_sub].fetch_add(1, Ordering::AcqRel),
                    None => len,
                };
            } else {
                k = seq;
                seq += 1;
            }
            if k >= len {
                break;
            }
            if self.n == 0 && !self.use_claim && self.split_m > 1 && k % self.split_m != self.split_k {
                continue; // 平行搜尋：第一顆粒子的候選擺放輪流分給各份
            }
            let pid = self.cover_by[key][k];
            let si = self.pl[pid].s;
            if self.used[si] >= self.stacks[si].effs.len() {
                continue;
            }
            if !self.allow_overlap && (self.blk[pid] & self.cur_t) != 0 {
                continue; // 會蓋到組合裡別色區域的格子 → 那個區域永遠填不滿
            }
            let ovl = self.overlap_of(pid);
            if ovl != 0 && !self.allow_overlap {
                continue;
            }
            if big {
                self.apply(pid, ovl);
                let ri = self.c_prof(cc);
                let d_i = self.d_isl(self.active_isl);
                if !self.can_beat(ti, ri, self.n, self.sum_eff, self.ov, self.out_n, d_i, -1) {
                    self.st[5] += 1.0;
                    self.undo();
                    continue;
                }
                self.tick();
                if self.stop || self.bail {
                    self.undo();
                    return;
                }
                self.tile_t(ti, cc, 0, 0);
                self.undo();
                continue;
            }
            let mut pm: u64 = 0;
            {
                let cb = &self.store.comps[cc].cell_bit;
                for &cell in &self.pl[pid].cells {
                    let bb = cb[cell];
                    if bb >= 0 {
                        pm |= 1u64 << bb;
                    }
                }
            }
            let m2 = m & !pm;
            let o2 = if self.allow_overlap { 0 } else { o | pm };
            let ri = self.resid(cc, m2, o2);
            let isl = self.island_of[self.pl[pid].cells[0]];
            let ai = self.active_isl + if self.isl_cnt[isl] == 0 { 1 } else { 0 };
            let e = self.stacks[si].effs[self.used[si]];
            let out1 = self.out_n + if self.pl[pid].out { 1 } else { 0 };
            if !self.can_beat(ti, ri, self.n + 1, self.sum_eff + e, self.ov + ovl, out1, self.d_isl(ai), pid as i64) {
                self.st[5] += 1.0;
                continue;
            }
            self.apply(pid, ovl);
            self.tick();
            if self.stop || self.bail {
                self.undo();
                return;
            }
            self.tile_t(ti, cc, m2, o2);
            self.undo();
        }
    }

    /// 依上界由大到小搜每個區域組合；節點額度逐輪放大（JS 版 runPlan，節點數與結果完全一樣）
    fn run_plan(&mut self) {
        let nodes0 = self.nodes0;
        let n_c = self.masks.len();
        let mut fin = vec![false; n_c];
        // 舊版搜尋穿插著跑（JS 版 maybeLegacy）
        let mut legacy_spent: u64 = self.nodes - nodes0;
        let mut legacy_next: u64 = SEED_NODES * 8;
        let mut setups: u64 = 0;
        let mut budget: u64 = 2000;
        let mut done = false;
        while !self.stop && !done {
            let mut pending = 0;
            let mut i = 0;
            while i < n_c && !self.stop {
                if self.rbs[i] <= self.best_val + 1e-9 {
                    break;
                }
                if fin[i] {
                    i += 1;
                    continue;
                }
                self.setup_t(self.masks[i]);
                setups += 1;
                self.bail = false;
                self.node_limit = self.nodes + budget;
                self.dfs_t(0);
                if self.stop {
                    break;
                }
                if self.bail {
                    pending += 1;
                } else {
                    fin[i] = true;
                }
                if (self.nodes - nodes0 - legacy_spent) + 30 * setups >= 8 * legacy_next {
                    let st = self.nodes;
                    self.in_plan = false;
                    self.bail = false;
                    self.node_limit = self.nodes + legacy_next;
                    self.dfs_zone(0);
                    legacy_spent += self.nodes - st;
                    legacy_next *= 2;
                    self.in_plan = true;
                    if !self.stop && !self.bail {
                        done = true;
                        break;
                    }
                    self.bail = false;
                }
                i += 1;
            }
            if pending == 0 {
                break;
            }
            budget *= 8;
        }
        self.bail = false;
        self.node_limit = u64::MAX;
    }

    /// 原生多執行緒版：前幾輪（有節點額度）每個組合由一個執行緒整個認領；
    /// 最後一輪（不限額度）所有執行緒照順序走過每個組合，第一顆粒子的候選擺放輪流領，共用最佳值。
    fn run_plan_shared(&mut self) {
        let sink = match &self.sink {
            Some(s) => s.clone(),
            None => return,
        };
        let n_c = self.masks.len();
        let mut budget: u64 = 2000;
        for pass in 1..=3u32 {
            let mut pending = false;
            for i in 0..n_c {
                if self.stop {
                    break;
                }
                if self.rbs[i] <= self.bound() + 1e-9 {
                    break;
                }
                if sink.fin[i].load(Ordering::Acquire) {
                    continue;
                }
                let mut claimed = false;
                loop {
                    let s = sink.stage[i].load(Ordering::Acquire);
                    if s >= pass {
                        break;
                    }
                    if sink.stage[i].compare_exchange(s, pass, Ordering::AcqRel, Ordering::Acquire).is_ok() {
                        claimed = true;
                        break;
                    }
                }
                if !claimed {
                    pending = true;
                    continue;
                }
                self.setup_t(self.masks[i]);
                self.bail = false;
                self.use_claim = false;
                self.node_limit = self.nodes + budget;
                self.dfs_t(0);
                if self.stop {
                    break;
                }
                if self.bail {
                    pending = true;
                } else {
                    sink.fin[i].store(true, Ordering::Release);
                }
            }
            if self.stop || !pending {
                self.bail = false;
                self.node_limit = u64::MAX;
                return;
            }
            budget *= 8;
        }
        self.bail = false;
        self.node_limit = u64::MAX;
        self.use_claim = true;
        for i in 0..n_c {
            if self.stop {
                break;
            }
            if self.rbs[i] <= self.bound() + 1e-9 {
                break;
            }
            if sink.fin[i].load(Ordering::Acquire) {
                continue;
            }
            self.cur_sub = i;
            self.setup_t(self.masks[i]);
            self.dfs_t(0);
        }
        self.use_claim = false;
    }
}

struct Rd<'a> {
    v: &'a [i32],
    p: usize,
}
impl<'a> Rd<'a> {
    fn i(&mut self) -> i32 {
        let x = self.v[self.p];
        self.p += 1;
        x
    }
    fn u(&mut self) -> usize {
        self.i() as usize
    }
    fn vec(&mut self, n: usize) -> Vec<i32> {
        let s = self.v[self.p..self.p + n].to_vec();
        self.p += n;
        s
    }
}
struct Rf<'a> {
    v: &'a [f64],
    p: usize,
}
impl<'a> Rf<'a> {
    fn f(&mut self) -> f64 {
        let x = self.v[self.p];
        self.p += 1;
        x
    }
}

/// 執行搜尋。`flags`：1＝回報進度、2＝回報改進、4＝詢問 should_stop。回傳 0＝完成（結果在輸出緩衝區）。
/// 資料格式見 `src/solver_wasm.js` 的 `marshal()`。
#[no_mangle]
pub extern "C" fn run(ints_ptr: usize, ints_len: usize, fl_ptr: usize, fl_len: usize, time_limit_ms: f64, flags: i32, split_k: i32, split_m: i32) -> i32 {
    let ints: &[i32] = unsafe { std::slice::from_raw_parts(ints_ptr as *const i32, ints_len) };
    let fls: &[f64] = unsafe { std::slice::from_raw_parts(fl_ptr as *const f64, fl_len) };
    let mut s = build(ints, fls, time_limit_ms, flags, split_k, split_m, None);
    s.search();
    s.write_out();
    0
}

/// 原生版的搜尋結果
#[cfg(not(target_arch = "wasm32"))]
pub struct Outcome {
    pub best: Option<Vec<(usize, f64)>>,
    pub best_val: f64,
    pub nodes: u64,
    pub stop: bool,
    pub st: [f64; 6],
}

/// 原生多執行緒搜尋：`threads` 個執行緒共用最佳值、動態認領第一層候選擺放。`print`：每次全域最佳改進時印一行 `I 值 節點數 pid:效能,…`。
#[cfg(not(target_arch = "wasm32"))]
pub fn solve_native(ints: &[i32], fls: &[f64], threads: usize, time_limit_ms: f64, print: bool) -> Outcome {
    let threads = threads.max(1);
    // 先解析一次，算出各層第一顆粒子的候選數，建立認領表
    let t_start = host::now();
    let mut probe = build(ints, fls, time_limit_ms, 0, 0, 1, None);
    let mut claims: Vec<Vec<AtomicBool>> = Vec::new();
    for zi in 0..probe.order.len() {
        let z = &probe.zones[probe.order[zi]];
        let len = if z.cells.is_empty() { 0 } else { probe.cover_by[z.cells[0] * 5 + z.color].len() };
        claims.push((0..len).map(|_| AtomicBool::new(false)).collect());
    }
    let n_c = if probe.plan_ok { probe.masks.len() } else { 0 };
    // 主執行緒先用舊版搜尋跑一小段拿起點解，再把「上界比起點解高」的區域組合會用到的輪廓算好，給各執行緒共用
    let mut seed_best: Option<Vec<(usize, f64)>> = None;
    let mut seed_val = 0.0;
    let mut seed_nodes = 0u64;
    let mut seed_stop = false;
    if probe.plan_ok {
        probe.seed();
        seed_val = probe.best_val;
        seed_best = probe.best.take();
        seed_nodes = probe.nodes;
        seed_stop = probe.stop;
        probe.warm();
    }
    let store = probe.store.clone();
    let free_idx = probe.free_idx;
    let shared = probe.plan_ok;
    drop(probe);
    let sink = Arc::new(Sink {
        best: AtomicU64::new(seed_val.to_bits()),
        claims,
        stage: (0..n_c).map(|_| AtomicU32::new(0)).collect(),
        fin: (0..n_c).map(|_| AtomicBool::new(false)).collect(),
        next_k: (0..n_c).map(|_| AtomicUsize::new(0)).collect(),
        lock: Mutex::new(()),
        print,
    });
    if print {
        if let Some(b) = &seed_best {
            let list: Vec<String> = b.iter().map(|&(pid, e)| format!("{}:{}", pid, e)).collect();
            println!("I {} {} {}", seed_val, seed_nodes, list.join(","));
            use std::io::Write;
            let _ = std::io::stdout().flush();
        }
    }
    let results: Vec<(Option<Vec<(usize, f64)>>, f64, u64, bool, [f64; 6])> = std::thread::scope(|sc| {
        let hs: Vec<_> = (0..threads)
            .map(|_| {
                let sink = sink.clone();
                let store = store.clone();
                sc.spawn(move || {
                    let used = host::now() - t_start;
                    let mut s = build(ints, fls, (time_limit_ms - used).max(1.0), 0, 0, 1, Some(sink));
                    if shared {
                        s.store = store;
                        s.frozen = true;
                        s.free_idx = free_idx;
                        s.skip_seed = true;
                    }
                    s.search();
                    (s.best.take(), s.best_val, s.nodes, s.stop, s.st)
                })
            })
            .collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let mut out = Outcome { best: seed_best, best_val: seed_val, nodes: seed_nodes, stop: seed_stop, st: [0.0; 6] };
    for (b, v, n, stp, st) in results {
        out.nodes += n;
        out.stop |= stp;
        for i in 0..6 {
            out.st[i] += st[i];
        }
        let better = match (&out.best, &b) {
            (None, Some(_)) => true,
            (Some(cur), Some(nb)) => v > out.best_val + 1e-9 || ((v - out.best_val).abs() <= 1e-9 && nb.len() < cur.len()),
            _ => false,
        };
        if better {
            out.best = b;
            out.best_val = v;
        }
    }
    out
}

fn build(ints: &[i32], fls: &[f64], time_limit_ms: f64, flags: i32, split_k: i32, split_m: i32, sink: Option<Arc<Sink>>) -> Search {
    let mut r = Rd { v: ints, p: 0 };
    let mut f = Rf { v: fls, p: 0 };

    let n_cells = r.u();
    let w = r.u();
    let n_zones = r.u();
    let n_stacks = r.u();
    let n_pl = r.u();
    let limit = r.i();
    let allow_overlap = r.i() != 0;
    let cap = r.i();
    let max_pieces = r.u();
    let mut max_size = [1usize; 5];
    for c in 0..5 {
        max_size[c] = r.u();
    }
    let wd = r.i();
    let wo = r.i();
    let wv = r.i();
    let wa = r.i();
    let wu = r.i();
    let gw = [r.i(), r.i(), r.i(), r.i(), r.i()];
    let n_order = r.u();
    let order: Vec<usize> = (0..n_order).map(|_| r.u()).collect();
    let n_isl = r.u();
    let island_of: Vec<usize> = (0..n_cells).map(|_| r.u()).collect();
    let nb_cell = r.vec(n_cells * w);
    let n_must = r.u();
    let must_idx: Vec<usize> = (0..n_must).map(|_| r.u()).collect();

    // 浮點數：懲罰倍率表、基礎攻防門檻
    let n_mult = f.f() as usize;
    let mult: Vec<f64> = (0..n_mult).map(|_| f.f()).collect();
    let min_a = f.f();
    let min_d = f.f();

    let mut zones: Vec<Zone> = Vec::with_capacity(n_zones);
    for _ in 0..n_zones {
        let color = r.u();
        let must = r.i() != 0;
        let waive = r.i();
        let wtype = r.i() as u8;
        let nc = r.u();
        let cells: Vec<usize> = (0..nc).map(|_| r.u()).collect();
        let mask = r.vec(w);
        let atk = f.f();
        let def = f.f();
        let u = f.f();
        zones.push(Zone { color, must, waive, wtype, cells, mask, atk, def, u });
    }
    let mut stacks: Vec<Stack> = Vec::with_capacity(n_stacks);
    for _ in 0..n_stacks {
        let ne = r.u();
        let effs: Vec<f64> = (0..ne).map(|_| f.f()).collect();
        stacks.push(Stack { effs });
    }
    let mut pl: Vec<Pl> = Vec::with_capacity(n_pl);
    let mut pl_mask: Vec<i32> = Vec::with_capacity(n_pl * w);
    let mut pl_nb: Vec<i32> = Vec::with_capacity(n_pl * w);
    for _ in 0..n_pl {
        let s = r.u();
        let color = r.u();
        let out = r.i() != 0;
        let nc = r.u();
        let cells: Vec<usize> = (0..nc).map(|_| r.u()).collect();
        pl_mask.extend_from_slice(&r.v[r.p..r.p + w]);
        r.p += w;
        pl_nb.extend_from_slice(&r.v[r.p..r.p + w]);
        r.p += w;
        pl.push(Pl { s, color, out, cells });
    }
    let mut cover_by: Vec<Vec<usize>> = Vec::with_capacity(n_cells * 5);
    for _ in 0..n_cells * 5 {
        let len = r.u();
        cover_by.push((0..len).map(|_| r.u()).collect());
    }
    let mut by_stack: Vec<Vec<usize>> = Vec::with_capacity(n_stacks);
    for _ in 0..n_stacks {
        let len = r.u();
        by_stack.push((0..len).map(|_| r.u()).collect());
    }

    // 「區域組合」搜尋的計畫（src/solver_wasm.js 的 marshal() 最後一段；flags 的 8 = 強制用舊版搜尋）
    let k1 = max_pieces + 1;
    let n_ord = order.len();
    let mut plan_ok = r.p < r.v.len() && r.i() != 0;
    let mut sp_mask: Vec<u32> = Vec::new();
    let mut blk: Vec<u32> = Vec::new();
    let mut z_isl: Vec<u32> = Vec::new();
    let mut isl_ok = false;
    let mut ctop: Vec<f64> = Vec::new();
    let mut masks: Vec<u32> = Vec::new();
    let mut rbs: Vec<f64> = Vec::new();
    if plan_ok {
        sp_mask = (0..n_ord).map(|_| r.i() as u32).collect();
        z_isl = (0..n_ord).map(|_| r.i() as u32).collect();
        isl_ok = r.i() != 0;
        blk = (0..n_pl).map(|_| r.i() as u32).collect();
        let n_c = r.u();
        masks = (0..n_c).map(|_| r.i() as u32).collect();
        ctop = (0..5 * k1).map(|_| f.f()).collect();
        rbs = (0..n_c).map(|_| f.f()).collect();
    }
    if (flags & 8) != 0 {
        plan_ok = false;
    }
    let mut prof = vec![f64::NEG_INFINITY; k1];
    prof[0] = 0.0;

    // 剩餘庫存中效能最高的 k 顆（平均效能上界用）：效能由高到低，同效能照堆疊內的順序
    let mut tmp: Vec<(f64, usize, usize)> = Vec::new();
    for (si, s) in stacks.iter().enumerate() {
        for (j, &e) in s.effs.iter().enumerate() {
            tmp.push((e, si, j));
        }
    }
    tmp.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then(a.2.cmp(&b.2)));
    let g_e: Vec<f64> = tmp.iter().map(|t| t.0).collect();
    let g_s: Vec<usize> = tmp.iter().map(|t| t.1).collect();
    let g_j: Vec<usize> = tmp.iter().map(|t| t.2).collect();

    // 去重用的 Zobrist 雜湊（和 JS 版同一個亂數序列）
    let mut zs: i32 = 987_654_321;
    let mut zr = || -> i32 {
        zs = zs.wrapping_mul(1_103_515_245).wrapping_add(12_345) & 0x7fff_ffff;
        zs
    };
    let mut z1 = vec![0i64; n_pl];
    let mut z2 = vec![0i64; n_pl];
    for i in 0..n_pl {
        let a = zr().wrapping_shl(11) ^ zr();
        z1[i] = (a & 0x03ff_ffff) as i64;
        let b = zr().wrapping_shl(11) ^ zr();
        z2[i] = (b & 0x03ff_ffff) as i64;
    }

    // 額外粒子用的索引（JS 版 stackLink／stackCells）
    let mut lk = vec![0i32; n_stacks * n_cells * w];
    let mut sc_cnt = vec![0usize; n_stacks * n_cells + 1];
    for si in 0..n_stacks {
        for &pid in &by_stack[si] {
            for &c in &pl[pid].cells {
                let o = (si * n_cells + c) * w;
                for q in 0..w {
                    lk[o + q] |= pl_mask[pid * w + q];
                }
                sc_cnt[si * n_cells + c + 1] += 1;
            }
        }
    }
    let mut sc_start = vec![0usize; n_stacks * n_cells + 1];
    for i in 0..n_stacks * n_cells {
        sc_start[i + 1] = sc_start[i] + sc_cnt[i + 1];
    }
    let mut sc_fill = sc_start.clone();
    let mut sc_list = vec![0usize; sc_start[n_stacks * n_cells]];
    for si in 0..n_stacks {
        for &pid in &by_stack[si] {
            for &c in &pl[pid].cells {
                let i = si * n_cells + c;
                sc_list[sc_fill[i]] = pid;
                sc_fill[i] += 1;
            }
        }
    }
    let waive_z: Vec<usize> = (0..zones.len()).filter(|&i| zones[i].waive > 0).collect();
    let mp = max_pieces;
    let t0 = host::now();
    let s = Search {
        n_cells,
        w,
        limit,
        allow_overlap,
        cap,
        max_pieces,
        max_size,
        wd,
        wo,
        wv,
        wu,
        wa,
        gw,
        has_w: wd + wo + wv + wu + wa > 0,
        order,
        island_of,
        nb_cell,
        zones,
        waive_z,
        must_idx,
        stacks,
        pl,
        pl_mask,
        pl_nb,
        cover_by,
        by_stack,
        mult,
        min_a,
        min_d,
        has_base: min_a > 0.0 || min_d > 0.0,
        g_e,
        g_s,
        g_j,
        z1,
        z2,
        lv: vec![Vec::new(); n_pl],
        occ: vec![0; w],
        cov: vec![0; 5 * w],
        snap_occ: (0..=mp + 1).map(|_| vec![0i32; w]).collect(),
        snap_cov: (0..=mp + 1).map(|_| vec![0i32; 5 * w]).collect(),
        pcs: vec![0; mp + 2],
        eff_of: vec![0.0; mp + 2],
        ov_arr: vec![0; mp + 2],
        used: vec![0; n_stacks],
        n: 0,
        sum_eff: 0.0,
        ov: 0,
        out_n: 0,
        isl_cnt: vec![0; n_isl.max(1)],
        active_isl: 0,
        par: vec![0; mp + 2],
        comp_of: vec![0; mp + 2],
        col_tmp: [Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new()],
        dp_a: vec![0.0; mp + 2],
        dp_b: vec![0.0; mp + 2],
        tb: vec![0.0; mp + 2],
        nodes: 0,
        stop: false,
        best_val: 0.0,
        best: None,
        t0,
        last_prog: t0,
        time_limit: time_limit_ms,
        flags,
        sink,
        split_k: split_k.max(0) as usize,
        split_m: split_m.max(1) as usize,
        st: [0.0; 6],
        plan_ok,
        sp_mask,
        blk,
        z_isl,
        isl_ok,
        ctop,
        masks,
        rbs,
        store: Arc::new(Store { comps: Vec::new(), comp_idx: HashMap::new(), prof, pmin: vec![0], pmax: vec![0], hull: vec![0; w] }),
        frozen: false,
        free_idx: 0,
        cur_t: 0,
        ut: 0.0,
        tw: [0; 5],
        isl_t: 1,
        c_used: vec![false; n_ord],
        v_start: vec![0; n_ord],
        v_len: vec![0; n_ord],
        v_buf: Vec::new(),
        sxv: vec![0.0; k1],
        lk,
        sc_start,
        sc_list,
        x_stamp: vec![0; n_pl],
        x_stamp_id: 0,
        t_comp: vec![0; n_ord],
        n_tc: 0,
        sx0: vec![0.0; (n_ord + 1) * k1],
        sx1: vec![0.0; (n_ord + 1) * k1],
        sxa: vec![0.0; (n_ord + 1) * k1],
        ho: vec![0; (n_ord + 1) * w],
        oth: vec![false; n_ord + 1],
        cv_tmp: vec![0.0; k1],
        bail: false,
        node_limit: u64::MAX,
        cur_sub: 0,
        use_claim: false,
        in_plan: false,
        nodes0: 0,
        skip_seed: false,
        cw: (mp + 2) * w,
        cm_n: vec![0; mp + 3],
        cm: vec![0; (mp + 3) * (mp + 2) * w],
    };
    s
}
