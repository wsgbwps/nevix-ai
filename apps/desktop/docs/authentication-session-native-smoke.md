# Authentication Session and Remembered Email native credential-backend smoke

Run this checklist on a packaged Desktop build against a disposable identity server
(Go server + PostgreSQL, provisioned by the delivery documentation). Use a
test User and a fresh operating-system account or disposable virtual machine. Never record the
password, session token, response body, or decrypted Session in the
evidence.

Passing the Ubuntu/Xvfb Playwright lane does not prove Linux Secret Service support. Record a
platform as supported only after its row below has evidence from the named native backend.

## Backends and prerequisites

| Platform | Required backend               | Prerequisite                                                                                                     |
| -------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| macOS    | Keychain                       | The login Keychain is unlocked and available to the packaged app.                                                |
| Windows  | DPAPI                          | The smoke runs under the same Windows User for sign-in and relaunch.                                             |
| Linux    | `gnome_libsecret` or `kwallet` | A controlled desktop session has a working Secret Service; `basic_text` is a failure, not encrypted persistence. |

Use the platform's application-data directory and locate only `authentication-session.enc` and
`authentication-remembered-email.enc` beneath the packaged app's `userData` directory. Typical parent directories are
`~/Library/Application Support/Nevix AI` on macOS, `%APPDATA%\Nevix AI` on Windows, and
`~/.config/Nevix AI` on Linux. Confirm the actual location for the artifact under test before
collecting evidence.

## Smoke procedure

1. Start with a fresh `userData` directory and confirm that neither Authentication encrypted file
   exists. Launch the packaged app and confirm the login form has an empty focused email field and
   a selected **Remember email** checkbox.
2. Sign in with the disposable verified User and confirm the app shell is visible.
3. Confirm both encrypted files exist. Parse each as JSON and verify that it contains only
   `version: 1` and a non-empty base64 `ciphertext`. Search the file as bytes and text and confirm it
   contains no email address or password; additionally confirm the Session file contains no
   session `token` value or complete Session JSON.
4. Save a checksum of each ciphertext envelope without copying its contents into the evidence.
5. Quit the app normally, relaunch it with the same operating-system User and `userData`, and
   confirm the restoring boundary appears before the app shell.
6. Confirm the app shell appears only while the server is reachable. The opaque session token
   does not rotate on restore, so the envelope checksum is unchanged by a successful restoration.
7. Quit again, make the Auth origin unreachable, and relaunch. Confirm the retryable restore screen
   appears, the app shell remains hidden, and the envelope checksum is unchanged.
8. Restore connectivity, select **Retry**, confirm the app shell appears, and confirm the envelope
   checksum is unchanged.
9. Select **Sign out of this device**. Confirm the login screen appears, the authoritative email is
   prefilled with password focus, `authentication-session.enc` is deleted, and
   `authentication-remembered-email.enc` remains unchanged.
10. Relaunch with the same `userData` and confirm the app remains signed out with the same prefill.
    Clear **Remember email**, confirm its encrypted file is deleted immediately, reselect the
    checkbox, edit the email without signing in, then relaunch; confirm the field is empty, the
    checkbox defaults selected, and focus returns to email.
11. Sign in again, then repeat step 9 while the server is unreachable. Confirm the app immediately returns to
    login, shows the remote-revocation-delay wording, deletes the file, and remains signed out after
    relaunch.

For Linux, additionally record `safeStorage.getSelectedStorageBackend()` from the smoke harness. A
result of `basic_text` must produce the secure-storage-unavailable explanation, create neither
Authentication encrypted file, retain a newly remembered email only until the app exits, and leave
the platform support row unclaimed.

## Evidence record

Attach the artifact version/commit, OS version, backend, date, operator, the pass/fail result for
each numbered step, and redacted screenshots or command output. Do not attach the Session envelope
or network trace.

| Platform/backend     | Evidence     | Support claim |
| -------------------- | ------------ | ------------- |
| macOS Keychain       | Not recorded | Not claimed   |
| Windows DPAPI        | Not recorded | Not claimed   |
| Linux Secret Service | Not recorded | Not claimed   |
