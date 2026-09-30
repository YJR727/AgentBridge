# Security policy

Agent Bridge is a personal project and this repository is private. If you find a security issue, do not post credentials, pairing data, chat contents, or an exploit in a public place. Contact the repository owner through a private channel and include only the details needed to reproduce the issue.

Treat the following as secrets and keep them out of commits and screenshots:

- `data/` and mobile pairing codes or tokens
- push subscription details and VAPID private keys
- Android signing keys, `.p12` files, provisioning profiles, and certificate passwords
- personal Tailscale hostnames, local logs, and Codex chat data

The service is intended to stay on `127.0.0.1` and be reached over a private network. Do not expose it directly to the public internet. A paired device can send messages and answer supported requests in Codex, so remove access by re-pairing if a device is no longer trusted.

Keeping this repository private limits who can view its source; it does not establish that an integration is supported by a third-party product or that its terms permit a particular use. The current Codex desktop IPC integration is experimental and may change.
