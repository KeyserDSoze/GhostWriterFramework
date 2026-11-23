# Settings, privacy and recovery

Narrarium does not store your book or credentials on Narrarium servers. GitHub stores the book; your Drive stores private settings and app data; configured AI providers process AI requests.

## Staying signed in to Google Drive and OneDrive

Account & Sync connects with **long-lived credentials** when the Narrarium token service is available, so you do not have to sign in again every hour. The service is a Cloudflare Worker that keeps the Google and Microsoft client secrets and renews tokens for your browser; it stores nothing. Your browser keeps the refresh token, only if you chose **Remember connection on this device**, sealed with a key that cannot be exported. It never goes into synced data, exports or logs. This protects the stored copy, not against a script running in the page.

- **Google:** no expiry until you revoke access (the app must be published, otherwise 7 days). **Microsoft:** 90 days, renewed at every use.
- **Disconnect** forgets the credentials on this device and revokes Google's; Microsoft's can only be revoked from your Microsoft account.
- Without the service nothing changes: the usual one-hour (Google) or 24-hour (Microsoft) sign-in applies and no offer appears.

## Settings

Configure AI Integrations, AI Router, Deep Search, Copilot tools, GitHub credentials, speech and local repository synchronization. Book-specific settings control branches, dedicated PATs, reader/export metadata and Drive export destinations.

## Migration and deletion

The migration page copies Narrarium cloud data between Google and Microsoft accounts. Cloud-data deletion does not delete GitHub repositories.

## Recovery

Repository tools provide backup ZIP, remote-wins pull, local-source-of-truth repair, reclone and incomplete-clone healing. Keep GitHub and local backups for important projects.
