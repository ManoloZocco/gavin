//! What the app last worked out about each workspace (v79), kept for
//! gavin-mcp to read back.
//!
//! The effective agent config, the card linter's findings, the worktree
//! setup proposal and the setup steps left are all computed in the app's
//! TypeScript, from stores the daemon never sees. An agent reaches only
//! the daemon, so the app publishes its latest answer here
//! (`PublishWorkspaceInsights`) and `gavin_get_effective_config` /
//! `gavin_doctor` read it (`GetWorkspaceInsights`).
//!
//! In memory only, on purpose. The snapshot is derived: the app has every
//! input and republishes on a fresh connection, so after a daemon restart
//! the first thing the app does is say it again -- while a persisted copy
//! would outlive the app and hand an agent a diagnosis of a workspace as
//! it stood whenever the app last ran, which reads as current and is not.
//! "Nothing published" is the honest answer when no app is telling us,
//! and it is the one gavin-mcp turns into "open the workspace in gavin".
//!
//! The payload is opaque here. Its shape belongs to the app's
//! `workspaceInsights.ts` and to gavin-mcp's reader, and the daemon only
//! weighs it, files it under its root and stamps when it arrived.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// How many roots are kept at once. Publishing is confined to watched
/// roots, so this is far above any real number of open workspaces; it is
/// here so a misbehaving client cannot grow the map without bound.
pub const MAX_ROOTS: usize = 64;

#[derive(Debug, Clone, PartialEq)]
pub struct Published {
    pub insights: serde_json::Value,
    /// Unix seconds, the daemon's clock, when the publish arrived.
    pub published_at: i64,
}

#[derive(Debug, Default)]
pub struct InsightsStore {
    by_root: HashMap<PathBuf, Published>,
}

/// The key a root is filed under: canonical, so the app's spelling of a
/// root and the one gavin-mcp resolves from its `HelloAck` (or its cwd
/// walk) meet on one entry -- the same `protocol::canonical_path` the
/// watchers store their roots with. A path that cannot be resolved is
/// filed as written.
pub fn root_key(root: &Path) -> PathBuf {
    protocol::canonical_path(root).unwrap_or_else(|_| root.to_path_buf())
}

impl InsightsStore {
    /// Files `insights` for `root`, replacing what was there. Refuses a
    /// payload heavier than `MAX_WORKSPACE_INSIGHTS_BYTES` serialized,
    /// and anything but a JSON object: the app always sends one, and a
    /// bare value is a client that has the shape wrong.
    pub fn publish(&mut self, root: &Path, insights: serde_json::Value, now: i64) -> anyhow::Result<()> {
        if !insights.is_object() {
            anyhow::bail!("workspace insights must be a JSON object");
        }
        let weight = serde_json::to_vec(&insights).map(|b| b.len()).unwrap_or(usize::MAX);
        if weight > protocol::MAX_WORKSPACE_INSIGHTS_BYTES {
            anyhow::bail!(
                "workspace insights are {weight} bytes; the daemon keeps at most {}",
                protocol::MAX_WORKSPACE_INSIGHTS_BYTES
            );
        }
        let key = root_key(root);
        if !self.by_root.contains_key(&key) && self.by_root.len() >= MAX_ROOTS {
            // The stalest goes: it is the one least likely to describe a
            // workspace somebody still has open.
            if let Some(oldest) =
                self.by_root.iter().min_by_key(|(_, p)| p.published_at).map(|(k, _)| k.clone())
            {
                self.by_root.remove(&oldest);
            }
        }
        self.by_root.insert(key, Published { insights, published_at: now });
        Ok(())
    }

    pub fn get(&self, root: &Path) -> Option<&Published> {
        self.by_root.get(&root_key(root))
    }

    /// Drops a root's snapshot: the app stopped watching it, so nobody is
    /// keeping it current any more.
    pub fn forget(&mut self, root: &Path) {
        self.by_root.remove(&root_key(root));
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.by_root.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_latest_publish_for_a_root_replaces_the_one_before() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = InsightsStore::default();
        store.publish(dir.path(), json!({ "version": 1, "n": 1 }), 10).unwrap();
        store.publish(dir.path(), json!({ "version": 1, "n": 2 }), 20).unwrap();
        let got = store.get(dir.path()).unwrap();
        assert_eq!(got.insights["n"], 2);
        assert_eq!(got.published_at, 20);
        assert_eq!(store.len(), 1);
    }

    /// The app names the root one way and gavin-mcp may resolve it
    /// another -- a trailing slash, a `.` component, a symlinked prefix
    /// (macOS's `/private`) -- and both have to land on one entry.
    #[test]
    fn two_spellings_of_one_root_meet_on_one_entry() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = InsightsStore::default();
        store.publish(dir.path(), json!({ "a": 1 }), 1).unwrap();
        let other = dir.path().join(".");
        assert_eq!(store.get(&other).unwrap().insights["a"], 1);
        #[cfg(unix)]
        {
            let link_dir = tempfile::tempdir().unwrap();
            let link = link_dir.path().join("ws");
            std::os::unix::fs::symlink(dir.path(), &link).unwrap();
            assert_eq!(store.get(&link).unwrap().insights["a"], 1);
        }
    }

    #[test]
    fn a_root_nothing_was_published_for_has_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(InsightsStore::default().get(dir.path()).is_none());
    }

    #[test]
    fn an_oversized_payload_is_refused_and_keeps_the_last_good_one() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = InsightsStore::default();
        store.publish(dir.path(), json!({ "ok": true }), 1).unwrap();
        let heavy = json!({ "blob": "x".repeat(protocol::MAX_WORKSPACE_INSIGHTS_BYTES) });
        let err = store.publish(dir.path(), heavy, 2).unwrap_err().to_string();
        assert!(err.contains("at most"), "{err}");
        assert_eq!(store.get(dir.path()).unwrap().insights["ok"], true);
    }

    #[test]
    fn a_payload_that_is_not_an_object_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = InsightsStore::default();
        assert!(store.publish(dir.path(), json!([1, 2]), 1).is_err());
        assert!(store.publish(dir.path(), json!(null), 1).is_err());
        assert!(store.get(dir.path()).is_none());
    }

    #[test]
    fn forgetting_a_root_drops_its_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = InsightsStore::default();
        store.publish(dir.path(), json!({}), 1).unwrap();
        store.forget(dir.path());
        assert!(store.get(dir.path()).is_none());
    }

    #[test]
    fn past_the_cap_the_stalest_root_makes_room() {
        let base = tempfile::tempdir().unwrap();
        let mut store = InsightsStore::default();
        let roots: Vec<PathBuf> = (0..=MAX_ROOTS)
            .map(|i| {
                let p = base.path().join(format!("r{i}"));
                std::fs::create_dir(&p).unwrap();
                p
            })
            .collect();
        for (i, root) in roots.iter().enumerate() {
            store.publish(root, json!({ "i": i }), i as i64).unwrap();
        }
        assert_eq!(store.len(), MAX_ROOTS);
        assert!(store.get(&roots[0]).is_none(), "the stalest went");
        assert!(store.get(&roots[MAX_ROOTS]).is_some());
    }
}
