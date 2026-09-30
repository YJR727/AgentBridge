# Agent Bridge

Agent Bridge connects a phone or iPad to Codex running on your own computer. It lets you send a message to an existing Codex chat, read its latest reply, and review questions or approval requests from a mobile device.

This is a personal, experimental project. The repository is private and currently has no open-source license.

## What is included

| Component | Location | Notes |
| --- | --- | --- |
| Windows desktop control app | `desktop/` | Native C# / WPF window; packages the local Node.js service. |
| Local bridge service | project root, `lib/`, `hook.mjs` | Node.js service; no npm runtime dependencies. |
| Android app | `android/` | Native APK source and build script. |
| iPad web app | `public/` | Installable Safari web app (PWA). |
| macOS desktop app | `desktop-mac/` | SwiftUI source and Mac build scripts. Build and device integration are experimental. |
| Product website | `website/` | Static introduction and help pages with the current packaged downloads. |

## How it works

```text
Codex on your computer
        │ local desktop connection
Agent Bridge service (127.0.0.1:4571)
        │ HTTPS through Tailscale Serve
Android app / iPad web app
```

The service stays on the computer and listens on loopback. Tailscale provides the private network path between the computer and mobile devices. Agent Bridge does not run a hosted relay or store chats in a cloud service. Any paired device can send messages and respond to the supported questions or approval requests, so only pair devices you trust.

The current Codex desktop integration uses a local desktop IPC interface whose compatibility may change with Codex updates. It is not a stable public Codex API. Check the current platform notes before relying on a particular Codex version; this project is not affiliated with OpenAI or Tailscale.

## Quick start

1. Install and sign in to Tailscale on the computer and mobile device. They must be on the same tailnet.
2. Install and open Codex on the computer, then open the chat you want to control.
3. Install Agent Bridge for your platform and start its computer service. The Windows app and the Mac source build provide a desktop control window; Android and iPad connect to that computer service.
4. Configure Tailscale Serve to forward HTTPS traffic to `http://127.0.0.1:4571`. See [Tailscale and connection troubleshooting](docs/FAQ.md#tailscale-and-connection).
5. In the desktop control window, create a pairing code. Enter the computer's HTTPS address and code in the Android or iPad app.
6. Select a chat on the mobile device. Send a message, read the response, or open **To-do** to inspect and answer a request.

See the platform guides for full setup details:

- [Windows desktop](desktop/README.md)
- [Android](android/README.md)
- [macOS](desktop-mac/README.md)
- [Common questions and troubleshooting](docs/FAQ.md)
- [Product website](website/README.md)

## Build and test

Requirements vary by platform. The local service requires Node.js 20.11 or newer. The Android and Mac builds also need their platform build tools; the Mac application must be built on macOS.

```sh
npm test
```

Platform-specific build and verification commands are documented in each platform guide. Automated tests use isolated local data; they do not prove that notifications will always arrive or that every Codex version remains compatible.

## Security and privacy

- Keep the service bound to loopback and use a private VPN path. Do not expose port `4571` directly to the public internet or configure Tailscale Funnel for it.
- A paired device can control supported actions in the selected Codex chats. Re-pair if a device is lost or no longer trusted.
- Local pairing state, push credentials, logs and runtime data live under `data/` and are excluded from Git. Signing keys and downloaded build tools are also excluded.
- Review changes to hooks and trust them only when you understand what they do. See `hook.mjs`, `hooks.template.json` and `tools/install.mjs`.
- Do not commit pairing codes, private keys, certificates, personal Tailscale addresses, local logs or chat contents.

See [SECURITY.md](SECURITY.md) for reporting guidance. No `LICENSE` file is provided, so this repository does not grant permission to redistribute or reuse the code.

## Project status

Windows, Android and iPad have been used in the existing setup. The macOS app and its Codex integration remain experimental and require validation on the target Mac and Codex version. Notification delivery depends on the network and mobile operating system's background rules; delivery is not guaranteed.
