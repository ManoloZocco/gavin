//! `gavin_get_effective_config` and `gavin_doctor`: what the gavin app
//! works out about this workspace, read back from the daemon (v79).
//!
//! The app computes all of it in TypeScript -- the effective agent config
//! (`agents/effectiveConfig.ts`), the card linter (`board/cardLint.ts`),
//! the worktree setup proposal (`workspace/worktreeSetupDetect.ts`) and
//! the setup steps left (`workspace/setupWizard.ts`) -- and publishes one
//! snapshot per workspace (`workspace/workspaceInsights.ts` builds it).
//! This module only reads that snapshot and says it in an agent's terms;
//! re-deriving any of it here would be a second copy of rules that would
//! drift from the ones the human sees.

use crate::DaemonTransport;
use protocol::{Request, Response};
use serde_json::Value;
use std::path::Path;

/// Nothing was published for this root. The usual reason by far is that
/// the app is not running or does not have the workspace open; the other
/// is an app older than the daemon's v79, which publishes nothing at all.
pub const NOT_PUBLISHED: &str = "the gavin app has published nothing about this workspace — it must be \
open in the gavin app, which publishes its view within a second of opening it and again on every change. \
Ask again once it is open (an app older than this daemon's v79 never publishes).";

/// The snapshot and its age in seconds, or why there is none. A gated
/// request (an older daemon) comes back as the transport's own error, so
/// `gated_tool_error` can name the version it needs.
pub fn read(root: &Path, transport: &mut dyn DaemonTransport, now: i64) -> anyhow::Result<(Value, i64)> {
    let req = Request::GetWorkspaceInsights { root_path: root.to_string_lossy().to_string() };
    match transport.request(&req)? {
        Response::WorkspaceInsights { insights: Some(insights), published_at } => {
            Ok((insights, published_at.map_or(0, |at| (now - at).max(0))))
        }
        Response::WorkspaceInsights { insights: None, .. } => anyhow::bail!(NOT_PUBLISHED),
        Response::Error { message } => anyhow::bail!(message),
        other => anyhow::bail!("unexpected response: {other:?}"),
    }
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// "12s", "4m", "2h 5m", "3d" -- an age an agent reads at a glance.
pub fn age_text(secs: i64) -> String {
    let secs = secs.max(0);
    match secs {
        s if s < 60 => format!("{s}s"),
        s if s < 3_600 => format!("{}m", s / 60),
        s if s < 86_400 => {
            let m = s % 3_600 / 60;
            if m == 0 { format!("{}h", s / 3_600) } else { format!("{}h {m}m", s / 3_600) }
        }
        s => format!("{}d", s / 86_400),
    }
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

/// One run as the card detail's "Runs on" line says it: agent, model,
/// effort, advisor, and the layer of each value that a layer decided.
fn run_line(run: &Value) -> String {
    let label = match s(run, "agentLabel") {
        "" => s(&run["agent"], "value"),
        l => l,
    };
    let value = |key: &str, unset: &str| match s(&run[key], "value") {
        "" => unset.to_string(),
        v => v.to_string(),
    };
    let mut parts = vec![label.to_string(), value("model", "default model"), value("effort", "default effort")];
    if !s(&run["advisor"], "value").is_empty() {
        parts.push(format!("advised by {}", s(&run["advisor"], "value")));
    }
    let layers: Vec<String> = ["agent", "model", "effort"]
        .iter()
        .map(|k| format!("{k} from {}", match s(&run[*k], "layer") { "" => "?", l => l }))
        .collect();
    format!("{} ({})", parts.join(" · "), layers.join(", "))
}

/// The complexity levels, easiest first, as `cards/complexity.ts` lists
/// them.
const LEVELS: &[&str] = &["trivial", "simple", "moderate", "complex", "intricate"];

/// `gavin_get_effective_config`'s answer: a header that says what the
/// numbers mean and how old they are, then the app's own resolution.
pub fn effective_config_text(insights: &Value, age: i64, root: &Path) -> anyhow::Result<String> {
    let config = match insights.get("effectiveConfig") {
        Some(c) if c.is_object() => c,
        _ => anyhow::bail!(
            "the gavin app's snapshot of this workspace carries no effective config yet (its agent \
             settings had not loaded when it was taken) — ask again in a moment"
        ),
    };
    let mut out = format!(
        "Effective agent config for {} — the gavin app's own resolution, published {} ago. Precedence, \
         highest first: card > complexity > workspace > app > builtin; \"unset\" means gavin passes \
         nothing and the agent CLI's own default applies. Read-only: per-card overrides are \
         gavin_set_plan_field(path, \"agent\"|\"model\"|\"effort\", value); the complexity table, fallback \
         chains and defaults are the human's, in Settings.\n",
        root.display(),
        age_text(age)
    );
    out.push_str(&format!("Unrated card: {}\n", run_line(&config["unrated"])));
    if config["complexityTableEmpty"].as_bool() == Some(true) {
        out.push_str(
            "No complexity level is mapped, so a card's complexity: rating changes nothing about its run \
             until the human maps the levels.\n",
        );
    }
    // The app's own JSON, one run per line, the levels easiest first
    // rather than in serde's alphabetical order.
    out.push_str(&format!("complexityTable: {}\n", config["complexityTable"]));
    out.push_str(&format!("unrated: {}\n", config["unrated"]));
    let levels = config["levels"].as_object().cloned().unwrap_or_default();
    for level in LEVELS {
        if let Some(run) = levels.get(*level) {
            out.push_str(&format!("{level}: {run}\n"));
        }
    }
    // A level a newer app knows and this build does not, still shown.
    for (level, run) in levels.iter().filter(|(l, _)| !LEVELS.contains(&l.as_str())) {
        out.push_str(&format!("{level}: {run}\n"));
    }
    Ok(out.trim_end().to_string())
}

/// What a missing setup step needs, in an agent's terms: whose it is and
/// where it is done. A step this build does not know falls back to the
/// wizard, which is where every step is offered.
fn setup_hint(step: &str) -> &'static str {
    match step {
        "agent" => "no agent command is configured for this workspace — the human picks one in the setup wizard",
        "integration" => "the agent instructions file has no gavin section — the setup wizard writes it",
        "prd" => "the PRD (gavin_read_prd) is still the template — draft at least its Vision and ask the human to confirm",
        "launch" => "the workspace's main agent has not been started — the human starts it from Home",
        _ => "answered by the human in the setup wizard",
    }
}

fn setup_section(insights: &Value, out: &mut Vec<String>) {
    let setup = &insights["setup"];
    if !setup.is_object() {
        out.push(
            "Setup: not reported yet — the app works it out when this workspace's Home tab is shown.".into(),
        );
        return;
    }
    let missing = setup["missing"].as_array().cloned().unwrap_or_default();
    if missing.is_empty() {
        out.push("Setup: every step the Home banner waits on is done.".into());
        return;
    }
    out.push(format!(
        "Setup — {} step{} not done (the app's setup wizard, Home → Finish setting up, offers each):",
        missing.len(),
        if missing.len() == 1 { "" } else { "s" }
    ));
    for step in &missing {
        // `{ step, label }`, or a bare id from a snapshot that sent one.
        let (id, label) = match step {
            Value::String(id) => (id.as_str(), id.as_str()),
            other => (s(other, "step"), match s(other, "label") { "" => s(other, "step"), l => l }),
        };
        out.push(format!("  - {label}: {}", setup_hint(id)));
    }
}

fn config_section(insights: &Value, out: &mut Vec<String>) {
    let config = &insights["effectiveConfig"];
    if !config.is_object() {
        out.push("Agent config: not in the snapshot yet (the app's agent settings had not loaded).".into());
        return;
    }
    let unrated = run_line(&config["unrated"]);
    if config["complexityTableEmpty"].as_bool() == Some(true) {
        out.push(format!(
            "Agent config: no complexity level is mapped, so complexity: ratings change nothing — every card \
             without its own agent/model/effort runs {unrated}. Mapping levels is the human's (Settings → \
             Agents). Full resolution: gavin_get_effective_config."
        ));
    } else {
        out.push(format!(
            "Agent config: an unrated card runs {unrated}; levels are mapped. Per level: gavin_get_effective_config."
        ));
    }
}

/// A JSON string literal, for an argument printed as a call.
fn q(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| format!("\"{text}\""))
}

fn lint_section(insights: &Value, out: &mut Vec<String>) {
    let lint = &insights["lint"];
    if !lint.is_object() {
        out.push("Cards: no lint in the snapshot yet (the workspace's tree had not loaded).".into());
        return;
    }
    let findings = lint["findings"].as_array().cloned().unwrap_or_default();
    let total = lint["findingsTotal"].as_u64().unwrap_or(findings.len() as u64);
    if total == 0 {
        out.push("Cards: the linter found nothing.".into());
        return;
    }
    out.push(format!("Cards — {total} lint finding{}:", if total == 1 { "" } else { "s" }));

    let fixes = lint["safeFixes"].as_array().cloned().unwrap_or_default();
    if !fixes.is_empty() {
        out.push(
            "  SAFE — apply each with gavin_set_plan_field(path, key, value), then add a dated line under the \
             card's ## Comments saying what changed:"
                .into(),
        );
        for fix in &fixes {
            let (path, key, value) = (s(fix, "path"), s(fix, "key"), s(fix, "value"));
            let summary = findings
                .iter()
                .find(|f| s(&f["fix"]["write"], "path") == path && s(&f["fix"]["write"], "key") == key)
                .map(|f| match s(&f["fix"], "summary") { "" => s(f, "message"), sm => sm })
                .unwrap_or("");
            let call = format!("gavin_set_plan_field({}, {}, {})", q(path), q(key), q(value));
            out.push(if summary.is_empty() { format!("    {call}") } else { format!("    {call} — {summary}") });
        }
    }

    let decide: Vec<&Value> = findings.iter().filter(|f| s(&f["fix"], "kind") == "decide").collect();
    if !decide.is_empty() {
        out.push(
            "  DECIDE — the human's call. File each with gavin_request_human(card, \"decision\", text, options) \
             on the card it names (a board-wide one, with no card, on the card you are working on):"
                .into(),
        );
        for f in decide {
            let at = match f["path"].as_str() {
                Some(p) if !p.is_empty() => p.to_string(),
                _ => match s(f, "columnId") {
                    "" => "(board)".to_string(),
                    col => format!("(board, column {col})"),
                },
            };
            let options: Vec<String> = f["fix"]["options"]
                .as_array()
                .map(|o| o.iter().filter_map(Value::as_str).map(q).collect())
                .unwrap_or_default();
            let opts = if options.is_empty() { String::new() } else { format!(" — options: [{}]", options.join(", ")) };
            out.push(format!("    {at} [{}] {}{opts}", s(f, "code"), s(f, "message")));
        }
    }
    if (findings.len() as u64) < total {
        out.push(format!(
            "  ({} more finding{} not in the snapshot — the app caps it; fix these and run gavin_doctor again.)",
            total - findings.len() as u64,
            if total - findings.len() as u64 == 1 { "" } else { "s" }
        ));
    }
}

fn worktree_section(insights: &Value, out: &mut Vec<String>) {
    let wt = &insights["worktreeSetup"];
    if !wt.is_object() {
        out.push("Worktree setup: not in the snapshot.".into());
        return;
    }
    if let Some(why) = wt["skipped"].as_str() {
        out.push(format!("Worktree setup: not scanned — {why}."));
        return;
    }
    let declared: Vec<&str> = wt["declared"].as_array().map(|d| d.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let approved = wt["trust"]["trusted"].as_bool().unwrap_or(false);
    let declared_line = if declared.is_empty() {
        "nothing is declared in [worktree] setup, so a new worktree starts with nothing installed".to_string()
    } else {
        format!(
            "{} line{} declared ({})",
            declared.len(),
            if declared.len() == 1 { "" } else { "s" },
            if approved {
                "approved: they run in every new worktree"
            } else {
                "NOT approved: gavin holds them back until the human approves .gavin-root/config.toml's commands in the app"
            }
        )
    };
    if let Some(err) = wt["error"].as_str() {
        out.push(format!("Worktree setup: {declared_line}; the lockfile scan failed: {err}."));
        return;
    }
    let comparison = &wt["comparison"];
    if !comparison.is_object() {
        out.push(format!("Worktree setup: {declared_line}; the lockfile scan has not finished yet."));
        return;
    }
    let state = s(comparison, "state");
    let missing = comparison["missing"].as_array().cloned().unwrap_or_default();
    let propose_note = "File the proposal with gavin_propose_worktree_setup so the human can approve it; never write \
                        [worktree] setup yourself and never run these lines.";
    match state {
        "none" => out.push(format!("Worktree setup: {declared_line}; no lockfile gavin knows an install for.")),
        "declared" => out.push(format!(
            "Worktree setup: {declared_line}; no lockfile gavin knows an install for, so the declared value stands."
        )),
        "matches" => out.push(format!("Worktree setup: {declared_line}; it already installs every lockfile found.")),
        _ => {
            let lead = if state == "propose" {
                "the repo's lockfiles imply".to_string()
            } else {
                format!("{} detected line{} missing from it", missing.len(), if missing.len() == 1 { " is" } else { "s are" })
            };
            out.push(format!("Worktree setup: {declared_line}; {lead}:"));
            for line in &missing {
                let why = match s(line, "lockfile") { "" => String::new(), l => format!("  ({l})") };
                out.push(format!("    {}{why}", s(line, "line")));
            }
            out.push(format!("  {propose_note}"));
        }
    }
    let proposal = &wt["proposal"];
    if proposal["partial"].as_bool() == Some(true) {
        out.push("  (The scan stopped early at a depth or folder limit, so a deeper lockfile may be missing.)".into());
    }
    if proposal["rootedAtCheckout"].as_bool() == Some(false) {
        out.push(
            "  (This folder is not inside a git checkout gavin could find, so the lines are relative to the workspace \
             folder rather than a worktree's root.)"
                .into(),
        );
    }
}

/// `gavin_doctor`'s report, from the snapshot alone. Pure, so every
/// section is tested without a daemon.
pub fn doctor_report(insights: &Value, age: i64, root: &Path) -> String {
    let mut out = vec![format!(
        "gavin doctor — {}. From the gavin app's snapshot, taken {} ago (the app republishes within a second \
         of any change, so an old snapshot means nothing it watches has changed since). This report changes nothing.",
        root.display(),
        age_text(age)
    )];
    if let Some(v) = insights["version"].as_u64().filter(|v| *v > 1) {
        out.push(format!(
            "(The snapshot is version {v}; this gavin-mcp reads version 1, so parts may be missing below.)"
        ));
    }
    setup_section(insights, &mut out);
    config_section(insights, &mut out);
    lint_section(insights, &mut out);
    worktree_section(insights, &mut out);
    out.join("\n")
}

pub fn get_effective_config(root: &Path, transport: &mut dyn DaemonTransport) -> anyhow::Result<String> {
    let (insights, age) = read(root, transport, now_secs())?;
    effective_config_text(&insights, age, root)
}

pub fn doctor(root: &Path, transport: &mut dyn DaemonTransport) -> anyhow::Result<String> {
    let (insights, age) = read(root, transport, now_secs())?;
    Ok(doctor_report(&insights, age, root))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The `MockTransport` pattern from main.rs's tests: replies in
    /// order, every request recorded.
    struct MockTransport {
        replies: Vec<Response>,
        requests: Vec<Request>,
    }
    impl DaemonTransport for MockTransport {
        fn request(&mut self, req: &Request) -> anyhow::Result<Response> {
            self.requests.push(req.clone());
            if self.replies.is_empty() {
                anyhow::bail!("mock exhausted")
            }
            Ok(self.replies.remove(0))
        }
    }
    fn mock(replies: Vec<Response>) -> MockTransport {
        MockTransport { replies, requests: vec![] }
    }

    fn run(agent: &str, model: &str, layer: &str) -> Value {
        json!({
            "agent": { "value": agent, "layer": layer },
            "agentLabel": "Claude Code",
            "model": { "value": model, "layer": if model.is_empty() { "unset" } else { layer } },
            "effort": { "value": "", "layer": "unset" },
            "advisor": { "value": "", "layer": "unset" },
            "fallback": { "chain": [], "chainLayer": "builtin", "thresholdPercent": 90, "thresholdLayer": "builtin" },
            "pause": { "cycleEnabled": false, "limitEnabled": true, "limitPercent": 95, "layer": "builtin" },
        })
    }

    fn snapshot() -> Value {
        json!({
            "version": 1,
            "effectiveConfig": {
                "unrated": run("claude-code", "", "builtin"),
                "levels": { "trivial": run("claude-code", "", "builtin") },
                "complexityTable": { "layer": "builtin", "primary": "claude-code" },
                "complexityTableEmpty": true,
            },
            "lint": {
                "findings": [
                    {
                        "code": "status-spelling", "path": "/ws/.gavin-root/plans/a.md",
                        "contextFolder": "/ws", "fileName": "a.md", "field": "status",
                        "message": "status: \"in progress\" differs from the column In Progress only by case.",
                        "fix": { "kind": "safe",
                                 "write": { "path": "/ws/.gavin-root/plans/a.md", "key": "status", "value": "In Progress" },
                                 "summary": "status respelled to In Progress" }
                    },
                    {
                        "code": "status-unknown", "path": "/ws/.gavin-root/plans/b.md",
                        "contextFolder": "/ws", "fileName": "b.md", "field": "status",
                        "message": "status: \"Blocked\" matches no column.",
                        "fix": { "kind": "decide", "options": ["To Do", "In Progress"] }
                    },
                    {
                        "code": "column-right-of-done", "path": null, "contextFolder": null, "fileName": null,
                        "columnId": "c9", "field": "column", "message": "Column Shipped sits right of Done.",
                        "fix": { "kind": "decide", "options": ["Move Shipped left of Done", "Leave it"] }
                    }
                ],
                "findingsTotal": 3,
                "safeFixes": [ { "path": "/ws/.gavin-root/plans/a.md", "key": "status", "value": "In Progress" } ],
            },
            "worktreeSetup": {
                "declared": [],
                "trust": { "trusted": false, "needsApproval": false },
                "proposal": { "lines": [], "partial": false, "rootedAtCheckout": true },
                "comparison": { "state": "propose", "missing": [
                    { "line": "(cd app && npm ci)", "command": "npm ci", "dir": "app", "lockfile": "app/package-lock.json", "alsoFound": [] },
                    { "line": "cargo fetch", "command": "cargo fetch", "dir": "", "lockfile": "Cargo.lock", "alsoFound": [] }
                ] },
                "error": null,
            },
            "setup": { "configured": false, "complete": false,
                       "missing": [ { "step": "prd", "label": "PRD" }, { "step": "integration", "label": "Integration" } ] },
        })
    }

    #[test]
    fn ages_read_at_a_glance() {
        assert_eq!(age_text(0), "0s");
        assert_eq!(age_text(59), "59s");
        assert_eq!(age_text(61), "1m");
        assert_eq!(age_text(3_600), "1h");
        assert_eq!(age_text(3_600 + 5 * 60), "1h 5m");
        assert_eq!(age_text(3 * 86_400 + 7), "3d");
        assert_eq!(age_text(-5), "0s", "a clock skewed ahead is not a negative age");
    }

    #[test]
    fn the_read_names_the_root_and_dates_the_snapshot() {
        let mut t = mock(vec![Response::WorkspaceInsights { insights: Some(snapshot()), published_at: Some(1_000) }]);
        let (got, age) = read(Path::new("/ws"), &mut t, 1_042).unwrap();
        assert_eq!(age, 42);
        assert_eq!(got["version"], 1);
        assert!(matches!(&t.requests[..], [Request::GetWorkspaceInsights { root_path }] if root_path == "/ws"));
    }

    /// The case every agent outside a running app hits: it is told what
    /// to do, not handed an empty report that reads as a clean bill.
    #[test]
    fn nothing_published_says_the_workspace_must_be_open_in_the_app() {
        type Tool = fn(&Path, &mut dyn DaemonTransport) -> anyhow::Result<String>;
        for tool in [get_effective_config as Tool, doctor as Tool] {
            let mut t = mock(vec![Response::WorkspaceInsights { insights: None, published_at: None }]);
            let err = tool(Path::new("/ws"), &mut t).unwrap_err().to_string();
            assert!(err.contains("open in the gavin app"), "{err}");
        }
    }

    #[test]
    fn a_daemon_error_passes_through() {
        let mut t = mock(vec![Response::Error { message: "boom".into() }]);
        assert_eq!(doctor(Path::new("/ws"), &mut t).unwrap_err().to_string(), "boom");
    }

    #[test]
    fn the_effective_config_says_where_each_value_came_from_and_that_ratings_do_nothing_yet() {
        let text = effective_config_text(&snapshot(), 5, Path::new("/ws")).unwrap();
        assert!(text.contains("published 5s ago"), "{text}");
        assert!(
            text.contains("Unrated card: Claude Code · default model · default effort (agent from builtin, model from unset, effort from unset)"),
            "{text}"
        );
        assert!(text.contains("No complexity level is mapped"), "{text}");
        // The app's own JSON follows, one run per line, levels in order.
        assert!(text.contains("\ncomplexityTable: {\"layer\":\"builtin\",\"primary\":\"claude-code\"}\n"), "{text}");
        assert!(text.contains("\nunrated: {\"advisor\":"), "{text}");
        assert!(text.contains("\ntrivial: {\"advisor\":"), "{text}");
        assert!(text.find("\nunrated: ").unwrap() < text.find("\ntrivial: ").unwrap(), "{text}");
    }

    #[test]
    fn an_effective_config_missing_from_the_snapshot_is_an_error_not_an_empty_answer() {
        let err = effective_config_text(&json!({ "version": 1 }), 0, Path::new("/ws")).unwrap_err().to_string();
        assert!(err.contains("ask again"), "{err}");
    }

    #[test]
    fn the_doctor_lists_the_exact_safe_writes_and_the_decisions_with_their_options() {
        let text = doctor_report(&snapshot(), 90, Path::new("/ws"));
        assert!(text.contains("taken 1m ago"), "{text}");
        assert!(text.contains("Cards — 3 lint findings:"), "{text}");
        assert!(
            text.contains(
                r#"    gavin_set_plan_field("/ws/.gavin-root/plans/a.md", "status", "In Progress") — status respelled to In Progress"#
            ),
            "{text}"
        );
        assert!(text.contains("## Comments"), "{text}");
        assert!(text.contains(r#"gavin_request_human(card, "decision", text, options)"#), "{text}");
        assert!(
            text.contains(r#"    /ws/.gavin-root/plans/b.md [status-unknown] status: "Blocked" matches no column. — options: ["To Do", "In Progress"]"#),
            "{text}"
        );
        assert!(text.contains("(board, column c9) [column-right-of-done]"), "{text}");
        // The safe one is not offered as a decision too.
        assert!(!text.contains("a.md [status-spelling]"), "{text}");
    }

    #[test]
    fn the_doctor_names_the_missing_setup_steps_and_the_worktree_proposal() {
        let text = doctor_report(&snapshot(), 0, Path::new("/ws"));
        assert!(text.contains("Setup — 2 steps not done"), "{text}");
        assert!(text.contains("  - PRD: the PRD (gavin_read_prd) is still the template"), "{text}");
        assert!(text.contains("  - Integration: "), "{text}");
        assert!(text.contains("no complexity level is mapped"), "{text}");
        assert!(text.contains("nothing is declared in [worktree] setup"), "{text}");
        assert!(text.contains("    (cd app && npm ci)  (app/package-lock.json)"), "{text}");
        assert!(text.contains("    cargo fetch  (Cargo.lock)"), "{text}");
        assert!(text.contains("gavin_propose_worktree_setup"), "{text}");
    }

    #[test]
    fn a_clean_workspace_reads_clean_and_unreported_parts_say_so() {
        let clean = json!({
            "version": 1,
            "lint": { "findings": [], "findingsTotal": 0, "safeFixes": [] },
            "setup": { "configured": true, "missing": [] },
            "worktreeSetup": {
                "declared": ["npm ci"], "trust": { "trusted": true },
                "proposal": { "lines": [], "partial": false, "rootedAtCheckout": true },
                "comparison": { "state": "matches", "missing": [] },
            },
        });
        let text = doctor_report(&clean, 0, Path::new("/ws"));
        assert!(text.contains("Setup: every step the Home banner waits on is done."), "{text}");
        assert!(text.contains("Cards: the linter found nothing."), "{text}");
        assert!(text.contains("1 line declared (approved"), "{text}");
        assert!(text.contains("already installs every lockfile found"), "{text}");
        assert!(text.contains("Agent config: not in the snapshot yet"), "{text}");
        assert!(!text.contains("gavin_propose_worktree_setup"), "{text}");

        let bare = doctor_report(&json!({ "version": 1, "setup": null }), 0, Path::new("/ws"));
        assert!(bare.contains("Setup: not reported yet"), "{bare}");
        assert!(bare.contains("Worktree setup: not in the snapshot."), "{bare}");
    }

    #[test]
    fn a_capped_snapshot_and_an_skipped_scan_are_named() {
        let mut snap = snapshot();
        snap["lint"]["findingsTotal"] = json!(10);
        snap["worktreeSetup"] = json!({ "skipped": "an ssh workspace's lockfiles are not scanned from this machine" });
        let text = doctor_report(&snap, 0, Path::new("/ws"));
        assert!(text.contains("Cards — 10 lint findings:"), "{text}");
        assert!(text.contains("(7 more findings not in the snapshot"), "{text}");
        assert!(text.contains("Worktree setup: not scanned — an ssh workspace's lockfiles"), "{text}");
    }
}
