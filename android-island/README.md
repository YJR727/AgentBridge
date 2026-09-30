# Android notification island compatibility build

This is a separate Android compatibility-test application for devices that implement Xiaomi HyperOS notification-island extensions. It uses its own package ID and app data, so it can be installed alongside the regular Agent Bridge Android app.

## Install and pair

1. Build or obtain the compatibility APK and install it alongside the standard app.
2. In the desktop control window, choose **Add device** and enter the new pairing code in the test app. Do not choose **Re-pair** unless you intend to revoke existing devices.
3. Enable notifications and the background connection, then select a chat.
4. Open **Settings → Notification island test**, check the reported system capabilities, and send a local display test.

Local display tests create only local notifications; they do not send Codex commands or approve a real request.

## Limitations

The app can attach the platform's notification metadata, but that alone does not grant permission to display a notification as an island. Platform support, app registration, signatures, review, allow-listing, and device-specific policy may apply. If the system does not accept the island presentation, the ordinary notification remains available. This build does not claim official Xiaomi approval or guarantee island display.

Island support does not change the Agent Bridge network or pairing model. Tailscale, the desktop service, notification permission, and Android background settings are still required. Verify lock-screen display and background behavior on the target device.

## Build and checks

Run from the repository root:

```powershell
powershell -NoProfile -File android-island/build.ps1
```

The script reuses the Android source and local build tools where available. Signing keys and downloaded build tools are kept outside source control. The APK build and automated checks do not replace device testing.

## Official references

- [Xiaomi HyperOS developer guide](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=2131)
- [Xiaomi app integration process](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=2132)
