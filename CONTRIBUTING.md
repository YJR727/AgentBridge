# Contributing

This is currently a private, single-maintainer project. Changes should stay small and preserve the separation between the local computer service and paired mobile clients.

Before proposing a change:

1. Read the relevant platform guide and inspect the existing behavior.
2. Avoid adding a runtime dependency when Node.js or the platform standard library already provides the needed feature.
3. Run `npm test` for changes to the service, hooks, or shared web client. Run the platform-specific checks documented in that platform's README when changing a native app or installer.
4. Do not include machine-specific data, user chat contents, credentials, signing material, or generated build folders.

There is no `LICENSE` file. Do not assume that code from this private repository may be redistributed.
