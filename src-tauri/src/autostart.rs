use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AutostartStatus {
    pub enabled: bool,
    pub packaged_msix: bool,
    pub registry_value: String,
    pub command: Option<String>,
    pub note: String,
}

const RUN_SUBKEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const TEST_IDENTIFIER: &str = "pl.tracker.personal.testonly";
pub const AUTOSTART_FLAG: &str = "--autostart";

pub fn value_name(identifier: &str) -> &'static str {
    if identifier == TEST_IDENTIFIER {
        "TrackerMasterTest"
    } else {
        "TrackerMaster"
    }
}

pub fn format_run_command(exe_path: &Path) -> Result<String, String> {
    let text = exe_path
        .to_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Nie można ustalić ścieżki programu do autostartu.".to_string())?;
    if text.contains('\0') || text.contains('\r') || text.contains('\n') || text.contains('"') {
        return Err("Ścieżka programu zawiera znaki niedozwolone w wpisie autostartu.".into());
    }
    Ok(format!("\"{text}\" {AUTOSTART_FLAG}"))
}

pub fn launched_via_autostart<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().any(|arg| arg.as_ref() == AUTOSTART_FLAG)
}

#[cfg(windows)]
mod platform {
    use super::{format_run_command, AutostartStatus};
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt, path::Path, ptr};
    use windows_sys::Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS},
        System::Registry::{
            RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW,
            RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_EXPAND_SZ,
            REG_OPTION_NON_VOLATILE, REG_SZ,
        },
    };

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentPackageFullName(
            package_full_name_length: *mut u32,
            package_full_name: *mut u16,
        ) -> i32;
    }

    pub fn is_packaged_msix() -> bool {
        let mut len: u32 = 0;
        let rc = unsafe { GetCurrentPackageFullName(&mut len, ptr::null_mut()) };
        // ERROR_INSUFFICIENT_BUFFER (122) or ERROR_SUCCESS (0) means running inside an MSIX identity.
        rc == 0 || rc == 122
    }

    fn to_wide(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(Some(0)).collect()
    }

    struct RegKey(HKEY);
    impl Drop for RegKey {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    RegCloseKey(self.0);
                }
            }
        }
    }

    fn open_key(subkey: &str, access: u32) -> Result<Option<RegKey>, i32> {
        let wide = to_wide(subkey);
        let mut handle: HKEY = ptr::null_mut();
        let rc = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, wide.as_ptr(), 0, access, &mut handle) };
        if rc == ERROR_FILE_NOT_FOUND {
            Ok(None)
        } else if rc == ERROR_SUCCESS {
            Ok(Some(RegKey(handle)))
        } else {
            Err(rc as i32)
        }
    }

    fn create_key(subkey: &str, access: u32) -> Result<RegKey, i32> {
        let wide = to_wide(subkey);
        let mut handle: HKEY = ptr::null_mut();
        let rc = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                wide.as_ptr(),
                0,
                ptr::null(),
                REG_OPTION_NON_VOLATILE,
                access,
                ptr::null(),
                &mut handle,
                ptr::null_mut(),
            )
        };
        if rc == ERROR_SUCCESS {
            Ok(RegKey(handle))
        } else {
            Err(rc as i32)
        }
    }

    fn query_string(key: &RegKey, name: &str) -> Result<Option<String>, String> {
        let name_w = to_wide(name);
        let mut value_type: u32 = 0;
        let mut bytes: u32 = 0;
        let rc = unsafe {
            RegQueryValueExW(
                key.0,
                name_w.as_ptr(),
                ptr::null(),
                &mut value_type,
                ptr::null_mut(),
                &mut bytes,
            )
        };
        if rc == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if rc != ERROR_SUCCESS {
            return Err("Nie udało się odczytać wpisu autostartu w rejestrze Windows.".into());
        }
        if value_type != REG_SZ && value_type != REG_EXPAND_SZ {
            return Err("Wpis autostartu w rejestrze ma nieprawidłowy typ.".into());
        }
        let words = ((bytes as usize) + 1) / 2;
        let mut buf = vec![0u16; words.max(1)];
        let mut actual_bytes = (buf.len() * 2) as u32;
        let rc2 = unsafe {
            RegQueryValueExW(
                key.0,
                name_w.as_ptr(),
                ptr::null(),
                &mut value_type,
                buf.as_mut_ptr().cast::<u8>(),
                &mut actual_bytes,
            )
        };
        if rc2 != ERROR_SUCCESS {
            return Err("Nie udało się odczytać wartości autostartu Windows.".into());
        }
        let unit_count = (actual_bytes as usize) / 2;
        let trimmed = buf[..unit_count.min(buf.len())]
            .split(|&c| c == 0)
            .next()
            .unwrap_or(&[]);
        Ok(Some(String::from_utf16_lossy(trimmed)))
    }

    fn msix_note(packaged: bool) -> String {
        if packaged {
            "Wersja pakietowa MSIX (Store): wpis HKCU\\Run działa klasycznie dla bieżącego użytkownika, a rzeczywiste uruchamianie przy logowaniu dla pakietu Store zależy od deklaracji StartupTask oraz zgody w Ustawieniach Windows (Aplikacje → Autostart).".into()
        } else {
            "Dotyczy tylko bieżącego użytkownika (HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run). Otwarcie aplikacji przez autostart nigdy nie rozpoczyna pomiaru czasu; w wersji Store MSIX autostart wymaga ustawień pakietu StartupTask.".into()
        }
    }

    pub fn read_status(subkey: &str, name: &str) -> Result<AutostartStatus, String> {
        let packaged_msix = is_packaged_msix();
        let command = match open_key(subkey, KEY_READ) {
            Ok(Some(key)) => query_string(&key, name)?,
            Ok(None) => None,
            Err(_) => {
                return Err("Nie udało się otworzyć ustawień autostartu w rejestrze Windows.".into());
            }
        };
        Ok(AutostartStatus {
            enabled: command.as_deref().is_some_and(|v| !v.trim().is_empty()),
            packaged_msix,
            registry_value: name.to_string(),
            command,
            note: msix_note(packaged_msix),
        })
    }

    pub fn set_enabled(
        subkey: &str,
        name: &str,
        exe_path: &Path,
        enabled: bool,
    ) -> Result<AutostartStatus, String> {
        let packaged_msix = is_packaged_msix();
        if enabled {
            let cmd = format_run_command(exe_path)?;
            let cmd_w = to_wide(&cmd);
            let key = create_key(subkey, KEY_WRITE)
                .map_err(|_| "Nie udało się zapisać autostartu w rejestrze Windows.".to_string())?;
            let name_w = to_wide(name);
            let byte_len = u32::try_from(cmd_w.len() * 2)
                .map_err(|_| "Polecenie autostartu jest zbyt długie.".to_string())?;
            let rc = unsafe {
                RegSetValueExW(
                    key.0,
                    name_w.as_ptr(),
                    0,
                    REG_SZ,
                    cmd_w.as_ptr().cast::<u8>(),
                    byte_len,
                )
            };
            if rc != ERROR_SUCCESS {
                return Err("Nie udało się włączyć autostartu w rejestrze Windows.".into());
            }
            Ok(AutostartStatus {
                enabled: true,
                packaged_msix,
                registry_value: name.to_string(),
                command: Some(cmd),
                note: msix_note(packaged_msix),
            })
        } else {
            if let Some(key) = open_key(subkey, KEY_WRITE)
                .map_err(|_| "Nie udało się otworzyć rejestru autostartu Windows.".to_string())?
            {
                let name_w = to_wide(name);
                let rc = unsafe { RegDeleteValueW(key.0, name_w.as_ptr()) };
                if rc != ERROR_SUCCESS && rc != ERROR_FILE_NOT_FOUND {
                    return Err("Nie udało się wyłączyć autostartu w rejestrze Windows.".into());
                }
            }
            Ok(AutostartStatus {
                enabled: false,
                packaged_msix,
                registry_value: name.to_string(),
                command: None,
                note: msix_note(packaged_msix),
            })
        }
    }

    #[cfg(test)]
    pub fn delete_test_key(subkey: &str) {
        use windows_sys::Win32::System::Registry::RegDeleteKeyW;
        let wide = to_wide(subkey);
        unsafe {
            RegDeleteKeyW(HKEY_CURRENT_USER, wide.as_ptr());
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::AutostartStatus;
    use std::path::Path;

    pub fn read_status(_subkey: &str, name: &str) -> Result<AutostartStatus, String> {
        Ok(AutostartStatus {
            enabled: false,
            packaged_msix: false,
            registry_value: name.to_string(),
            command: None,
            note: "Autostart Windows jest dostępny wyłącznie w systemie Windows.".into(),
        })
    }

    pub fn set_enabled(
        _subkey: &str,
        _name: &str,
        _exe_path: &Path,
        _enabled: bool,
    ) -> Result<AutostartStatus, String> {
        Err("Autostart Windows jest dostępny wyłącznie w systemie Windows.".into())
    }
}

#[tauri::command]
pub fn get_autostart(app: tauri::AppHandle) -> Result<AutostartStatus, String> {
    let name = value_name(&app.config().identifier);
    platform::read_status(RUN_SUBKEY, name)
}

#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<AutostartStatus, String> {
    if option_env!("VITE_TRACKER_TEST_MODE") == Some("1")
        && app.config().identifier == TEST_IDENTIFIER
    {
        use tauri::Manager as _;
        if let Ok(dir) = app.path().app_data_dir() {
            let marker = dir.join("fail-autostart-once.flag");
            if marker.exists() {
                let _ = std::fs::remove_file(&marker);
                return Err("Symulowany błąd zapisu autostartu w trybie testowym.".into());
            }
        }
    }
    let name = value_name(&app.config().identifier);
    let exe = std::env::current_exe()
        .map_err(|_| "Nie można odczytać ścieżki aplikacji TrackerMaster.".to_string())?;
    platform::set_enabled(RUN_SUBKEY, name, &exe, enabled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn formats_and_validates_run_command() {
        let cmd = format_run_command(Path::new(r"C:\Program Files\TrackerMaster\tracker-master.exe"))
            .unwrap();
        assert_eq!(
            cmd,
            "\"C:\\Program Files\\TrackerMaster\\tracker-master.exe\" --autostart"
        );
        assert!(format_run_command(Path::new("")).is_err());
        assert!(format_run_command(Path::new("bad\"path.exe")).is_err());
        assert!(format_run_command(Path::new("bad\npath.exe")).is_err());
        assert_eq!(value_name("pl.tracker.personal"), "TrackerMaster");
        assert_eq!(value_name("pl.tracker.personal.testonly"), "TrackerMasterTest");
        assert!(launched_via_autostart(["tracker-master.exe", "--autostart"]));
        assert!(!launched_via_autostart(["tracker-master.exe"]));
    }

    #[cfg(windows)]
    #[test]
    fn windows_hkcu_run_toggle_persists_and_cleans_up() {
        let pid = std::process::id();
        let subkey = format!("Software\\TrackerMasterUnitTest\\Autostart_{pid}");
        let name = value_name("pl.tracker.personal.testonly");
        let exe = PathBuf::from(r"C:\Apps\Tracker Master\tracker-master.exe");
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                platform::delete_test_key(&self.0);
                platform::delete_test_key("Software\\TrackerMasterUnitTest");
            }
        }
        let _cleanup = Cleanup(subkey.clone());

        let initial = platform::read_status(&subkey, name).unwrap();
        assert!(!initial.enabled);
        assert_eq!(initial.command, None);

        let enabled = platform::set_enabled(&subkey, name, &exe, true).unwrap();
        assert!(enabled.enabled);
        assert_eq!(
            enabled.command.as_deref(),
            Some("\"C:\\Apps\\Tracker Master\\tracker-master.exe\" --autostart")
        );

        let read_back = platform::read_status(&subkey, name).unwrap();
        assert!(read_back.enabled);
        assert_eq!(read_back.command, enabled.command);

        let disabled = platform::set_enabled(&subkey, name, &exe, false).unwrap();
        assert!(!disabled.enabled);
        assert_eq!(disabled.command, None);

        let after_disable = platform::read_status(&subkey, name).unwrap();
        assert!(!after_disable.enabled);
        assert_eq!(after_disable.command, None);
    }
}
