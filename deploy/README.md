# Run the dashboard as a background service (macOS, launchd)

This sets up the dashboard to run natively on your Mac and start on its own
after a reboot, using a launchd LaunchAgent.

## Why native and not Docker

The dashboard marks a session "live" by checking whether its Claude Code
process is still running on this machine. It also runs the write actions
(Kill, Reveal folder, Resume in terminal, Open in desktop) against host
processes and macOS apps. A Docker container has its own process namespace and
cannot see host processes, so in Docker every session shows as "open" but never
"live", and the write actions do nothing. Run it natively to keep those
features.

You still get restart on reboot: the LaunchAgent starts at login and restarts
the process if it exits.

## Install

Run these from the repo root. They read your node path and repo path, fill in
the placeholders in the example plist, and write the result to
`~/Library/LaunchAgents`.

```bash
NODE_BIN="$(which node)"
REPO_DIR="$(pwd)"
NODE_DIR="$(dirname "$NODE_BIN")"

mkdir -p ~/Library/LaunchAgents ~/Library/Logs

sed -e "s|{{NODE_BIN}}|$NODE_BIN|g" \
    -e "s|{{NODE_DIR}}|$NODE_DIR|g" \
    -e "s|{{REPO_DIR}}|$REPO_DIR|g" \
    -e "s|{{HOME}}|$HOME|g" \
    deploy/com.claude-code-dashboard.plist \
    > ~/Library/LaunchAgents/com.claude-code-dashboard.plist
```

Load and start it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-code-dashboard.plist
launchctl enable gui/$(id -u)/com.claude-code-dashboard
```

Open <http://localhost:4317>.

## Verify

```bash
# Should list the label with a PID and last exit code 0.
launchctl print gui/$(id -u)/com.claude-code-dashboard | grep -E "state|pid|last exit"

# The service answers on the port.
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:4317/api/state
```

Logs go to `~/Library/Logs/claude-code-dashboard.log`.

## Update after pulling new code

launchd runs the code in place, so a normal restart picks up changes:

```bash
launchctl kickstart -k gui/$(id -u)/com.claude-code-dashboard
```

## Change the port

Edit `PORT` in `~/Library/LaunchAgents/com.claude-code-dashboard.plist`, then
run the `kickstart` command above. If you move the repo or switch node version,
re-run the install step so the paths are current.

## Stop and uninstall

```bash
# Stop and unload.
launchctl bootout gui/$(id -u)/com.claude-code-dashboard

# Remove the agent so it does not come back on next login.
rm ~/Library/LaunchAgents/com.claude-code-dashboard.plist
```

## Note on node version managers

If node comes from nvm, `which node` points at a versioned path such as
`~/.nvm/versions/node/v22.x/bin/node`. The install step captures that exact
path. If you later remove or change that node version, re-run the install step
so the plist points at a node that still exists.
