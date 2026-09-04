#!/usr/bin/env bash
# Muscle-memory wrapper: `./start.sh` builds the extension and opens the Extension
# Development Host with it loaded — repo-tour's `start.sh` is the shape this mirrors.
#
# This is the DOUBLE-CLICKABLE entrypoint. When launched from a file manager / desktop
# shortcut, the OS opens a throwaway terminal that closes the instant the script exits — so
# the summary flashes up and vanishes before you can read it. To prevent that we pause at the
# end whenever we're attached to an interactive terminal. The pause is skipped automatically
# when non-interactive (piped, CI, or run by a tool) and can be disabled with
# BUILD_TUTORIALS_NO_PAUSE=1.
#
# repo-tour's `start.sh` leaves a server running; this one does not — closing the editor
# window is closing the app. The real control script is `./build-tutorials` (dev | build |
# test | doctor | package) — run that directly if you do not want the pause.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$ROOT/build-tutorials" dev "$@"
rc=$?

# Keep a double-clicked / spawned terminal window open so the output stays visible.
# Requires an interactive tty on both stdin and stdout so redirected/piped runs (and this
# repo's own automated invocations) return immediately instead of hanging.
if [ -z "${BUILD_TUTORIALS_NO_PAUSE:-}" ] && [ -t 0 ] && [ -t 1 ]; then
  echo
  read -rp "Press Enter to close this window… " _ || true
fi
exit "$rc"
