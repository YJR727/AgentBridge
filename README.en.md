<div align="center">
  <img src="website/assets/mark.svg" alt="Agent Bridge mark" width="76" height="76">
  <h1>Agent Bridge</h1>
  <p><strong>Take Codex on your computer with you.</strong></p>
  <p>Connect your own computer to Android, iPhone, or iPad to continue existing chats, read replies, and handle questions or approvals.</p>
  <p>
    <a href="https://yjr727.github.io/AgentBridge/">Product site & downloads</a> ·
    <a href="docs/FAQ.md">FAQ</a> ·
    <a href="README.md">简体中文</a>
  </p>
</div>

<p align="center">
  <img alt="Node.js 20.11+" src="https://img.shields.io/badge/Node.js-20.11%2B-43853d?logo=node.js&logoColor=white">
  <img alt="Windows" src="https://img.shields.io/badge/Windows-desktop-0078D4?logo=windows&logoColor=white">
  <img alt="Android" src="https://img.shields.io/badge/Android-mobile-3DDC84?logo=android&logoColor=white">
  <img alt="macOS Apple Silicon" src="https://img.shields.io/badge/macOS-Apple%20Silicon-111111?logo=apple&logoColor=white">
</p>

> Personal experimental project. Project code is licensed under GNU GPL-3.0-only; third-party components retain their respective licenses. The macOS preview supports Apple Silicon only.

## How it works

```text
┌──────────────────────┐      Local loopback     ┌──────────────────────┐
│ Codex desktop app    │ ◀────────────────────▶ │ Agent Bridge service │
└──────────────────────┘                         │ 127.0.0.1:4571       │
                                                 └──────────┬───────────┘
                                                            │
                                                    Tailscale Serve HTTPS
                                                            │
                                                 ┌──────────▼───────────┐
                                                 │ Android / iPhone /   │
                                                 │ iPad                 │
                                                 └──────────────────────┘
```

The service runs on your computer and listens only on loopback. Tailscale provides a private network path to your mobile devices. Agent Bridge does not run a cloud relay or store chats in the cloud. Pair only devices you trust.

## Downloads

| Platform | Download / guide | Status |
| --- | --- | --- |
| Windows | [Download for Windows](https://yjr727.github.io/AgentBridge/) · [Guide](desktop/README.md) | Preview · x64 |
| Android | [Download Android APK](https://yjr727.github.io/AgentBridge/) · [Guide](android/README.md) | Preview |
| macOS | [Download for Mac](https://yjr727.github.io/AgentBridge/) · [Guide](desktop-mac/README.md) | Preview · M-series and newer only |
| iPhone / iPad | [iPhone/iPad instructions](https://yjr727.github.io/AgentBridge/) · [Connection guide](docs/FAQ.md#tailscale-and-connection) | Add to Home Screen from Safari |

Packages have not been validated on every device. The Mac DMG uses a local test signature and is not notarized, so macOS may show a security prompt on first launch. The current Mac package does not support Intel Macs.

## Quick start

1. Install and sign in to Tailscale on your computer and mobile device; join the same tailnet.
2. Install and open Codex on the computer, then open the chat you want to continue.
3. Install and start Agent Bridge for your computer platform.
4. Configure Serve HTTPS to forward to `http://127.0.0.1:4571` using the [connection FAQ](docs/FAQ.md#tailscale-and-connection).
5. Generate a pairing code on the computer and enter its HTTPS address and code on Android or iPad.
6. Select a chat on mobile to read replies, send messages, or handle pending requests.

See the platform guides for [Windows](desktop/README.md), [Android](android/README.md), and [macOS](desktop-mac/README.md).

## Project layout

| Directory / file | Contents |
| --- | --- |
| `desktop/` | Windows desktop app and installer |
| `desktop-mac/` | macOS SwiftUI app and build scripts |
| `android/` | Android mobile app |
| `android-island/` | Android notification and chat status component |
| `public/` | iPhone / iPad Safari web app |
| `website/` | Product site, guides, and current packages |
| `lib/`, `server.mjs` | Local bridge service |
| `plugin/` | Agent Bridge Codex plugin |
| `tests/` | Node.js service and utility tests |
| `docs/` | FAQ and project documentation |

## Development

The local service requires Node.js 20.11 or newer. Run the test suite with:

```sh
npm test
```

Building Windows, Android, and macOS apps requires platform-specific tools. The macOS app must be built on a Mac. Passing tests does not confirm compatibility with every Codex version, device, or background notification behavior.

## Security & privacy

- The service listens only on loopback. Do not expose port `4571` directly to the internet or enable Tailscale Funnel for it.
- Paired devices can use supported controls in the selected Codex chat. Pair only trusted devices.
- Pairing state, push credentials, logs, and runtime data live in `data/`, which is excluded from Git.
- Do not commit signing keys, certificates, or build tools. Review `hook.mjs`, `hooks.template.json`, and `tools/install.mjs` before changing hooks.
- The project connects through a local Codex desktop IPC interface. It is not a stable public API and may change with Codex updates.

For security reports, see [SECURITY.md](SECURITY.md). Agent Bridge is not affiliated with or endorsed by OpenAI or Tailscale. Project code is licensed under [GNU GPL-3.0-only](LICENSE); third-party components remain under their respective licenses.

