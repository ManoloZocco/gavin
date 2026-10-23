//! One look at this machine's prerequisites, instead of one per step.
//!
//! Each prerequisite used to surface only inside the step that needed it,
//! and late: Node in the Playwright step, uv in Headroom's, Git for
//! Windows when a session failed to start because the daemon fell back
//! to a bare `sh.exe`. And an agent CLI counted as "found" off a PATH
//! sweep that never ran it, so a broken install was made the primary
//! agent and discovered at the first Run (report 2026-10-22, §5).
//!
//! This answers all of them in one list. It installs nothing and decides
//! nothing about what matters -- which lines are worth a notice depends
//! on what the human has set up, and that is the app's
//! (`prerequisites.ts`). The detectors are the ones the steps already
//! use: `program::resolve` for PATH (with the well-known agent install
//! directories the daemon adds), `detect_agent_binaries` for the agent
//! CLIs, `agent_skills::run` to start a program under a deadline.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::agent_setup::DetectedAgentDto;

/// How long one `--version` may take. Node-based CLIs start in about a
/// second cold; one that has not answered in three is not one a session
/// should be pointed at without a word.
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PreflightState {
    Ok,
    /// Not on this machine at all.
    Missing,
    /// There, but it did not start or did not answer: "found but not
    /// runnable", which the PATH sweep alone reports as found.
    Broken,
    /// gavin could not tell.
    Unknown,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreflightItem {
    /// `git`, `node`, `uv`, `git-sh` (Windows), or `agent:<profile id>`.
    pub id: String,
    pub label: String,
    pub state: PreflightState,
    /// The version line when ok, otherwise what was wrong.
    pub detail: String,
    /// What fixes it, when it is not ok.
    pub fix_hint: Option<String>,
    /// The agent profile, for an `agent:` row.
    pub profile_id: Option<String>,
}

/// What a probe saw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Probe {
    Ran { code: i32, stdout: String, stderr: String },
    /// Could not be started, or timed out -- the sentence says which.
    Failed(String),
}

/// The machine, injected so the decisions are tested without one.
pub(crate) trait PreflightMachine: Sync {
    fn windows(&self) -> bool;
    fn resolve(&self, name: &str) -> Option<PathBuf>;
    fn run(&self, program: &Path, args: &[&str]) -> Probe;
    fn is_file(&self, path: &Path) -> bool;
    fn agents(&self) -> Vec<DetectedAgentDto>;
}

struct LocalMachine;

impl PreflightMachine for LocalMachine {
    fn windows(&self) -> bool {
        cfg!(windows)
    }
    fn resolve(&self, name: &str) -> Option<PathBuf> {
        crate::program::resolve(name)
    }
    fn run(&self, program: &Path, args: &[&str]) -> Probe {
        // A neutral cwd: a version probe has no business reading a
        // workspace's `.npmrc` or `node_modules`.
        let cwd = std::env::temp_dir();
        match crate::agent_skills::run(&program.to_string_lossy(), args, &cwd, PROBE_TIMEOUT) {
            Ok(run) => Probe::Ran { code: run.code, stdout: run.stdout, stderr: run.stderr },
            Err(why) => Probe::Failed(why),
        }
    }
    fn is_file(&self, path: &Path) -> bool {
        path.is_file()
    }
    fn agents(&self) -> Vec<DetectedAgentDto> {
        crate::agent_setup::detect_agent_binaries()
    }
}

/// The first non-empty line, trimmed and kept short: a version banner, or
/// the first line of an error.
fn first_line(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let mut out: String = line.chars().take(160).collect();
    if line.chars().count() > 160 {
        out.push('…');
    }
    out
}

/// One `--version` (or similar) and what it says about the program.
fn probe_verdict(name: &str, probe: Probe) -> (PreflightState, String) {
    match probe {
        Probe::Ran { code: 0, stdout, stderr } => {
            let line = first_line(&stdout);
            (PreflightState::Ok, if line.is_empty() { first_line(&stderr) } else { line })
        }
        Probe::Ran { code, stdout, stderr } => {
            let said = first_line(if stderr.trim().is_empty() { &stdout } else { &stderr });
            let detail = if said.is_empty() {
                format!("{name} exited with {code}")
            } else {
                format!("{name} exited with {code}: {said}")
            };
            (PreflightState::Broken, detail)
        }
        Probe::Failed(why) => (PreflightState::Broken, why),
    }
}

fn item(id: &str, label: &str, state: PreflightState, detail: String, fix: Option<String>) -> PreflightItem {
    let fix_hint = if state == PreflightState::Ok { None } else { fix };
    PreflightItem { id: id.to_string(), label: label.to_string(), state, detail, fix_hint, profile_id: None }
}

/// A program on PATH, asked for its version.
fn tool(machine: &dyn PreflightMachine, id: &str, label: &str, name: &str, fix: &str) -> PreflightItem {
    match machine.resolve(name) {
        None => item(id, label, PreflightState::Missing, format!("{name} not found on PATH"), Some(fix.to_string())),
        Some(path) => {
            let (state, detail) = probe_verdict(name, machine.run(&path, &["--version"]));
            item(id, label, state, detail, Some(fix.to_string()))
        }
    }
}

fn git(machine: &dyn PreflightMachine) -> PreflightItem {
    let fix = if machine.windows() {
        "Install Git for Windows (git-scm.com) — the Git tab, worktrees and card runs need git"
    } else {
        "Install git — the Git tab, worktrees and card runs need it"
    };
    tool(machine, "git", "Git", "git", fix)
}

/// Node, as the Playwright step needs it: through `npx`. `node --version`
/// is the probe -- the cheaper start of the two, and `npx` is a script
/// Node runs -- with `npx` itself asked only where there is no `node`.
fn node(machine: &dyn PreflightMachine) -> PreflightItem {
    let fix = "Install Node.js — the Playwright step runs its browser server through npx";
    let label = "Node.js (npx)";
    if machine.resolve("npx").is_none() {
        return item("node", label, PreflightState::Missing, "npx not found on PATH".to_string(), Some(fix.to_string()));
    }
    let (name, path) = match machine.resolve("node") {
        Some(path) => ("node", path),
        None => ("npx", machine.resolve("npx").unwrap_or_else(|| PathBuf::from("npx"))),
    };
    let (state, detail) = probe_verdict(name, machine.run(&path, &["--version"]));
    item("node", label, state, detail, Some(fix.to_string()))
}

fn uv(machine: &dyn PreflightMachine) -> PreflightItem {
    tool(
        machine,
        "uv",
        "uv",
        "uv",
        "Install uv (docs.astral.sh/uv) — gavin installs Headroom with it",
    )
}

/// Git for Windows' `sh.exe`, found the way the daemon finds it
/// (`crates/daemon/src/shell.rs`, `resolve_posix_shell`): up from
/// `git --exec-path`, `usr/bin` before `bin`. The walk is repeated here
/// rather than shared because the app does not link the daemon crate;
/// the test below pins the same layouts the daemon's does.
pub(crate) fn posix_shell_from_exec_path(exec_path: &str, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let exec_path = exec_path.trim().replace('\\', "/");
    let mut dir = exec_path.trim_end_matches('/').to_string();
    for _ in 0..5 {
        let Some(cut) = dir.rfind('/') else { break };
        dir.truncate(cut);
        if dir.is_empty() {
            break;
        }
        for tail in ["/usr/bin/sh.exe", "/bin/sh.exe"] {
            let candidate = PathBuf::from(format!("{dir}{tail}"));
            if exists(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn git_sh(machine: &dyn PreflightMachine) -> PreflightItem {
    let label = "Git for Windows (sh.exe)";
    let fix = "Install Git for Windows (git-scm.com): sessions that run a command start it through Git's sh.exe, and without it fall back to a bare sh.exe that fails";
    let Some(git) = machine.resolve("git") else {
        return item("git-sh", label, PreflightState::Missing, "git not found on PATH".to_string(), Some(fix.to_string()));
    };
    match machine.run(&git, &["--exec-path"]) {
        Probe::Ran { code: 0, stdout, .. } => match posix_shell_from_exec_path(&stdout, |p| machine.is_file(p)) {
            Some(sh) => item("git-sh", label, PreflightState::Ok, sh.display().to_string(), None),
            None => item(
                "git-sh",
                label,
                PreflightState::Missing,
                format!("no sh.exe above {}", first_line(&stdout)),
                Some(fix.to_string()),
            ),
        },
        other => {
            let (_, detail) = probe_verdict("git --exec-path", other);
            item("git-sh", label, PreflightState::Unknown, detail, Some(fix.to_string()))
        }
    }
}

/// One agent CLI: missing when the sweep found nothing, otherwise its
/// `--version`, which every stock CLI answers offline and without a TUI.
fn agent(machine: &dyn PreflightMachine, row: &DetectedAgentDto) -> PreflightItem {
    let bin = row.command.split_whitespace().next().unwrap_or(&row.command).to_string();
    let id = format!("agent:{}", row.id);
    let mut out = match row.path.as_deref().filter(|_| row.found) {
        None => item(
            &id,
            &row.label,
            PreflightState::Missing,
            format!("{bin} not found on PATH"),
            Some(format!("Install {}, or pick another agent", row.label)),
        ),
        Some(path) => {
            let (state, detail) = probe_verdict(&bin, machine.run(Path::new(path), &["--version"]));
            item(
                &id,
                &row.label,
                state,
                detail,
                Some(format!(
                    "Run `{bin} --version` in a terminal to see why it does not start, then reinstall {} or pick another agent",
                    row.label
                )),
            )
        }
    };
    out.profile_id = Some(row.id.clone());
    out
}

/// The whole list, every probe at once: each is its own process under its
/// own deadline, so the list costs the slowest one rather than their sum.
pub(crate) fn preflight_with(machine: &dyn PreflightMachine) -> Vec<PreflightItem> {
    let agents = machine.agents();
    std::thread::scope(|scope| {
        let mut jobs: Vec<std::thread::ScopedJoinHandle<'_, PreflightItem>> = vec![
            scope.spawn(|| git(machine)),
            scope.spawn(|| node(machine)),
            scope.spawn(|| uv(machine)),
        ];
        // Only Windows starts emitted command lines through Git's sh.exe;
        // elsewhere it is `/bin/sh`, which is always there. WebView2 is
        // not checked: this list is drawn inside it, so a machine without
        // it could never show the answer.
        if machine.windows() {
            jobs.push(scope.spawn(|| git_sh(machine)));
        }
        for row in &agents {
            jobs.push(scope.spawn(move || agent(machine, row)));
        }
        jobs.into_iter()
            .map(|j| {
                j.join().unwrap_or_else(|_| PreflightItem {
                    id: "preflight".to_string(),
                    label: "Preflight".to_string(),
                    state: PreflightState::Unknown,
                    detail: "a check panicked".to_string(),
                    fix_hint: None,
                    profile_id: None,
                })
            })
            .collect()
    })
}

/// Every prerequisite at once (lc-09). Off the main thread: it starts a
/// handful of programs, each under a 3 s deadline.
#[tauri::command]
pub async fn preflight() -> Result<Vec<PreflightItem>, String> {
    tauri::async_runtime::spawn_blocking(|| preflight_with(&LocalMachine)).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Fake {
        windows: bool,
        paths: HashMap<String, PathBuf>,
        answers: HashMap<PathBuf, Probe>,
        files: Vec<PathBuf>,
        agents: Vec<DetectedAgentDto>,
        ran: Mutex<Vec<String>>,
    }

    impl PreflightMachine for Fake {
        fn windows(&self) -> bool {
            self.windows
        }
        fn resolve(&self, name: &str) -> Option<PathBuf> {
            self.paths.get(name).cloned()
        }
        fn run(&self, program: &Path, args: &[&str]) -> Probe {
            self.ran.lock().unwrap().push(format!("{} {}", program.display(), args.join(" ")));
            self.answers.get(program).cloned().unwrap_or(Probe::Failed("no answer".to_string()))
        }
        fn is_file(&self, path: &Path) -> bool {
            self.files.iter().any(|f| f == path)
        }
        fn agents(&self) -> Vec<DetectedAgentDto> {
            self.agents.clone()
        }
    }

    fn ok(out: &str) -> Probe {
        Probe::Ran { code: 0, stdout: format!("{out}\n"), stderr: String::new() }
    }

    fn agent_row(id: &str, command: &str, path: Option<&str>) -> DetectedAgentDto {
        DetectedAgentDto {
            id: id.to_string(),
            label: id.to_string(),
            command: command.to_string(),
            found: path.is_some(),
            path: path.map(str::to_string),
            warning: None,
        }
    }

    fn by_id<'a>(items: &'a [PreflightItem], id: &str) -> &'a PreflightItem {
        items.iter().find(|i| i.id == id).unwrap_or_else(|| panic!("no {id} row in {items:?}"))
    }

    #[test]
    fn present_tools_report_their_version_and_missing_ones_how_to_fix_it() {
        let mut fake = Fake::default();
        fake.paths.insert("git".into(), "/usr/bin/git".into());
        fake.answers.insert("/usr/bin/git".into(), ok("git version 2.43.0"));
        let items = preflight_with(&fake);

        let git = by_id(&items, "git");
        assert_eq!(git.state, PreflightState::Ok);
        assert_eq!(git.detail, "git version 2.43.0");
        assert_eq!(git.fix_hint, None);

        let node = by_id(&items, "node");
        assert_eq!(node.state, PreflightState::Missing);
        assert!(node.fix_hint.as_deref().unwrap().contains("Playwright"));
        assert_eq!(by_id(&items, "uv").state, PreflightState::Missing);
        assert!(items.iter().all(|i| i.id != "git-sh"), "only Windows is asked about sh.exe");
    }

    /// Found is not runnable: the sweep's path is started, and a CLI
    /// that fails or hangs is its own state, distinct from not found.
    #[test]
    fn an_agent_cli_that_does_not_answer_is_broken_not_missing() {
        let mut fake = Fake::default();
        fake.agents = vec![
            agent_row("claude-code", "claude", Some("/bin/claude")),
            agent_row("cursor", "agent --trust", Some("/bin/agent")),
            agent_row("codex", "codex", Some("/bin/codex")),
            agent_row("kimi-code", "kimi", None),
        ];
        fake.answers.insert("/bin/claude".into(), ok("2.1.0 (Claude Code)"));
        fake.answers.insert(
            "/bin/agent".into(),
            Probe::Ran { code: 1, stdout: String::new(), stderr: "Error: licence expired\n".into() },
        );
        fake.answers.insert("/bin/codex".into(), Probe::Failed("/bin/codex --version timed out after 3s".into()));
        let items = preflight_with(&fake);

        assert_eq!(by_id(&items, "agent:claude-code").state, PreflightState::Ok);
        let cursor = by_id(&items, "agent:cursor");
        assert_eq!(cursor.state, PreflightState::Broken);
        assert_eq!(cursor.detail, "agent exited with 1: Error: licence expired");
        assert_eq!(cursor.profile_id.as_deref(), Some("cursor"));
        assert!(cursor.fix_hint.as_deref().unwrap().contains("`agent --version`"), "the bare binary, not its flags");
        let codex = by_id(&items, "agent:codex");
        assert_eq!(codex.state, PreflightState::Broken);
        assert!(codex.detail.contains("timed out"));
        assert_eq!(by_id(&items, "agent:kimi-code").state, PreflightState::Missing);

        let ran = fake.ran.lock().unwrap();
        assert!(ran.contains(&"/bin/agent --version".to_string()), "{ran:?}");
        assert!(!ran.iter().any(|r| r.contains("kimi")), "a missing CLI is not started");
    }

    #[test]
    fn node_is_probed_through_node_when_there_is_one() {
        let mut fake = Fake::default();
        fake.paths.insert("npx".into(), "/usr/bin/npx".into());
        fake.paths.insert("node".into(), "/usr/bin/node".into());
        fake.answers.insert("/usr/bin/node".into(), ok("v22.3.0"));
        let items = preflight_with(&fake);
        let node = by_id(&items, "node");
        assert_eq!(node.state, PreflightState::Ok);
        assert_eq!(node.detail, "v22.3.0");
    }

    #[test]
    fn windows_finds_git_for_windows_sh_above_the_exec_path() {
        let mut fake = Fake { windows: true, ..Default::default() };
        fake.paths.insert("git".into(), "C:/Program Files/Git/cmd/git.exe".into());
        fake.answers.insert(
            "C:/Program Files/Git/cmd/git.exe".into(),
            ok("C:/Program Files/Git/mingw64/libexec/git-core"),
        );
        fake.files.push("C:/Program Files/Git/usr/bin/sh.exe".into());
        let items = preflight_with(&fake);
        let sh = by_id(&items, "git-sh");
        assert_eq!(sh.state, PreflightState::Ok);
        assert_eq!(sh.detail, "C:/Program Files/Git/usr/bin/sh.exe");

        // A git with no MSYS runtime above it (a bare MinGit, say): the
        // daemon would fall back to a bare `sh.exe`.
        fake.files.clear();
        let sh = preflight_with(&fake).into_iter().find(|i| i.id == "git-sh").unwrap();
        assert_eq!(sh.state, PreflightState::Missing);
        assert!(sh.fix_hint.unwrap().contains("Git for Windows"));
    }

    /// The daemon's own cases (`shell.rs`), so the two walks agree.
    #[test]
    fn the_sh_walk_matches_the_daemons() {
        let found = |want: &'static str| move |p: &Path| p == Path::new(want);
        assert_eq!(
            posix_shell_from_exec_path(
                "C:/Program Files/Git/mingw64/libexec/git-core\n",
                found("C:/Program Files/Git/usr/bin/sh.exe")
            ),
            Some(PathBuf::from("C:/Program Files/Git/usr/bin/sh.exe"))
        );
        assert_eq!(
            posix_shell_from_exec_path(
                "C:\\Users\\me\\scoop\\apps\\git\\current\\mingw64\\libexec\\git-core",
                found("C:/Users/me/scoop/apps/git/current/bin/sh.exe")
            ),
            Some(PathBuf::from("C:/Users/me/scoop/apps/git/current/bin/sh.exe"))
        );
        assert_eq!(posix_shell_from_exec_path("C:/nowhere/libexec/git-core", |_| false), None);
    }

    #[test]
    fn a_long_error_line_is_cut() {
        let long = "x".repeat(400);
        let (state, detail) =
            probe_verdict("tool", Probe::Ran { code: 2, stdout: String::new(), stderr: long });
        assert_eq!(state, PreflightState::Broken);
        assert!(detail.chars().count() < 200);
    }
}
