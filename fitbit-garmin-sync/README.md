# Fitbit/Google Health → Garmin Weight Sync

Syncs weight and body composition data from Fitbit Aria scale (via Google Health API) to Garmin Connect. Runs as a Docker container on Synology NAS (DSM 7.x + Container Manager).

> **Note:** Fitbit legacy Web API is deprecated (September 2026). This project uses the new
> Google Health API, which replaced Fitbit's developer platform. Fitbit Aria data flows
> through your Google account to Google Health API.

## What it syncs

- Weight (kg)
- Body fat (%)
- BMI (calculated)

## Setup

### Step 1: Migrate your Fitbit account to Google

If you haven't already, migrate your Fitbit account to a Google account at
https://www.fitbit.com/global/us/technology/google-migration — your Aria data
will then be accessible through Google Health API.

### Step 2: Create a Google Cloud project + OAuth credentials

1. Go to https://console.cloud.google.com
2. Create a new project (e.g. "Garmin Sync")
3. Go to **APIs & Services → Library**, search for **Google Health API**, enable it
4. Go to **APIs & Services → OAuth consent screen**:
   - User Type: **External**
   - Fill in app name, support email
   - Add scope: `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly`
   - Add your Google email as a **Test user** (required while app is unverified)
5. Go to **APIs & Services → Credentials**:
   - Click **Create Credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorized redirect URIs: `http://localhost:8080/callback`
6. Note your **Client ID** and **Client Secret**

### Step 3: Create directory on Synology

```bash
mkdir -p /volume1/docker/fitbit-garmin-sync/data
```

### Step 4: Copy project files to Synology

Copy the entire `fitbit-garmin-sync/` folder to `/volume1/docker/fitbit-garmin-sync/`.

### Step 5: Configure docker-compose.yml

Edit `docker-compose.yml` and fill in your credentials:

```yaml
services:
  fitbit-garmin-sync:
    build: .
    container_name: fitbit-garmin-sync
    restart: unless-stopped
    volumes:
      - /volume1/docker/fitbit-garmin-sync/data:/app/data
    environment:
      - GOOGLE_CLIENT_ID=your_client_id
      - GOOGLE_CLIENT_SECRET=your_client_secret
      - GARMIN_EMAIL=your@email.com
      - GARMIN_PASSWORD=your_password
      - SYNC_INTERVAL_SECONDS=3600
      - TZ=Europe/Prague
```

### Step 6: First run — Google OAuth setup

```bash
cd /volume1/docker/fitbit-garmin-sync
docker compose up
```

Check the logs for the Google authorization URL:

```
INFO: GOOGLE HEALTH API AUTHORIZATION REQUIRED
INFO: Open this URL in your browser:
INFO: https://accounts.google.com/o/oauth2/v2/auth?...
```

1. Open the URL in your browser
2. Sign in with the Google account linked to your Fitbit
3. Grant access to health metrics
4. You'll be redirected to `http://localhost:8080/callback?code=XXXXXX`
   (the page won't load — that's OK, just copy the URL)
5. Copy the `code` parameter value from the URL
6. Stop the container:
   ```bash
   docker compose stop
   ```
7. Add the code to your `docker-compose.yml` environment:
   ```yaml
   - GOOGLE_AUTH_CODE=paste_your_code_here
   ```
8. Start again:
   ```bash
   docker compose up -d
   ```
9. After successful auth, **remove `GOOGLE_AUTH_CODE`** from `docker-compose.yml`
   (tokens are stored in `data/config.json` and auto-refresh)

### Step 7: Verify

```bash
docker logs fitbit-garmin-sync --tail 50
```

Expected output:

```
[2026-06-17 08:00:00 CEST] INFO: Fitbit/Google→Garmin sync starting
[2026-06-17 08:00:00 CEST] INFO: Sync interval: 3600 seconds
[2026-06-17 08:00:01 CEST] INFO: Starting sync from 2026-03-19 to 2026-06-17
[2026-06-17 08:00:02 CEST] INFO: Fetched 23 entries from Google Health API
[2026-06-17 08:00:03 CEST] INFO: ✓ 2026-06-15: 87.3 kg | 22.1% fat → Garmin OK
[2026-06-17 08:00:04 CEST] INFO: Sync complete: 23 uploaded, 0 skipped, 0 errors
[2026-06-17 08:00:04 CEST] INFO: Next sync: 2026-06-17 09:00:00 CEST
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` | (required) | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | (required) | Google OAuth client secret |
| `GARMIN_EMAIL` | (required) | Garmin Connect email |
| `GARMIN_PASSWORD` | (required) | Garmin Connect password |
| `SYNC_INTERVAL_SECONDS` | `3600` | Seconds between sync runs |
| `TZ` | `Europe/Prague` | Timezone for timestamps |
| `GOOGLE_AUTH_CODE` | (optional) | One-time OAuth code for first auth |

## Data storage

All persistent data is stored in `/app/data/` (mapped to `/volume1/docker/fitbit-garmin-sync/data/`):

- `config.json` — OAuth tokens, Garmin session, last sync date
- `sync.log` — Rotating log file (max 5MB, 3 backups)

## How it works

1. On first run, fetches the last 90 days of weight + body fat data from Google Health API
2. On subsequent runs, fetches only data since the last sync
3. Merges weight and body fat entries by date
4. Checks Garmin Connect for existing entries to avoid duplicates
5. Uploads new entries to Garmin Connect
6. Repeats on the configured interval

## Troubleshooting

**Google token expired**: Tokens auto-refresh using the stored refresh token. If refresh fails,
delete `config.json` and re-do the OAuth flow (Steps 6–7).

**"Access blocked" during OAuth**: Make sure your Google email is added as a Test user
in the OAuth consent screen (Google Cloud Console → APIs & Services → OAuth consent screen → Test users).

**Garmin login fails**: Check credentials. If Garmin requires MFA, disable it or log in via browser first.

**No data synced**: Make sure your Fitbit account is migrated to Google and Aria data
appears in Google Health / Fitbit app.

**Rate limits**: The sync respects `Retry-After` headers and uses exponential backoff (3 retries).
