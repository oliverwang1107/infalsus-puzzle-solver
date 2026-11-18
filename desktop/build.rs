// 把 icon.ico 與版本資訊嵌進 exe（檔案總管、工作列、Alt+Tab 看到的圖示）
fn main() {
    println!("cargo:rerun-if-changed=icon.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").map(|o| o == "windows").unwrap_or(false) {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("icon.ico");
        res.set("ProductName", "In Falsus 製卡最佳化");
        res.set("FileDescription", "In Falsus 製卡最佳化");
        res.set("LegalCopyright", "Unofficial fan tool");
        if let Err(e) = res.compile() { println!("cargo:warning=嵌入圖示失敗：{}", e); }
    }
}
