use sha2::{Digest, Sha256};
use std::{
    io,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
    ptr, thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SHARING_VIOLATION, HANDLE, WAIT_OBJECT_0},
    System::Threading::{
        CreateEventW, OpenEventW, SetEvent, WaitForSingleObject, EVENT_MODIFY_STATE, INFINITE,
    },
};

pub(super) const SHARING_VIOLATION: i32 = ERROR_SHARING_VIOLATION as i32;

pub(super) enum Startup {
    Primary {
        guard: super::InstanceGuard,
        activation: Activation,
    },
    Activated,
}

pub(super) struct Activation(OwnedHandle);

fn own_event(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    // Each successful CreateEventW or OpenEventW transfers a handle to this process.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

pub(super) fn start(dir: &Path) -> io::Result<Startup> {
    let canonical = dir.canonicalize()?;
    let path_bytes: Vec<_> = canonical
        .as_os_str()
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect();
    let digest = Sha256::digest(path_bytes);
    let name: Vec<_> = format!("Local\\TrackerMaster.Show.{digest:x}")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let deadline = Instant::now() + Duration::from_secs(2);

    loop {
        match super::lock_instance(dir) {
            Ok(guard) => {
                // This auto-reset event retains a launch signal while the first window initializes.
                let event = own_event(unsafe { CreateEventW(ptr::null(), 0, 0, name.as_ptr()) })?;
                return Ok(Startup::Primary {
                    guard,
                    activation: Activation(event),
                });
            }
            Err(err) if err.raw_os_error() == Some(SHARING_VIOLATION) => {
                match own_event(unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr()) }) {
                    Ok(event) if unsafe { SetEvent(event.as_raw_handle()) } != 0 => {
                        return Ok(Startup::Activated);
                    }
                    Ok(_) => return Err(err),
                    Err(open_error)
                        if open_error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32)
                            && Instant::now() < deadline =>
                    {
                        // The first launch may hold the database guard before creating the event.
                        thread::sleep(Duration::from_millis(25));
                    }
                    Err(_) => return Err(err),
                }
            }
            Err(err) => return Err(err),
        }
    }
}

impl Activation {
    pub(super) fn listen(self, app: tauri::AppHandle) -> io::Result<()> {
        thread::Builder::new()
            .name("tracker-activate".into())
            .spawn(move || {
                while unsafe { WaitForSingleObject(self.0.as_raw_handle(), INFINITE) }
                    == WAIT_OBJECT_0
                {
                    // This listener is owned by the desktop process and waits without polling.
                    let _ = tauri::async_runtime::block_on(super::show_main(app.clone()));
                }
            })?;
        Ok(())
    }
}
