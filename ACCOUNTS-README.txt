MUSE AI - LOCAL ACCOUNTS

FIRST START
1. Stop the previous server (Ctrl+C) and start: node app.js
2. The terminal prints a one-time owner setup code.
3. Open http://localhost:3000 in the browser you normally use.
4. Choose a username and a password of at least 12 characters.
5. Enter the setup code. Your existing library, backups, songs, recordings
   and job records are COPIED into this owner account. Originals are kept.
6. Save the recovery code somewhere private. It is shown only once.
7. Click "I saved my code - open my library". Wait for the saved indicator.

OTHER ACCOUNTS
Sign out, choose Create account, and create a separate username/password.
Each new account starts with an empty library and its own recordings.
Signing into one account does not grant access to another account's songs.
Song Share links are now private links; they require the owning account.
Signing out stops playback. Other tabs reload when the account changes.
Private API calls check the signed-in account as well as the tab identity.

PASSWORDS AND RECOVERY
Passwords are stored as salted scrypt hashes, never as plain passwords.
Use Password in the sidebar to change your password.
Forgot password uses your username, recovery code and a new password.
Recovery codes work once; save the replacement code after a reset.
Password changes and resets sign out other sessions.
There is no email reset service. Keep your recovery code safe.
Sessions expire after 24 hours. Repeated login attempts are rate-limited.

FILES AND BACKUPS
accounts/accounts.sqlite (plus its WAL/SHM files while running) holds the
account database and sessions.
users/<account-id>/ holds that account's library, songs, recordings and
backups. The library Backups button only restores your current account.
For an external full backup, STOP THE SERVER and copy accounts/ and users/
to your backup drive. Keep the original legacy files until you have verified
the owner migration. Do not delete accounts/ to reset a password.

LIMITS OF THIS RELEASE
This is a local-only app listening on 127.0.0.1. Do not expose it to the
internet or put it behind a public proxy yet. HTTPS, deployment review,
verified signup and real billing are still future work.
Files and the account database are not encrypted on disk. Someone with
access to your Windows files can read them; app accounts do not replace
Windows account security or disk encryption.
All accounts currently use this server's Replicate key. Demo credits are
not a payment system or an enforced allowance.
