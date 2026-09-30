# FAQ and troubleshooting

## Tailscale and connection

### Is Tailscale mandatory?

Tailscale is the documented setup and the one used by the current desktop guides. The service itself needs a private, reachable HTTPS route from the mobile device. Another VPN could provide network reachability, but it still needs valid HTTPS for the mobile web app and must keep the service private; that setup is not documented or tested here.

### How do I configure Tailscale Serve?

First start Agent Bridge on the computer. Check that the local service responds at `http://127.0.0.1:4571/api/health`. Then inspect the current Serve configuration before changing it, so an existing route is not overwritten:

```sh
tailscale serve status
tailscale serve --bg http://127.0.0.1:4571
```

Follow Tailscale's prompt to enable HTTPS if needed. Use the HTTPS `*.ts.net` address shown by your own Tailscale setup in the mobile app. Do not use Funnel or expose port `4571` directly. On macOS, see [the Mac guide](../desktop-mac/README.md) for the app-bundled Tailscale CLI path. Refer to [Tailscale's Serve documentation](https://tailscale.com/docs/reference/tailscale-cli/serve) if your installed CLI reports different syntax.

### I see `read timeout`, `unable to resolve host`, or no chat list

Check these in order:

1. The computer and mobile device are online in the same tailnet.
2. Agent Bridge is running on the computer and `http://127.0.0.1:4571/api/health` succeeds there.
3. Tailscale Serve shows the expected HTTPS route to `127.0.0.1:4571`.
4. The mobile app uses the computer's full `https://…ts.net` address, with no extra path or trailing API segment.
5. Codex is open on the computer. Open the target chat there, then refresh the chat list on mobile.

If the local health check works but the mobile device cannot resolve the host, verify the exact Tailscale DNS name and that Tailscale is connected on both devices. A timeout often indicates the service, Serve route, VPN path, or device background connection is unavailable; it does not by itself identify which one failed.

## Codex integration

### Do I need to install the Agent Bridge plugin in Codex?

No plugin is required for the mobile bridge itself. The phone communicates with the Agent Bridge service running beside the Codex desktop app. The optional skill under `plugin/agent-bridge/` provides Agent Bridge setup guidance to an assistant; it is not the desktop transport.

### Why does it work only with chats available on this computer?

Agent Bridge connects to the local Codex desktop and its local chats. It does not connect to an arbitrary cloud conversation or control another computer's Codex session. Open the desired chat in Codex first if it is not listed.

### Is the Codex connection a stable public API?

No. The current desktop integration uses a local IPC interface that is not documented here as a stable public API. Codex updates may change it. The optional App Server work is experimental and does not yet replace the current desktop integration. Private hosting does not settle third-party product terms or compatibility questions.

## Notifications and approvals

### Why are mobile notifications delayed or missing?

Delivery depends on the computer service, Tailscale, mobile network, notification permissions, and the operating system's background rules. On Android, keep the visible background connection enabled and allow the system's required background/battery permissions. On iPad, add the web app to the Home Screen, allow notifications, and open it from its icon. Neither platform can guarantee delivery while offline or suspended.

### Does tapping approve run arbitrary commands?

The mobile client answers a pending request associated with the selected local Codex chat. Read the request details before responding. Pair only devices you trust, and verify the result in the original Codex chat.

## Builds and files

### Why are local data, keys, or build outputs missing from Git?

They are machine-specific or sensitive and are intentionally excluded by `.gitignore`. Pairing data, certificates, signing keys, and personal service configuration should remain on the computer that owns them.

### Why does macOS warn that the app cannot be verified?

The current Mac build is an experimental local build and may use an ad-hoc signature without Apple notarization. Use only a build you created or otherwise trust. The Mac guide documents building and its current validation limits.

### Can I redistribute or sell this project?

There is no license file, so this repository does not grant redistribution rights. A private GitHub repository only controls who can view the source; it does not grant rights to third-party names, software, or interfaces used by the project.
