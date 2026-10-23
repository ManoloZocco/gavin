//! Whether a workspace's agent will actually get gavin's tools.
//!
//! The setup wizard used to count Integration as done the moment the
//! agent file carried `<!-- gavin:start -->`. That block says nothing
//! about the MCP entry beside it, and the entry is the half that breaks:
//! outside the gavin checkout it names the ABSOLUTE `gavin-mcp` beside
//! the app that wrote it (`agent_setup::mcp_command`), so moving or
//! reinstalling the app leaves every workspace it set up naming a file
//! that is gone -- and the step stayed green while the agent ran with no
//! `gavin_*` tools at all (report 2026-10-22, §1).
//!
//! So this reads the entry the way the agent will and asks whether its
//! command would start. Read-only: nothing here writes, and a dead entry
//! is repaired by re-running `setup_agent_integration`, which already
//! rewrites gavin's key and nothing else.

use std::path::{Path, PathBuf};
use tauri::Manager as _;

use crate::agent_setup::{self, LocalFiles, WorkspaceFiles, MCP_LAUNCHER};

/// What the wizard's Integration step is told.
///
/// `runnable` is three-valued on purpose. `Some(true)`: the entry is
/// there and its command starts. `Some(false)`: it is missing, the file
/// does not parse, or the command cannot start -- `reason` says which.
/// `None`: gavin cannot tell from here (an ssh workspace, whose binary
/// is on the host; or a profile with no MCP file to read), and the
/// caller keeps the rule it had before this check existed.
#[derive(serde::Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpHealth {
    pub entry_present: bool,
    /// The command gavin's entry names, as written.
    pub command: Option<String>,
    pub runnable: Option<bool>,
    /// Why `runnable` is not `Some(true)`; `None` when it is.
    pub reason: Option<String>,
    /// The MCP config, relative to the root, when the profile has one.
    pub config_file: Option<String>,
}

impl McpHealth {
    fn unknown(reason: impl Into<String>, config_file: Option<String>) -> Self {
        McpHealth { entry_present: false, command: None, runnable: None, reason: Some(reason.into()), config_file }
    }
}

/// The machine the command would run on, as far as starting a program
/// goes. Injected so the launcher's search can be exercised for a
/// Windows host from a mac and without a real install anywhere.
pub(crate) struct ExecProbe {
    /// Whether that machine runs Windows: which launcher file runs and
    /// which candidate list it walks.
    pub windows: bool,
    /// What the launcher's FIRST candidate, `GAVIN_MCP`, will hold. A
    /// gavin session gets it from the daemon that spawned it -- the
    /// `gavin-mcp` beside the daemon, which ships beside this app
    /// (`pty.rs`'s `gavin_mcp_beside_this_binary`) -- so the local probe
    /// fills it from this process's own `GAVIN_MCP` when set and from the
    /// app's sibling binary otherwise. An agent started by hand in some
    /// other terminal gets no pin, and that is not what gavin is asking.
    pub gavin_mcp_pin: Option<PathBuf>,
    /// `$HOME`, for `~/Applications/Gavin.app`.
    pub home: Option<PathBuf>,
    /// `%LOCALAPPDATA%`, for the Windows installer's `Programs\Gavin`.
    pub local_app_data: Option<PathBuf>,
    /// `[ -x path ]` on unix; `if exist` on Windows.
    pub is_executable: Box<dyn Fn(&Path) -> bool + Send + Sync>,
    /// A bare name looked up on PATH.
    pub on_path: Box<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>,
}

impl ExecProbe {
    /// This machine.
    pub(crate) fn local() -> Self {
        let pin = std::env::var_os("GAVIN_MCP")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| agent_setup::resolve_mcp_binary_path().ok());
        ExecProbe {
            windows: cfg!(windows),
            gavin_mcp_pin: pin,
            home: crate::home::home_dir(),
            local_app_data: std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty()).map(PathBuf::from),
            is_executable: Box::new(crate::program::is_executable),
            on_path: Box::new(crate::program::resolve),
        }
    }
}

/// The launcher's candidates, in the launcher's order -- `scripts/gavin-mcp`
/// for unix and `scripts/gavin-mcp.cmd` for Windows, which "must keep the
/// same search order" and do not quite: the `.cmd` looks in the Windows
/// installer's directory where the sh script looks in the two macOS
/// Applications folders. Each list here is the one its own script walks.
/// PATH comes after all of them, in both, and is asked separately.
pub(crate) fn launcher_candidates(root: &Path, probe: &ExecProbe) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(pin) = &probe.gavin_mcp_pin {
        out.push(pin.clone());
    }
    if probe.windows {
        if let Some(local) = &probe.local_app_data {
            out.push(local.join("Programs").join("Gavin").join("gavin-mcp.exe"));
        }
        out.push(root.join("target").join("release").join("gavin-mcp.exe"));
        out.push(root.join("target").join("debug").join("gavin-mcp.exe"));
    } else {
        if let Some(home) = &probe.home {
            out.push(home.join("Applications/Gavin.app/Contents/MacOS/gavin-mcp"));
        }
        out.push(PathBuf::from("/Applications/Gavin.app/Contents/MacOS/gavin-mcp"));
        out.push(root.join("target").join("release").join("gavin-mcp"));
        out.push(root.join("target").join("debug").join("gavin-mcp"));
    }
    out
}

/// Whether `command`, as an MCP client would spawn it from `root`, starts.
/// `Err` is the sentence the step shows.
fn command_runnable(fs: &dyn WorkspaceFiles, root: &Path, command: &str, probe: &ExecProbe) -> Result<(), String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("gavin's entry names no command".to_string());
    }
    if command == MCP_LAUNCHER {
        if !fs.is_file(&agent_setup::launcher_file(root, probe.windows)) {
            return Err(format!("{MCP_LAUNCHER} is not in this checkout"));
        }
        let tried = launcher_candidates(root, probe);
        if tried.iter().any(|p| (probe.is_executable)(p)) || (probe.on_path)("gavin-mcp").is_some() {
            return Ok(());
        }
        let list = tried.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ");
        return Err(format!(
            "{MCP_LAUNCHER} finds no gavin-mcp binary (tried {list}, then PATH) — install Gavin or run `cargo build -p gavin-mcp`"
        ));
    }
    let as_path = Path::new(command);
    let separated = command.contains('/') || (probe.windows && command.contains('\\'));
    if as_path.is_absolute() || separated {
        // A relative path is spawned from the project root, which is the
        // cwd every MCP client gavin writes for starts its servers in.
        let path = if as_path.is_absolute() { as_path.to_path_buf() } else { root.join(as_path) };
        if (probe.is_executable)(&path) {
            return Ok(());
        }
        return Err(if fs.is_file(&path) {
            format!("{} is not executable", path.display())
        } else {
            format!("{} does not exist", path.display())
        });
    }
    match (probe.on_path)(command) {
        Some(_) => Ok(()),
        None => Err(format!("`{command}` is not on PATH")),
    }
}

/// The check, with the disk and the machine passed in.
///
/// `profile_id` is the profile the Integration step would write for --
/// absent, the root's own (`[agent] profile`, else `default_agent`), the
/// same resolution `setup_agent_integration` and `scan_foreign_mcp_servers`
/// make, so the step is asked about the file it would repair.
pub(crate) fn mcp_health_in(
    fs: &dyn WorkspaceFiles,
    root: &Path,
    profile_id: Option<&str>,
    default_agent: Option<&str>,
    probe: &ExecProbe,
) -> McpHealth {
    let profile_id = profile_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| agent_setup::resolved_profile_id_in(fs, root, default_agent));
    let profile = agent_setup::profile_for_writes(&profile_id);
    let Some(layout) = agent_setup::resolved_mcp(fs, root, profile) else {
        return McpHealth::unknown("this agent has no MCP config file set, so there is no entry to check", None);
    };
    let file = layout.config_file().to_string();
    let not_runnable = |reason: String, entry_present: bool, command: Option<String>| McpHealth {
        entry_present,
        command,
        runnable: Some(false),
        reason: Some(reason),
        config_file: Some(file.clone()),
    };
    // The no-mkdir containment: a check must not create the directory it
    // is looking in.
    let path = match agent_setup::check_contained_dest(root, Path::new(&file)) {
        Ok(path) => path,
        Err(e) => return not_runnable(e.to_string(), false, None),
    };
    if !fs.is_file(&path) {
        return not_runnable(format!("{file} does not exist"), false, None);
    }
    // The reader the foreign-server scan uses, so opencode's one-array
    // command and codex's TOML table come back the same shape as
    // everyone else's -- and an unparsable file is reported, not read
    // as empty.
    let servers = match agent_setup::mcp_servers_in(fs, &path, layout.format()) {
        Ok(servers) => servers,
        Err(e) => return not_runnable(e.to_string(), false, None),
    };
    let Some(entry) = servers.into_iter().find(|s| s.name == layout.server_key()) else {
        return not_runnable(format!("{file} has no {} entry", layout.server_key()), false, None);
    };
    match command_runnable(fs, root, &entry.command, probe) {
        Ok(()) => McpHealth {
            entry_present: true,
            command: Some(entry.command),
            runnable: Some(true),
            reason: None,
            config_file: Some(file),
        },
        Err(why) => not_runnable(why, true, Some(entry.command)),
    }
}

/// The Integration step's health check (lc-03).
///
/// An ssh workspace answers "unknown" without reading anything: the
/// command names a binary on the HOST, and whether that starts is a
/// question this desktop's disk cannot answer -- reading a same-spelled
/// path here would be answering about the wrong machine. The step then
/// keeps its marker rule for it.
///
/// Off the main thread: a PATH walk and a couple of file reads, on every
/// Home visit and every wizard reread.
#[tauri::command]
pub async fn mcp_health(
    root_path: String,
    profile_id: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<McpHealth, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if crate::remote::host_for_root(&crate::remote::workspaces(&app_handle), &root_path).is_some() {
            return Ok(McpHealth::unknown(
                "an ssh workspace's gavin-mcp is on the host, which gavin cannot check from here",
                None,
            ));
        }
        let default_agent = app_handle
            .state::<crate::session::AgentDefaults>()
            .0
            .lock()
            .unwrap()
            .default_agent
            .clone();
        let root = Path::new(&root_path);
        if !root.is_dir() {
            return Err(format!("root does not exist: {}", root.display()));
        }
        Ok(mcp_health_in(&LocalFiles, root, profile_id.as_deref(), default_agent.as_deref(), &ExecProbe::local()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// A probe for a machine with exactly these executables and these
    /// names on PATH.
    fn probe(windows: bool, executables: &[&str], path: &[&str]) -> ExecProbe {
        let exec: HashSet<PathBuf> = executables.iter().map(PathBuf::from).collect();
        let names: HashSet<String> = path.iter().map(|s| s.to_string()).collect();
        ExecProbe {
            windows,
            gavin_mcp_pin: None,
            home: Some(PathBuf::from("/home/me")),
            local_app_data: Some(PathBuf::from("C:/Users/me/AppData/Local")),
            is_executable: Box::new(move |p| exec.contains(p)),
            on_path: Box::new(move |n| names.contains(n).then(|| PathBuf::from(format!("/usr/bin/{n}")))),
        }
    }

    fn workspace(mcp: Option<&str>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".gavin-root")).unwrap();
        std::fs::write(dir.path().join(".gavin-root/config.toml"), "[agent]\nprofile = \"claude-code\"\n").unwrap();
        if let Some(body) = mcp {
            std::fs::write(dir.path().join(".mcp.json"), body).unwrap();
        }
        dir
    }

    fn entry(command: &str) -> String {
        serde_json::json!({ "mcpServers": { "gavin": { "command": command, "args": [] } } }).to_string()
    }

    #[test]
    fn a_dead_absolute_path_is_not_runnable_and_says_so() {
        let dir = workspace(Some(&entry("/Applications/Old.app/Contents/MacOS/gavin-mcp")));
        let h = mcp_health_in(&LocalFiles, dir.path(), None, None, &probe(false, &[], &[]));
        assert!(h.entry_present, "the entry is there");
        assert_eq!(h.runnable, Some(false));
        assert_eq!(h.command.as_deref(), Some("/Applications/Old.app/Contents/MacOS/gavin-mcp"));
        assert!(h.reason.unwrap().contains("does not exist"));
    }

    #[test]
    fn a_live_absolute_path_is_runnable() {
        let dir = workspace(Some(&entry("/opt/gavin/gavin-mcp")));
        let h = mcp_health_in(&LocalFiles, dir.path(), None, None, &probe(false, &["/opt/gavin/gavin-mcp"], &[]));
        assert_eq!(h.runnable, Some(true));
        assert_eq!(h.reason, None);
        assert_eq!(h.config_file.as_deref(), Some(".mcp.json"));
    }

    /// The real disk's own answer, for the execute bit: a file that
    /// exists but cannot be started is its own sentence.
    #[cfg(unix)]
    #[test]
    fn a_file_without_an_execute_bit_is_not_runnable() {
        let bin = tempfile::tempdir().unwrap();
        let path = bin.path().join("gavin-mcp");
        std::fs::write(&path, "#!/bin/sh\n").unwrap();
        let dir = workspace(Some(&entry(&path.to_string_lossy())));
        let mut machine = probe(false, &[], &[]);
        machine.is_executable = Box::new(crate::program::is_executable);
        let h = mcp_health_in(&LocalFiles, dir.path(), None, None, &machine);
        assert_eq!(h.runnable, Some(false));
        assert!(h.reason.unwrap().contains("not executable"));

        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let h = mcp_health_in(&LocalFiles, dir.path(), None, None, &machine);
        assert_eq!(h.runnable, Some(true));
    }

    #[test]
    fn the_launcher_with_a_binary_it_can_find_is_runnable() {
        let dir = workspace(Some(&entry(MCP_LAUNCHER)));
        std::fs::create_dir_all(dir.path().join("scripts")).unwrap();
        std::fs::write(dir.path().join("scripts/gavin-mcp"), "#!/bin/sh\n").unwrap();
        let built = dir.path().join("target/debug/gavin-mcp");
        let h = mcp_health_in(
            &LocalFiles,
            dir.path(),
            None,
            None,
            &probe(false, &[built.to_str().unwrap()], &[]),
        );
        assert_eq!(h.runnable, Some(true), "{:?}", h.reason);

        // PATH is the launcher's last resort, and enough on its own.
        let h = mcp_health_in(&LocalFiles, dir.path(), None, None, &probe(false, &[], &["gavin-mcp"]));
        assert_eq!(h.runnable, Some(true));

        // As is the daemon's pin, which a fresh worktree with no target/ runs.
        let mut pinned = probe(false, &["/app/gavin-mcp"], &[]);
        pinned.gavin_mcp_pin = Some(PathBuf::from("/app/gavin-mcp"));
        let h = mcp_health_in(&LocalFiles, dir.path(), None, None, &pinned);
        assert_eq!(h.runnable, Some(true));
    }

    #[test]
    fn the_launcher_with_no_binary_anywhere_is_not_runnable_and_names_what_it_tried() {
        let dir = workspace(Some(&entry(MCP_LAUNCHER)));
        std::fs::create_dir_all(dir.path().join("scripts")).unwrap();
        std::fs::write(dir.path().join("scripts/gavin-mcp"), "#!/bin/sh\n").unwrap();
        let h = mcp_health_in(&LocalFiles, dir.path(), None, None, &probe(false, &[], &[]));
        assert!(h.entry_present);
        assert_eq!(h.runnable, Some(false));
        let reason = h.reason.unwrap();
        assert!(reason.contains("finds no gavin-mcp binary"), "{reason}");
        assert!(reason.contains("/Applications/Gavin.app/Contents/MacOS/gavin-mcp"), "{reason}");
        assert!(reason.contains("target/release/gavin-mcp"), "{reason}");
    }

    #[test]
    fn the_launcher_named_in_a_checkout_without_it_is_not_runnable() {
        let dir = workspace(Some(&entry(MCP_LAUNCHER)));
        let h = mcp_health_in(&LocalFiles, dir.path(), None, None, &probe(false, &[], &["gavin-mcp"]));
        assert_eq!(h.runnable, Some(false));
        assert!(h.reason.unwrap().contains("is not in this checkout"));
    }

    /// The `.cmd` walks its own list: the Windows installer's directory,
    /// `.exe` names, and the `.cmd` file itself has to be there.
    #[test]
    fn a_windows_host_walks_the_cmd_launchers_list() {
        let root = Path::new("C:/repo");
        let machine = probe(true, &[], &[]);
        let list = launcher_candidates(root, &machine);
        assert_eq!(
            list,
            vec![
                PathBuf::from("C:/Users/me/AppData/Local").join("Programs").join("Gavin").join("gavin-mcp.exe"),
                root.join("target").join("release").join("gavin-mcp.exe"),
                root.join("target").join("debug").join("gavin-mcp.exe"),
            ]
        );
        let unix = launcher_candidates(Path::new("/repo"), &probe(false, &[], &[]));
        assert_eq!(unix[0], PathBuf::from("/home/me/Applications/Gavin.app/Contents/MacOS/gavin-mcp"));
        assert_eq!(unix[1], PathBuf::from("/Applications/Gavin.app/Contents/MacOS/gavin-mcp"));
    }

    #[test]
    fn a_missing_entry_is_not_runnable() {
        let other = serde_json::json!({ "mcpServers": { "linear": { "command": "npx" } } }).to_string();
        let dir = workspace(Some(&other));
        let h = mcp_health_in(&LocalFiles, dir.path(), None, None, &probe(false, &[], &["npx"]));
        assert!(!h.entry_present);
        assert_eq!(h.runnable, Some(false));
        assert!(h.reason.unwrap().contains("has no gavin entry"));

        let dir = workspace(None);
        let h = mcp_health_in(&LocalFiles, dir.path(), None, None, &probe(false, &[], &[]));
        assert!(!h.entry_present);
        assert_eq!(h.runnable, Some(false));
        assert!(h.reason.unwrap().contains(".mcp.json does not exist"));
    }

    #[test]
    fn an_unparsable_file_is_reported_not_read_as_empty() {
        let dir = workspace(Some("{ not json"));
        let h = mcp_health_in(&LocalFiles, dir.path(), None, None, &probe(false, &[], &[]));
        assert!(!h.entry_present);
        assert_eq!(h.runnable, Some(false));
        assert!(h.reason.unwrap().contains("not valid JSON"));
    }

    /// opencode's command is an array and codex's file is TOML; both go
    /// through the scan's own reader.
    #[test]
    fn the_other_dialects_are_read_the_way_the_scan_reads_them() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".gavin-root")).unwrap();
        std::fs::write(dir.path().join(".gavin-root/config.toml"), "[agent]\nprofile = \"codex\"\n").unwrap();
        std::fs::create_dir_all(dir.path().join(".codex")).unwrap();
        std::fs::write(
            dir.path().join(".codex/config.toml"),
            "[mcp_servers.gavin]\ncommand = \"/opt/gavin-mcp\"\nargs = []\n",
        )
        .unwrap();
        let h = mcp_health_in(&LocalFiles, dir.path(), None, None, &probe(false, &["/opt/gavin-mcp"], &[]));
        assert_eq!(h.runnable, Some(true), "{:?}", h.reason);

        let oc = serde_json::json!({ "mcp": { "gavin": { "type": "local", "command": ["/gone/gavin-mcp"], "enabled": true } } });
        std::fs::write(dir.path().join("opencode.json"), oc.to_string()).unwrap();
        let h = mcp_health_in(&LocalFiles, dir.path(), Some("opencode"), None, &probe(false, &[], &[]));
        assert!(h.entry_present);
        assert_eq!(h.command.as_deref(), Some("/gone/gavin-mcp"));
        assert_eq!(h.runnable, Some(false));
    }

    #[test]
    fn a_custom_profile_with_no_mcp_file_is_unknown() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".gavin-root")).unwrap();
        std::fs::write(dir.path().join(".gavin-root/config.toml"), "[agent]\nprofile = \"custom\"\n").unwrap();
        let h = mcp_health_in(&LocalFiles, dir.path(), None, None, &probe(false, &[], &[]));
        assert_eq!(h.runnable, None, "nothing to check is not a failure");
    }
}
