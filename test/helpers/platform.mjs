/**
 * Shared platform gates for tests.
 *
 * A gate here always names behaviour that is *intentionally* different on the
 * excluded platform, never a test that merely happens to be inconvenient. Each
 * one carries the reason so a skipped test reads as a documented decision
 * rather than as coverage quietly going missing.
 */

/**
 * For tests that assert the *success* path of the worktree fleet.
 *
 * The fleet refuses to invoke Git unless it can prove that every component of
 * the path is owned by a trusted user and not writable by anyone else. Windows
 * exposes no uid to build that proof from, so `create`/`remove`/`prune` fail
 * closed there with `INSECURE_CONTAINMENT` by design. The fail-closed behaviour
 * itself is asserted separately and runs everywhere.
 */
export const POSIX_OWNERSHIP_ONLY = process.platform === "win32"
  ? "worktree fleet requires POSIX ownership semantics; it fails closed on Windows by design"
  : false;

/**
 * For tests that stage an attack by renaming or replacing a directory that
 * still has an open handle inside it. Windows refuses that rename outright, so
 * the scenario cannot be constructed there — the OS blocks it one layer earlier
 * than the code under test does.
 */
export const POSIX_OPEN_HANDLE_RENAME_ONLY = process.platform === "win32"
  ? "cannot be staged: Windows refuses to rename a directory holding an open handle"
  : false;

/**
 * For tests that signal a whole process group. `process.kill(-pid)` returns
 * `ESRCH` on Windows, which has no POSIX process groups.
 */
export const POSIX_PROCESS_GROUPS_ONLY = process.platform === "win32"
  ? "requires POSIX process groups; process.kill(-pid) returns ESRCH on Windows"
  : false;
