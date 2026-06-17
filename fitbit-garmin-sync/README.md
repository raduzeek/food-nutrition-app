# Fitbit → Garmin Weight Sync

Syncs weight and body composition data from Fitbit Aria scale to Garmin Connect. Runs as a Docker container on Synology NAS (DSM 7.x + Container Manager).

## What it syncs

- Weight (kg)
- Body fat (%)
- BMI

## Setup

### Step 1: Create a Fitbit Developer App

1. Go to https://dev.fitbit.com/apps/new
2. Fill in:
   - **Application Name**: Garmin Sync (or anything)
   - **Application Type**: Personal
   - **Callback URL**: `http://localhost:8080/callback`
   - **OAuth 2.0 Application Type**: Personal
3. Note your **Client ID** and **Client Secret**

### Step 2: Create directory on Synology

```bash
mkdir -p /volume1/docker/fitbit-garmin-sync/data
```

### Step 3: Configure docker-compose.yml

Copy `docker-compose.yml` to `/volume1/docker/fitbit-garmin-sync/` and fill in your credentials:

```yaml
services:
  fitbit-garmin-sync:
    build: .
    container_name: fitbit-garmin-sync
    restart: unless-stopped
    volumes:
      - /volume1/docker/fitbit-garmin-sync/data:/app/data
    environment:
      - FITBIT_CLIENT_ID=your_client_id
      - FITBIT_CLIENT_SECRET=your_client_secret
      - GARMIN_EMAIL=your@email.com
      - GARMIN_PASSWORD=your_password
      - SYNC_INTERVAL_SECONDS=3600
      - TZ=Europe/Prague
```

### Step 4: First run - Fitbit OAuth setup

```bash
cd /volume1/docker/fitbit-garmin-sync
docker compose up
```

Check the logs for the Fitbit authorization URL:

```
[2026-06-17 08:00:00 CEST] INFO: FITBIT AUTHORIZATION REQUIRED
[2026-06-17 08:00:00 CEST] INFO: Open this URL in your browser:
[2026-06-17 08:00:00 CEST] INFO: https://www.fitbit.com/oauth2/authorize?...
```

1. Open the URL in your browser
2. Authorize the app
3. You'll be redirected to `http://localhost:8080/callback?code=XXXXXX`
4. Copy the `code` parameter value from the URL
5. Stop the container:
   ```bash
   docker compose stop
   ```
6. Add the code to your `docker-compose.yml` environment:
   ```yaml
   - FITBIT_AUTH_CODE=paste_your_code_here
   ```
7. Start again:
   ```bash
   docker compose up -d
   ```
8. After successful auth, remove `FITBIT_AUTH_CODE` from `docker-compose.yml` (tokens are now stored in `data/config.json`)

### Step 5: Verify

```bash
docker logs fitbit-garmin-sync --tail 50
```

You should see:

```
[2026-06-17 08:00:00 CEST] INFO: Fitbit→Garmin sync starting
[2026-06-17 08:00:00 CEST] INFO: Sync interval: 3600 seconds
[2026-06-17 08:00:01 CEST] INFO: Starting sync from 2026-03-19 to 2026-06-17
[2026-06-17 08:00:02 CEST] INFO: Fetched 23 entries from Fitbit
[2026-06-17 08:00:03 CEST] INFO: ✓ 2026-06-15: 87.3 kg | 22.1% fat | BMI 26.4 → Garmin OK
[2026-06-17 08:00:04 CEST] INFO: Sync complete: 23 uploaded, 0 skipped, 0 errors
[2026-06-17 08:00:04 CEST] INFO: Next sync: 2026-06-17 09:00:00 CEST
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `FITBIT_CLIENT_ID` | (required) | Fitbit app client ID |
| `FITBIT_CLIENT_SECRET` | (required) | Fitbit app client secret |
| `GARMIN_EMAIL` | (required) | Garmin Connect email |
| `GARMIN_PASSWORD` | (required) | Garmin Connect password |
| `SYNC_INTERVAL_SECONDS` | `3600` | Seconds between sync runs |
| `TZ` | `Europe/Prague` | Timezone for timestamps |
| `FITBIT_AUTH_CODE` | (optional) | One-time OAuth code for first auth |

## Data storage

All persistent data is stored in `/app/data/` (mapped to `/volume1/docker/fitbit-garmin-sync/data/`):

- `config.json` - OAuth tokens, Garmin session, last sync date
- `sync.log` - Rotating log file (max 5MB, 3 backups)

## How it works

1. On first run, fetches the last 90 days of weight data from Fitbit
2. On subsequent runs, fetches only data since the last sync
3. Checks Garmin Connect for existing entries to avoid duplicates
4. Uploads new entries to Garmin Connect
5. Repeats on the configured interval

## Troubleshooting

**Fitbit token expired**: Tokens auto-refresh. If refresh fails, delete `config.json` and re-do the OAuth flow.

**Garmin login fails**: Check credentials. If Garmin requires MFA, disable it or log in via browser first.

**No data synced**: Check that your Fitbit Aria scale is syncing data to the Fitbit app first.
