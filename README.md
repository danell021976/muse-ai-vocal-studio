# Muse AI Vocal Studio

A local music creation app using MiniMax Music 2.6 on Replicate. Includes private local accounts, workspaces, song playback, editable titles, ratings, Trash and restore, library backups, credits, and test subscription/download bundles.

## Run on Windows

Install Node.js 24 or newer. Open PowerShell in this folder and run:

```powershell
npm install
$env:REPLICATE_API_TOKEN="YOUR_REPLICATE_TOKEN"
node app.js
```

Open http://localhost:3000. On first launch, use the setup code printed in the terminal to create the owner account. Keep the terminal open. The token must be set again in a new terminal session; never commit it to GitHub.

Create requests two songs for 10 app credits total, with 5 charged per successfully saved song. Lyrics support up to 3,500 characters and the combined style prompt supports 2,000. Replicate generation incurs real provider charges. Subscription and download purchases in this app are dummy purchases and do not collect money.

## Data and backups

Accounts, generated audio, recordings, library records, and credit databases are local private data and are excluded from this repository. To back up an existing installation, stop the server and copy its entire `accounts` and `users` folders, including any SQLite sidecar files, to a safe location. Updating source files must not overwrite these folders.

See [account setup](ACCOUNTS-README.txt), [library backups](LIBRARY-BACKUPS.txt), and [credits and plans](CREDITS-AND-PLANS.txt) for details.

This version runs on localhost. Test purchases, local account security, and download allowances require further production work before public hosting. Playback audio is not protected by DRM.
