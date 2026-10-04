//! Keep playback helpers owned by the app, including their descendants.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

static STOPPING: AtomicBool = AtomicBool::new(false);
static JOB: Mutex<Option<Job>> = Mutex::new(None);

pub fn is_stopping() -> bool {
    STOPPING.load(Ordering::SeqCst)
}
pub fn begin_shutdown() {
    STOPPING.store(true, Ordering::SeqCst);
}

fn ensure_launch_allowed(job: &mut Option<Job>) -> Result<(), String> {
    if is_stopping() {
        return Err("Streamee is closing its playback helpers".into());
    }
    if job.is_none() {
        *job = Some(Job::new()?);
    }
    Ok(())
}

pub fn spawn_std(command: &mut std::process::Command) -> Result<std::process::Child, String> {
    let mut job = JOB.lock().map_err(|e| e.to_string())?;
    ensure_launch_allowed(&mut job)?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
        command.creation_flags(CREATE_NO_WINDOW.0 | CREATE_SUSPENDED.0);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    if let Err(error) = own_and_resume(job.as_mut().unwrap(), child.id()) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok(child)
}

pub fn spawn_tokio(command: &mut tokio::process::Command) -> Result<tokio::process::Child, String> {
    let mut job = JOB.lock().map_err(|e| e.to_string())?;
    ensure_launch_allowed(&mut job)?;
    command.kill_on_drop(true);
    #[cfg(windows)]
    {
        use windows::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
        command.creation_flags(CREATE_NO_WINDOW.0 | CREATE_SUSPENDED.0);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    if let Err(error) = own_and_resume(
        job.as_mut().unwrap(),
        child.id().ok_or("Helper exited during launch")?,
    ) {
        let _ = child.start_kill();
        return Err(error);
    }
    Ok(child)
}

fn own_and_resume(job: &mut Job, pid: u32) -> Result<(), String> {
    job.assign(pid)?;
    // Assign before the helper runs, so even immediate descendants inherit ownership.
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Diagnostics::ToolHelp::*;
        use windows::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0).map_err(|e| e.to_string())?;
        let result: Result<(), String> = (|| {
            let mut entry = THREADENTRY32 {
                dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
                ..Default::default()
            };
            Thread32First(snapshot, &mut entry).map_err(|e| e.to_string())?;
            loop {
                if entry.th32OwnerProcessID == pid {
                    let thread = OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID)
                        .map_err(|e| e.to_string())?;
                    let previous = ResumeThread(thread);
                    let _ = CloseHandle(thread);
                    if previous == u32::MAX {
                        return Err("Could not resume playback helper".into());
                    }
                    return Ok(());
                }
                if Thread32Next(snapshot, &mut entry).is_err() {
                    return Err("Could not locate playback helper thread".into());
                }
            }
        })();
        let _ = CloseHandle(snapshot);
        result?;
    }
    Ok(())
}

pub fn shutdown(timeout: Duration) -> Result<(), String> {
    begin_shutdown();
    let mut guard = JOB.lock().map_err(|e| e.to_string())?;
    if let Some(job) = guard.as_ref() {
        job.terminate()?;
        let started = Instant::now();
        while !job.finished()? {
            if started.elapsed() >= timeout {
                return Err(
                    "Playback helpers are still running; installation was not started".into(),
                );
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    *guard = None;
    Ok(())
}

pub fn resume() -> Result<(), String> {
    let mut guard = JOB.lock().map_err(|e| e.to_string())?;
    if !guard
        .as_ref()
        .map(Job::finished)
        .transpose()?
        .unwrap_or(true)
    {
        return Err("Playback helpers have not finished closing".into());
    }
    *guard = None;
    STOPPING.store(false, Ordering::SeqCst);
    Ok(())
}

#[cfg(windows)]
struct Job {
    handle: usize,
    processes: Vec<usize>,
}

#[cfg(windows)]
impl Job {
    fn handle(&self) -> windows::Win32::Foundation::HANDLE {
        windows::Win32::Foundation::HANDLE(self.handle as *mut std::ffi::c_void)
    }
    fn new() -> Result<Self, String> {
        use windows::Win32::System::JobObjects::*;
        let handle = unsafe { CreateJobObjectW(None, None) }.map_err(|e| e.to_string())?;
        let job = Self {
            handle: handle.0 as usize,
            processes: Vec::new(),
        };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of_val(&limits) as u32,
            )
        }
        .map_err(|e| e.to_string())?;
        Ok(job)
    }
    fn assign(&mut self, pid: u32) -> Result<(), String> {
        use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
        use windows::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SET_QUOTA, PROCESS_SYNCHRONIZE,
            PROCESS_TERMINATE,
        };
        self.processes.retain(|raw| unsafe {
            let handle = HANDLE(*raw as *mut std::ffi::c_void);
            if WaitForSingleObject(handle, 0) == WAIT_OBJECT_0 {
                let _ = CloseHandle(handle);
                false
            } else {
                true
            }
        });
        let process = unsafe {
            OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
                false,
                pid,
            )
        }
        .map_err(|e| format!("Cannot own playback helper {pid}: {e}"))?;
        let result = unsafe { AssignProcessToJobObject(self.handle(), process) };
        if result.is_ok() {
            self.processes.push(process.0 as usize);
        } else {
            unsafe {
                let _ = CloseHandle(process);
            }
        }
        result.map_err(|e| format!("Cannot own playback helper {pid}: {e}"))
    }
    fn terminate(&self) -> Result<(), String> {
        unsafe { windows::Win32::System::JobObjects::TerminateJobObject(self.handle(), 0) }
            .map_err(|e| e.to_string())
    }
    fn active_processes(&self) -> Result<u32, String> {
        use windows::Win32::System::JobObjects::*;
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        unsafe {
            QueryInformationJobObject(
                Some(self.handle()),
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as _,
                std::mem::size_of_val(&info) as u32,
                None,
            )
        }
        .map_err(|e| e.to_string())?;
        Ok(info.ActiveProcesses)
    }
    fn finished(&self) -> Result<bool, String> {
        use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
        use windows::Win32::System::Threading::WaitForSingleObject;
        // Job accounting can reach zero just before the process exit handle is signalled.
        Ok(self.active_processes()? == 0
            && self.processes.iter().all(|raw| unsafe {
                WaitForSingleObject(HANDLE(*raw as *mut std::ffi::c_void), 0) == WAIT_OBJECT_0
            }))
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.handle());
            for raw in self.processes.drain(..) {
                let _ = windows::Win32::Foundation::CloseHandle(
                    windows::Win32::Foundation::HANDLE(raw as *mut std::ffi::c_void),
                );
            }
        }
    }
}

#[cfg(not(windows))]
struct Job;
#[cfg(not(windows))]
impl Job {
    fn new() -> Result<Self, String> {
        Ok(Self)
    }
    fn assign(&mut self, _pid: u32) -> Result<(), String> {
        Ok(())
    }
    fn terminate(&self) -> Result<(), String> {
        Ok(())
    }
    fn finished(&self) -> Result<bool, String> {
        Ok(true)
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn abrupt_app_exit_terminates_owned_helpers() {
        use std::os::windows::process::CommandExt;
        use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
        use windows::Win32::System::Threading::{
            OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
            PROCESS_TERMINATE,
        };
        if std::env::var_os("STREAMEE_LIFECYCLE_EXIT_TEST_CHILD").is_some() {
            let mut command = std::process::Command::new("cmd.exe");
            command
                .args(["/d", "/c", "ping -n 30 127.0.0.1 >nul"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            let child = spawn_std(&mut command).unwrap();
            println!("helper_pid={}", child.id());
            std::thread::sleep(Duration::from_millis(100));
            // The Windows updater exits this way, skipping Rust destructors.
            std::process::exit(0);
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "process_lifecycle::tests::abrupt_app_exit_terminates_owned_helpers",
                "--nocapture",
            ])
            .env("STREAMEE_LIFECYCLE_EXIT_TEST_CHILD", "1")
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(output.status.success());
        let pid: u32 = String::from_utf8_lossy(&output.stdout)
            .lines()
            .find_map(|line| line.strip_prefix("helper_pid="))
            .unwrap()
            .parse()
            .unwrap();
        match unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, false, pid) } {
            Ok(handle) => {
                let stopped = unsafe { WaitForSingleObject(handle, 5_000) } == WAIT_OBJECT_0;
                if !stopped {
                    unsafe {
                        let _ = TerminateProcess(handle, 0);
                    }
                }
                unsafe {
                    let _ = CloseHandle(handle);
                }
                assert!(stopped, "Helper survived abrupt app exit");
            }
            Err(error) => assert_eq!(
                error.code().0,
                0x80070057u32 as i32,
                "Unexpected process query failure"
            ),
        }
    }

    #[test]
    fn job_closure_terminates_owned_helper() {
        use std::os::windows::process::CommandExt;
        let mut job = Job::new().unwrap();
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "ping -n 30 127.0.0.1 >nul"])
            .creation_flags(0x08000004)
            .spawn()
            .unwrap();
        own_and_resume(&mut job, child.id()).unwrap();
        let start = Instant::now();
        while job.active_processes().unwrap() < 2 {
            if start.elapsed() > Duration::from_secs(5) {
                panic!("Helper descendant did not inherit the job");
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        drop(job);
        let start = Instant::now();
        while child.try_wait().unwrap().is_none() {
            if start.elapsed() > Duration::from_secs(5) {
                let _ = child.kill();
                panic!("Owned helper survived job closure");
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    #[test]
    fn update_shutdown_blocks_new_helpers_until_cancelled() {
        // Run in a separate process so the shutdown gate cannot affect other tests.
        if std::env::var_os("STREAMEE_LIFECYCLE_TEST_CHILD").is_none() {
            use std::os::windows::process::CommandExt;
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "process_lifecycle::tests::update_shutdown_blocks_new_helpers_until_cancelled",
                    "--nocapture",
                ])
                .env("STREAMEE_LIFECYCLE_TEST_CHILD", "1")
                .creation_flags(0x08000000)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        let mut command = std::process::Command::new("cmd.exe");
        command.args(["/d", "/c", "ping -n 30 127.0.0.1 >nul"]);
        let mut child = spawn_std(&mut command).unwrap();
        shutdown(Duration::from_secs(5)).unwrap();
        assert!(child.try_wait().unwrap().is_some());
        assert!(spawn_std(&mut command).is_err());
        resume().unwrap();
        let mut child = spawn_std(&mut command).unwrap();
        shutdown(Duration::from_secs(5)).unwrap();
        assert!(child.try_wait().unwrap().is_some());
        resume().unwrap();
    }
}
