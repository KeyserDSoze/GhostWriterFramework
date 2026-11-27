# Settings, privacy and recovery

Narrarium does not store your book or credentials on Narrarium servers. GitHub stores the book; your Drive stores private settings and app data; configured AI providers process AI requests.

## Staying signed in to Google Drive and OneDrive

Account & Sync connects with **long-lived credentials** when the Narrarium token service is available, so you do not have to sign in again every hour. The service is a Cloudflare Worker that keeps the Google and Microsoft client secrets and renews tokens for your browser; it stores nothing. Your browser keeps the refresh token, only if you chose **Remember connection on this device**, sealed with a key that cannot be exported. It never goes into synced data, exports or logs. This protects the stored copy, not against a script running in the page.

- **Google:** no expiry until you revoke access (the app must be published, otherwise 7 days). **Microsoft:** 90 days, renewed at every use.
- **Disconnect** forgets the credentials on this device and revokes Google's; Microsoft's can only be revoked from your Microsoft account.
- Without the service nothing changes: the usual one-hour (Google) or 24-hour (Microsoft) sign-in applies and no offer appears.

## What Narrarium asks Google for

At every Google sign-in Narrarium asks only for **non-sensitive** permissions: who you are (`openid`, `profile`, `email`), `drive.appdata` (a hidden app folder) and `drive.file` (only the files and folders Narrarium creates in your Drive: the **Narrarium** folder with your account data and the folder your exports go to). Google needs no verification for them and shows no “unverified app” warning. The sign-in also tells Google not to add the permissions this account allowed under older versions (`include_granted_scopes=false`), so the old full-Drive permission is not dragged back into the consent.

- **Full access to Drive** (the restricted `drive` scope) is never asked at sign-in. It is asked only if you choose something that needs it: exporting into a folder that already existed, or recovering the chats of an older version that Google hides from Narrarium. The screen says why, Google will warn that the app is not verified for it, and the permission is kept only while the page is open; take it back at myaccount.google.com/connections.
- **When a sign-in ends**, the Google card says “Sign in to Google Drive again on this device”, why it ended (session credentials last about an hour; long-lived credentials renew in the background through the sign-in service) and offers the switch to long-lived credentials where the service is available. Your data stays safe on this device.
- **Check Google configuration** (in the Google card) shows the permissions the site asks for, the number of the Google Cloud project of its client id (never the rest), and the checklist for the owner of the project: **Audience** must be “In production” (in “Testing” only test users can sign in, and the sign-in expires after 7 days); the client id must belong to that project; the scopes in the console (Data access) must match the list; remove old grants at myaccount.google.com/connections before trying again.

## Automatic sync and “All synced”

At the top of **Account & Sync** the switch **Automatic sync for all services** turns the automatic sync on or off for every connected service at once. Each service also has its own switch: setting it makes that service ignore the general one (**Follow the general setting** gives it back). Connections made before this setting existed keep the value they had.

When everything is synced a service card says **All synced · last check 09:30** and shows no main **Sync** button: it appears only when there is something to do (changes not sent, newer data on the service, an error). **Check now** stays as a quiet button to look for changes made on another device.

## Settings

Configure AI Integrations, AI Router, Deep Search, Copilot tools, GitHub credentials, speech and local repository synchronization. Book-specific settings control branches, dedicated PATs, reader/export metadata and Drive export destinations.

## Migration and deletion

The migration page copies Narrarium cloud data between Google and Microsoft accounts. Cloud-data deletion does not delete GitHub repositories.

## Recovery

Repository tools provide backup ZIP, remote-wins pull, local-source-of-truth repair, reclone and incomplete-clone healing. Keep GitHub and local backups for important projects.
