//! Bounded, graceful shutdown of a specific MPV process before another is launched.

use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::time::{Duration, Instant};

use tracing::{info, warn};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{ERROR_INVALID_PARAMETER, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, WriteFile, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_MODE, OPEN_EXISTING,
};
use windows::Win32::System::Pipes::{
    GetNamedPipeServerProcessId, SetNamedPipeHandleState, WaitNamedPipeW, PIPE_NOWAIT,
};
use windows::Win32::System::Threading::{
    OpenProcess, WaitForSingleObject, CREATE_NO_WINDOW, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE,
};

const GRACEFUL_EXIT_TIMEOUT: Duration = Duration::from_secs(8);
/// Without a delivered quit, only allow time for a player that is already closing.
const UNDELIVERED_QUIT_GRACE: Duration = Duration::from_secs(1);
const FORCED_EXIT_TIMEOUT: Duration = Duration::from_secs(8);
const TERMINATION_COMMAND_TIMEOUT: Duration = Duration::from_secs(3);

/// Decides whether a process that did not exit may be force-terminated.
type TerminationCheck = fn(HANDLE) -> Result<bool, String>;

#[derive(Debug, PartialEq, Eq)]
enum ShutdownMethod {
    AlreadyExited,
    Graceful,
    Forced,
}

fn raw_handle(handle: &OwnedHandle) -> HANDLE {
    HANDLE(handle.as_raw_handle())
}

fn open_process(pid: u32) -> Result<Option<OwnedHandle>, String> {
    if pid == 0 {
        return Err("Cannot stop MPV process with an empty PID".into());
    }
    match unsafe {
        OpenProcess(
            PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
            false,
            pid,
        )
    } {
        Ok(handle) => Ok(Some(unsafe { OwnedHandle::from_raw_handle(handle.0) })),
        Err(error) if error.code() == ERROR_INVALID_PARAMETER.to_hresult() => Ok(None),
        Err(error) => Err(format!("Could not monitor MPV process {pid}: {error}")),
    }
}

fn process_exited(process: &OwnedHandle) -> Result<bool, String> {
    match unsafe { WaitForSingleObject(raw_handle(process), 0) } {
        WAIT_OBJECT_0 => Ok(true),
        WAIT_TIMEOUT => Ok(false),
        _ => Err(format!(
            "Could not check MPV process exit: {}",
            windows::core::Error::from_win32()
        )),
    }
}

async fn wait_for_exit(process: &OwnedHandle, timeout: Duration) -> Result<bool, String> {
    let started = Instant::now();
    loop {
        if process_exited(process)? {
            return Ok(true);
        }
        if started.elapsed() >= timeout {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn request_quit(pid: u32, pipe_name: &str) -> Result<(), String> {
    let name: Vec<u16> = pipe_name.encode_utf16().chain(Some(0)).collect();
    if !unsafe { WaitNamedPipeW(PCWSTR(name.as_ptr()), 100) }.as_bool() {
        return Err("MPV shutdown pipe is unavailable".into());
    }
    let pipe = unsafe {
        CreateFileW(
            PCWSTR(name.as_ptr()),
            0xC0000000, // GENERIC_READ | GENERIC_WRITE
            FILE_SHARE_MODE(0),
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        )
    }
    .map_err(|error| format!("Could not open MPV shutdown pipe: {error}"))?;
    let pipe = unsafe { OwnedHandle::from_raw_handle(pipe.0) };
    let mut server_pid = 0;
    unsafe { GetNamedPipeServerProcessId(raw_handle(&pipe), &mut server_pid) }
        .map_err(|error| format!("Could not identify MPV shutdown pipe: {error}"))?;
    if server_pid != pid {
        return Err(format!(
            "MPV shutdown pipe belongs to process {server_pid}, expected {pid}"
        ));
    }

    // A stalled player must not block shutdown on a pipe write or reply read.
    unsafe { SetNamedPipeHandleState(raw_handle(&pipe), Some(&PIPE_NOWAIT), None, None) }
        .map_err(|error| format!("Could not bound MPV shutdown pipe writes: {error}"))?;
    let command = b"{\"command\":[\"quit\"]}\n";
    let mut written = 0;
    unsafe { WriteFile(raw_handle(&pipe), Some(command), Some(&mut written), None) }
        .map_err(|error| format!("Could not request MPV exit: {error}"))?;
    if written as usize != command.len() {
        return Err("MPV shutdown pipe did not accept the complete quit command".into());
    }
    // Process exit is the acknowledgement: MPV can close IPC before replying.
    Ok(())
}

pub async fn stop_process(pid: u32, pipe_name: &str) -> Result<(), String> {
    stop_process_with_timeout(
        pid,
        pipe_name,
        GRACEFUL_EXIT_TIMEOUT,
        crate::process_lifecycle::owns_process,
    )
    .await
    .map(|_| ())
}

async fn stop_process_with_timeout(
    pid: u32,
    pipe_name: &str,
    graceful_timeout: Duration,
    may_terminate: TerminationCheck,
) -> Result<ShutdownMethod, String> {
    // Keep the original process object alive so its PID cannot be reused while stopping it.
    let Some(process) = open_process(pid)? else {
        return Ok(ShutdownMethod::AlreadyExited);
    };
    if process_exited(&process)? {
        return Ok(ShutdownMethod::AlreadyExited);
    }
    let started = Instant::now();
    let pipe_name = pipe_name.to_string();
    let request = tokio::task::spawn_blocking(move || request_quit(pid, &pipe_name))
        .await
        .map_err(|error| format!("MPV shutdown request failed: {error}"))?;
    let exit_timeout = match request {
        Ok(()) => {
            info!(
                event = "mpv.shutdown.quit_requested",
                pid, "Requested graceful MPV exit"
            );
            graceful_timeout
        }
        Err(error) => {
            warn!(event = "mpv.shutdown.quit_unavailable", pid, %error, "Could not request graceful MPV exit; allowing brief time for it to close");
            graceful_timeout.min(UNDELIVERED_QUIT_GRACE)
        }
    };
    if wait_for_exit(&process, exit_timeout).await? {
        info!(
            event = "mpv.shutdown.process_exited",
            pid,
            forced = false,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "MPV process exited without forced termination"
        );
        return Ok(ShutdownMethod::Graceful);
    }

    // A PID the renderer kept from an earlier player can name an unrelated
    // process by now. Only terminate players Streamee launched.
    if !may_terminate(raw_handle(&process))? {
        warn!(
            event = "mpv.shutdown.force_refused",
            pid, "Process is not a player Streamee launched; not terminating it"
        );
        return Err(format!(
            "Process {pid} is not a player Streamee launched; it was not terminated"
        ));
    }
    warn!(
        event = "mpv.shutdown.force_required",
        pid, "MPV did not exit within the graceful deadline; terminating its process tree"
    );
    let mut command = tokio::process::Command::new("taskkill");
    command
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW.0)
        .kill_on_drop(true);
    let output = tokio::time::timeout(TERMINATION_COMMAND_TIMEOUT, command.output())
        .await
        .map_err(|_| format!("Timed out requesting termination of MPV process {pid}"))?
        .map_err(|error| format!("Failed to terminate MPV process {pid}: {error}"))?;
    if !output.status.success() && !process_exited(&process)? {
        return Err(format!(
            "Failed to terminate MPV process {pid}: {} {}",
            String::from_utf8_lossy(&output.stdout).trim(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if !wait_for_exit(&process, FORCED_EXIT_TIMEOUT).await? {
        return Err(format!(
            "MPV process {pid} is still running after termination; next playback was not started"
        ));
    }
    info!(
        event = "mpv.shutdown.process_exited",
        pid,
        forced = true,
        elapsed_ms = started.elapsed().as_millis() as u64,
        "MPV process exited after forced termination"
    );
    Ok(ShutdownMethod::Forced)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Child, Command, Stdio};
    use windows::Win32::Foundation::ERROR_PIPE_CONNECTED;
    use windows::Win32::Storage::FileSystem::{ReadFile, PIPE_ACCESS_DUPLEX};
    use windows::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, PIPE_TYPE_BYTE};

    struct Helper(Child);

    impl Drop for Helper {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn helper(mode: &str) -> (Helper, String) {
        use std::os::windows::process::CommandExt;
        let pipe = format!(r"\\.\pipe\streamee-shutdown-test-{}", uuid::Uuid::new_v4());
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "mpv_shutdown::tests::shutdown_fixture",
                "--nocapture",
            ])
            .env("STREAMEE_SHUTDOWN_TEST_PIPE", &pipe)
            .env("STREAMEE_SHUTDOWN_TEST_MODE", mode)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW.0)
            .spawn()
            .unwrap();
        let mut child = Helper(child);
        let mut output = BufReader::new(child.0.stdout.take().unwrap());
        let mut line = String::new();
        loop {
            assert!(
                output.read_line(&mut line).unwrap() > 0,
                "helper exited before ready"
            );
            if line.trim() == "shutdown-pipe-ready" {
                break;
            }
            line.clear();
        }
        // Keep stdout open for the child test harness's final result message.
        child.0.stdout = Some(output.into_inner());
        (child, pipe)
    }

    #[test]
    fn shutdown_fixture() {
        let Ok(pipe) = std::env::var("STREAMEE_SHUTDOWN_TEST_PIPE") else {
            return;
        };
        let name: Vec<u16> = pipe.encode_utf16().chain(Some(0)).collect();
        let pipe = unsafe {
            CreateNamedPipeW(
                PCWSTR(name.as_ptr()),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE,
                1,
                4096,
                4096,
                0,
                None,
            )
        };
        assert!(!pipe.is_invalid());
        let pipe = unsafe { OwnedHandle::from_raw_handle(pipe.0) };
        println!("shutdown-pipe-ready");
        std::io::stdout().flush().unwrap();
        if let Err(error) = unsafe { ConnectNamedPipe(raw_handle(&pipe), None) } {
            assert_eq!(error.code(), ERROR_PIPE_CONNECTED.to_hresult());
        }
        let mut bytes = [0u8; 128];
        let mut read = 0;
        unsafe { ReadFile(raw_handle(&pipe), Some(&mut bytes), Some(&mut read), None) }.unwrap();
        assert_eq!(&bytes[..read as usize], b"{\"command\":[\"quit\"]}\n");
        // Deliberately send no reply, including when the quit is accepted.
        if std::env::var("STREAMEE_SHUTDOWN_TEST_MODE").unwrap() == "ignore" {
            std::thread::sleep(Duration::from_secs(30));
        }
    }

    fn run<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    fn allow_termination(_: HANDLE) -> Result<bool, String> {
        Ok(true)
    }

    #[test]
    fn an_undelivered_quit_forces_after_a_short_grace() {
        // The helper waits on its own pipe, so a quit sent to this one never arrives.
        let (mut child, _pipe) = helper("ignore");
        let unused_pipe = format!(
            r"\\.\pipe\streamee-shutdown-unused-{}",
            uuid::Uuid::new_v4()
        );
        let started = Instant::now();
        assert_eq!(
            run(stop_process_with_timeout(
                child.0.id(),
                &unused_pipe,
                GRACEFUL_EXIT_TIMEOUT,
                allow_termination
            ))
            .unwrap(),
            ShutdownMethod::Forced
        );
        assert!(started.elapsed() >= UNDELIVERED_QUIT_GRACE);
        assert!(started.elapsed() < GRACEFUL_EXIT_TIMEOUT);
        assert!(!child.0.wait().unwrap().success());
    }

    #[test]
    fn a_process_streamee_did_not_launch_is_not_terminated() {
        let (mut child, pipe) = helper("ignore");
        let error = run(stop_process_with_timeout(
            child.0.id(),
            &pipe,
            Duration::from_millis(150),
            crate::process_lifecycle::owns_process,
        ))
        .unwrap_err();
        assert!(error.contains("not a player Streamee launched"), "{error}");
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "the process was terminated"
        );
    }

    #[test]
    fn graceful_exit_does_not_require_an_ipc_reply() {
        let (mut child, pipe) = helper("quit");
        assert_eq!(
            run(stop_process_with_timeout(
                child.0.id(),
                &pipe,
                Duration::from_secs(2),
                allow_termination
            ))
            .unwrap(),
            ShutdownMethod::Graceful
        );
        let status = child.0.wait().unwrap();
        let stderr = std::io::read_to_string(child.0.stderr.take().unwrap()).unwrap();
        assert_eq!(status.code(), Some(0), "{stderr}");
        assert_eq!(
            run(stop_process_with_timeout(
                child.0.id(),
                &pipe,
                Duration::ZERO,
                allow_termination
            ))
            .unwrap(),
            ShutdownMethod::AlreadyExited
        );
    }

    #[test]
    fn unresponsive_player_uses_bounded_forced_fallback() {
        let (mut child, pipe) = helper("ignore");
        let started = Instant::now();
        assert_eq!(
            run(stop_process_with_timeout(
                child.0.id(),
                &pipe,
                Duration::from_millis(150),
                allow_termination
            ))
            .unwrap(),
            ShutdownMethod::Forced
        );
        assert!(started.elapsed() >= Duration::from_millis(150));
        assert!(started.elapsed() < Duration::from_secs(6));
        assert!(!child.0.wait().unwrap().success());
    }

    #[test]
    fn quit_rejects_a_pipe_owned_by_a_different_process() {
        let (mut child, pipe) = helper("quit");
        let error = request_quit(std::process::id(), &pipe).unwrap_err();
        assert!(error.contains("belongs to process"), "{error}");
        // The mismatched player receives no quit command.
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(!status.success());
        }
    }

    #[test]
    fn zero_pid_is_rejected() {
        assert!(run(stop_process(0, r"\\.\pipe\unused")).is_err());
    }

    #[test]
    #[ignore = "Set STREAMEE_TEST_MPV_EXE to a local MPV executable"]
    fn real_mpv_exits_gracefully_on_an_isolated_pipe() {
        use std::os::windows::process::CommandExt;
        let executable = std::env::var_os("STREAMEE_TEST_MPV_EXE").expect("STREAMEE_TEST_MPV_EXE");
        let pipe = format!(
            r"\\.\pipe\streamee-shutdown-mpv-test-{}",
            uuid::Uuid::new_v4()
        );
        let mut child = Helper(
            Command::new(executable)
                .args([
                    "--no-config",
                    "--load-scripts=no",
                    "--idle=yes",
                    "--vo=null",
                    "--ao=null",
                    "--force-window=no",
                ])
                .arg(format!("--input-ipc-server={pipe}"))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW.0)
                .spawn()
                .unwrap(),
        );
        let name: Vec<u16> = pipe.encode_utf16().chain(Some(0)).collect();
        let started = Instant::now();
        while !unsafe { WaitNamedPipeW(PCWSTR(name.as_ptr()), 100) }.as_bool() {
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "MPV pipe did not start"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
        assert_eq!(
            run(stop_process_with_timeout(
                child.0.id(),
                &pipe,
                Duration::from_secs(3),
                allow_termination
            ))
            .unwrap(),
            ShutdownMethod::Graceful
        );
        assert_eq!(child.0.wait().unwrap().code(), Some(0));
    }
}
