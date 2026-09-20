# Codex projectless wakes and monitor failure visibility

CODEX20's relay registration pointed to a non-Git Desktop chat directory.
Fresh `codex exec` delegates exited before starting with the Git preflight
error, while foreground Codex and relay message delivery continued working.
The hook retried each early failure, and the browser called terminal job ages
"running" time, obscuring both the cause and the short duration.

## Changes

- Validate the registered absolute working directory and launch there. Add
  `--skip-git-repo-check` only when that directory is outside Git. Preserve
  sandbox/approval settings and exact-session resume selection.
- Recognize Git preflight rejection, missing executable, unavailable workspace,
  and missing resumable session as permanent startup failures (EX_CONFIG 78).
  A private temporary file carries only an allowlisted failure code to the
  notifier. The durable reason contains fixed text, never raw stderr. The file
  is removed when the job settles; unknown/transient early failures retain
  bounded retries, and new mail can still trigger another wake.
- Show failure reasons on cards and in detail, freeze terminal duration at
  completion, and label current working directories on cards and identities.
  Current registration metadata is explicitly distinct from historical run
  metadata. Existing records without a reason retain an honest exit-code fallback.
- Correct an August-dated test fixture that now falls outside mail retention.

## Verification before deployment

- `npm test`: 183 passed, zero failures or skips. The first run exposed the
  expired fixture and a timeout test that passed on focused rerun and the full
  rerun; the timeout implementation and assertion were not changed.
- Regression tests execute the real Bash launcher and Node runner with a fake
  Codex executable in Git and non-Git directories, including spaces. Missing
  workspace fails without falling back to the daemon directory.
- Real notifier/credential/job-store test verifies one durable permanent
  failure, no retries, credential cleanup, and a subsequent independent wake.
- Browser renderers verified for failure text, current directory, active timing,
  terminal duration, and details. Live snapshot passes protocol validation.
- Shell syntax and `git diff --check` pass. Local relay health passes all eight
  checks; no delegates were active at the pre-deployment check.

CODEX20 still registered `install-and-start-https-github-com` at verification
time. This change exposes that fact; it does not silently repoint an identity
to another repository. Historical failed jobs and messages are preserved.
