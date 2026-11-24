// Build profile for the MSIX packaging check (packaging/msix/New-TestMsix.ps1). Only a build with the
// isolated Tauri identifier (tauri.isolated.conf.json, passed by `tauri build --config` as TAURI_CONFIG)
// and VITE_TRACKER_TEST_MODE=1 is "testonly"; every other build is "production". The identifier text
// alone proves nothing: the production code contains it too.
const ISOLATED_IDENTIFIER: &str = "pl.tracker.personal.testonly";

fn identifier_in(json: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(json).ok()?.get("identifier")?.as_str().map(str::to_owned)
}

// Same order as tauri-build: tauri.conf.json, then the TAURI_CONFIG patch merged over it.
fn effective_identifier() -> Option<String> {
    let base = std::fs::read_to_string("tauri.conf.json").ok().and_then(|text| identifier_in(&text));
    match std::env::var("TAURI_CONFIG") {
        Ok(patch) => identifier_in(&patch).or(base),
        Err(_) => base,
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    println!("cargo:rerun-if-env-changed=VITE_TRACKER_TEST_MODE");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    let test_mode = matches!(std::env::var("VITE_TRACKER_TEST_MODE").as_deref(), Ok("1"));
    let isolated = effective_identifier().as_deref() == Some(ISOLATED_IDENTIFIER);
    let profile = if test_mode && isolated { "testonly" } else { "production" };
    println!("cargo:rustc-env=TRACKER_BUILD_PROFILE={profile}");
    tauri_build::build()
}
