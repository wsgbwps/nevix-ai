# Authentication Session native credential-backend smoke

Run this checklist on a packaged Desktop build against a disposable Supabase Auth project. Use a
test User and a fresh operating-system account or disposable virtual machine. Never record the
password, access token, refresh token, publishable key, response body, or decrypted Session in the
evidence.

Passing the Ubuntu/Xvfb Playwright lane does not prove Linux Secret Service support. Record a
platform as supported only after its row below has evidence from the named native backend.

## Backends and prerequisites

| Platform | Required backend | Prerequisite |
| --- | --- | --- |
| macOS | Keychain | The login Keychain is unlocked and available to the packaged app. |
| Windows | DPAPI | The smoke runs under the same Windows User for sign-in and relaunch. |
| Linux | `gnome_libsecret` or `kwallet` | A controlled desktop session has a working Secret Service; `basic_text` is a failure, not encrypted persistence. |

Use the platform's application-data directory and locate only `authentication-session.enc` beneath
the packaged app's `userData` directory. Typical parent directories are
`~/Library/Application Support/Nevix AI` on macOS, `%APPDATA%\Nevix AI` on Windows, and
`~/.config/Nevix AI` on Linux. Confirm the actual location for the artifact under test before
collecting evidence.

## Smoke procedure

1. Start with a fresh `userData` directory and confirm that `authentication-session.enc` does not
   exist.
2. Launch the packaged app, sign in with the disposable verified User, and confirm the app shell is
   visible.
3. Confirm `authentication-session.enc` exists. Parse it as JSON and verify that it contains only
   `version: 1` and a non-empty base64 `ciphertext`. Search the file as bytes and text and confirm it
   contains no email address, `access_token`, `refresh_token`, or complete Session JSON.
4. Save a checksum of the ciphertext envelope without copying its contents into the evidence.
5. Quit the app normally, relaunch it with the same operating-system User and `userData`, and
   confirm the restoring boundary appears before the app shell.
6. Confirm the app shell appears only while the Supabase Auth origin is reachable. Confirm the
   envelope checksum changed after restoration, proving the refreshed, rotated Session was
   atomically re-encrypted.
7. Quit again, make the Auth origin unreachable, and relaunch. Confirm the retryable restore screen
   appears, the app shell remains hidden, and the envelope checksum is unchanged.
8. Restore connectivity, select **Retry**, confirm the app shell appears, and confirm the envelope
   checksum changes.
9. Select **Sign out of this device**. Confirm the login screen appears and
   `authentication-session.enc` is deleted.
10. Relaunch with the same `userData` and confirm the app remains signed out.
11. Repeat step 9 while the Auth origin is unreachable. Confirm the app immediately returns to
    login, shows the remote-revocation-delay wording, deletes the file, and remains signed out after
    relaunch.

For Linux, additionally record `safeStorage.getSelectedStorageBackend()` from the smoke harness. A
result of `basic_text` must produce the secure-storage-unavailable warning, create no Session file,
and leave the platform support row unclaimed.

## Evidence record

Attach the artifact version/commit, OS version, backend, date, operator, the pass/fail result for
each numbered step, and redacted screenshots or command output. Do not attach the Session envelope
or network trace.

| Platform/backend | Evidence | Support claim |
| --- | --- | --- |
| macOS Keychain | Not recorded | Not claimed |
| Windows DPAPI | Not recorded | Not claimed |
| Linux Secret Service | Not recorded | Not claimed |
