import json
import os
import time
import logging
from datetime import datetime, timedelta
from urllib.parse import urlencode

import requests
import pytz
from garminconnect import Garmin

logger = logging.getLogger("fitbit-garmin-sync")

CONFIG_PATH = "/app/data/config.json"
GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_HEALTH_API = "https://health.googleapis.com/v4"
GOOGLE_HEALTH_SCOPE = "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly"
REDIRECT_URI = "http://localhost:8080/callback"
TIMEZONE = pytz.timezone(os.environ.get("TZ", "Europe/Prague"))

MAX_RETRIES = 3
BACKOFF_BASE = 5


def load_config():
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r") as f:
            return json.load(f)
    return {}


def save_config(config):
    with open(CONFIG_PATH, "w") as f:
        json.dump(config, f, indent=2)


def retry_request(func, *args, **kwargs):
    for attempt in range(MAX_RETRIES):
        try:
            response = func(*args, **kwargs)
            if response.status_code == 429:
                retry_after = int(response.headers.get("Retry-After", BACKOFF_BASE * (3 ** attempt)))
                logger.warning(f"Rate limited, retrying after {retry_after}s")
                time.sleep(retry_after)
                continue
            return response
        except requests.exceptions.RequestException as e:
            wait = BACKOFF_BASE * (3 ** attempt)
            logger.warning(f"Request failed (attempt {attempt + 1}/{MAX_RETRIES}): {e}, retrying in {wait}s")
            if attempt < MAX_RETRIES - 1:
                time.sleep(wait)
            else:
                raise
    return None


def get_google_auth_url(client_id):
    params = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": REDIRECT_URI,
        "scope": GOOGLE_HEALTH_SCOPE,
        "access_type": "offline",
        "prompt": "consent",
    }
    return f"{GOOGLE_AUTH_URL}?{urlencode(params)}"


def exchange_google_code(client_id, client_secret, auth_code):
    data = {
        "grant_type": "authorization_code",
        "code": auth_code,
        "redirect_uri": REDIRECT_URI,
        "client_id": client_id,
        "client_secret": client_secret,
    }
    resp = requests.post(GOOGLE_TOKEN_URL, data=data)
    resp.raise_for_status()
    return resp.json()


def refresh_google_token(client_id, client_secret, refresh_token):
    data = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": client_id,
        "client_secret": client_secret,
    }
    resp = requests.post(GOOGLE_TOKEN_URL, data=data)
    resp.raise_for_status()
    return resp.json()


def ensure_google_auth(config):
    client_id = os.environ.get("GOOGLE_CLIENT_ID", config.get("google_client_id", ""))
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", config.get("google_client_secret", ""))
    auth_code = os.environ.get("GOOGLE_AUTH_CODE", "")

    if not client_id or not client_secret:
        logger.error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set")
        return None

    config["google_client_id"] = client_id
    config["google_client_secret"] = client_secret

    if config.get("google_access_token") and config.get("google_token_expires_at"):
        expires_at = datetime.fromisoformat(config["google_token_expires_at"])
        if datetime.now(tz=pytz.utc) < expires_at - timedelta(minutes=5):
            return config

        logger.info("Google token expired, refreshing...")
        try:
            token_data = refresh_google_token(client_id, client_secret, config["google_refresh_token"])
            config["google_access_token"] = token_data["access_token"]
            if "refresh_token" in token_data:
                config["google_refresh_token"] = token_data["refresh_token"]
            config["google_token_expires_at"] = (
                datetime.now(tz=pytz.utc) + timedelta(seconds=token_data["expires_in"])
            ).isoformat()
            save_config(config)
            logger.info("Google token refreshed successfully")
            return config
        except Exception as e:
            logger.error(f"Token refresh failed: {e}")
            config.pop("google_access_token", None)

    if auth_code:
        try:
            token_data = exchange_google_code(client_id, client_secret, auth_code)
            config["google_access_token"] = token_data["access_token"]
            config["google_refresh_token"] = token_data["refresh_token"]
            config["google_token_expires_at"] = (
                datetime.now(tz=pytz.utc) + timedelta(seconds=token_data["expires_in"])
            ).isoformat()
            save_config(config)
            logger.info("Google OAuth authorization successful")
            return config
        except Exception as e:
            logger.error(f"Google code exchange failed: {e}")
            return None

    auth_url = get_google_auth_url(client_id)
    logger.info("=" * 70)
    logger.info("GOOGLE HEALTH API AUTHORIZATION REQUIRED")
    logger.info("Open this URL in your browser:")
    logger.info(auth_url)
    logger.info("")
    logger.info("After authorizing, copy the 'code' parameter from the callback URL.")
    logger.info("Then set GOOGLE_AUTH_CODE=<code> in docker-compose.yml and restart.")
    logger.info("=" * 70)
    return None


def fetch_weight_data(config, start_date, end_date):
    access_token = config["google_access_token"]
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
    }
    all_entries = []

    start_iso = f"{start_date.isoformat()}T00:00:00Z"
    end_iso = f"{end_date.isoformat()}T23:59:59Z"

    for data_type in ("weight", "body-fat"):
        url = f"{GOOGLE_HEALTH_API}/users/me/dataTypes/{data_type}/dataPoints"
        params = {
            "page_size": 1000,
            "filter": f'data_type.interval.start_time >= "{start_iso}" AND data_type.interval.start_time <= "{end_iso}"',
        }
        page_token = None

        while True:
            if page_token:
                params["page_token"] = page_token

            resp = retry_request(requests.get, url, headers=headers, params=params)
            if resp is None or resp.status_code != 200:
                logger.error(f"Google Health API error ({data_type}): {resp.status_code if resp else 'no response'}")
                if resp and resp.status_code == 401:
                    raise Exception("Google token invalid")
                break

            data = resp.json()
            for point in data.get("dataPoints", []):
                all_entries.append({"_type": data_type, "_raw": point})

            page_token = data.get("nextPageToken")
            if not page_token:
                break

    return _merge_entries(all_entries)


def _merge_entries(raw_entries):
    by_date = {}

    for item in raw_entries:
        data_type = item["_type"]
        point = item["_raw"]

        timestamp = point.get("startTime") or point.get("time", "")
        try:
            dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            date_str = dt.astimezone(TIMEZONE).strftime("%Y-%m-%d")
            time_str = dt.astimezone(TIMEZONE).strftime("%H:%M:%S")
        except (ValueError, AttributeError):
            continue

        if date_str not in by_date:
            by_date[date_str] = {"date": date_str, "time": time_str}

        values = point.get("values", point.get("value", {}))
        if isinstance(values, list) and values:
            values = values[0]

        if data_type == "weight":
            weight_val = values.get("fpVal") or values.get("value")
            if weight_val is not None:
                by_date[date_str]["weight"] = round(float(weight_val), 1)
                height = by_date[date_str].get("_height")
                if height:
                    by_date[date_str]["bmi"] = round(float(weight_val) / (height ** 2), 1)
        elif data_type == "body-fat":
            fat_val = values.get("fpVal") or values.get("value")
            if fat_val is not None:
                by_date[date_str]["fat"] = round(float(fat_val), 1)

    return list(by_date.values())


def connect_garmin(config):
    email = os.environ.get("GARMIN_EMAIL", config.get("garmin_email", ""))
    password = os.environ.get("GARMIN_PASSWORD", config.get("garmin_password", ""))

    if not email or not password:
        logger.error("GARMIN_EMAIL and GARMIN_PASSWORD must be set")
        return None

    config["garmin_email"] = email
    config["garmin_password"] = password

    garmin = Garmin(email, password)

    session_data = config.get("garmin_session")
    if session_data:
        try:
            garmin.garth.loads(session_data)
            garmin.display_name = garmin.garth.profile["displayName"]
            garmin.full_name = garmin.garth.profile["fullName"]
            logger.info("Garmin session restored from saved data")
            return garmin
        except Exception:
            logger.info("Saved Garmin session expired, re-authenticating...")

    try:
        garmin.login()
        config["garmin_session"] = garmin.garth.dumps()
        save_config(config)
        logger.info("Garmin login successful")
        return garmin
    except Exception as e:
        if "MFA" in str(e).upper() or "multi-factor" in str(e).lower():
            logger.warning("Garmin MFA requested - not supported in headless mode. "
                           "Log in via browser first, or disable MFA on your Garmin account.")
        else:
            logger.error(f"Garmin login failed: {e}")
        return None


def get_existing_garmin_dates(garmin, start_date, end_date):
    existing_dates = set()
    try:
        data = garmin.get_body_composition(
            start_date.strftime("%Y-%m-%d"),
            end_date.strftime("%Y-%m-%d"),
        )
        for entry in data.get("dateWeightList", []):
            ts = entry.get("calendarDate")
            if ts:
                existing_dates.add(ts)
    except Exception as e:
        logger.warning(f"Could not fetch existing Garmin data: {e}")
    return existing_dates


def upload_to_garmin(garmin, entry):
    dt_str = f"{entry['date']}T{entry.get('time', '00:00:00')}"
    dt = TIMEZONE.localize(datetime.strptime(dt_str, "%Y-%m-%dT%H:%M:%S"))

    body_composition = {
        "dateTime": dt.isoformat(),
        "weight": entry.get("weight"),
        "percentFat": entry.get("fat"),
        "bmi": entry.get("bmi"),
    }
    body_composition = {k: v for k, v in body_composition.items() if v is not None}

    garmin.add_body_composition(**body_composition)


def run_sync():
    config = load_config()

    config = ensure_google_auth(config)
    if config is None:
        return {"fetched": 0, "uploaded": 0, "skipped": 0, "errors": 0}

    garmin = connect_garmin(config)
    if garmin is None:
        return {"fetched": 0, "uploaded": 0, "skipped": 0, "errors": 0}

    save_config(config)

    now = datetime.now(TIMEZONE)
    last_synced = config.get("last_synced")

    if last_synced:
        start_date = datetime.strptime(last_synced, "%Y-%m-%d").date()
    else:
        start_date = (now - timedelta(days=90)).date()

    end_date = now.date()

    logger.info(f"Starting sync from {start_date} to {end_date}")

    try:
        entries = fetch_weight_data(config, start_date, end_date)
    except Exception as e:
        logger.error(f"Failed to fetch data from Google Health API: {e}")
        return {"fetched": 0, "uploaded": 0, "skipped": 0, "errors": 1}

    logger.info(f"Fetched {len(entries)} entries from Google Health API")

    existing_dates = get_existing_garmin_dates(garmin, start_date, end_date)

    uploaded = 0
    skipped = 0
    errors = 0

    for entry in entries:
        date = entry.get("date", "unknown")
        weight = entry.get("weight")
        fat = entry.get("fat")
        bmi = entry.get("bmi")

        if date in existing_dates:
            skipped += 1
            continue

        detail = f"{weight} kg"
        if fat is not None:
            detail += f" | {fat}% fat"
        if bmi is not None:
            detail += f" | BMI {bmi}"

        try:
            upload_to_garmin(garmin, entry)
            logger.info(f"✓ {date}: {detail} → Garmin OK")
            uploaded += 1
            existing_dates.add(date)
        except Exception as e:
            logger.error(f"✗ {date}: upload failed - {e}")
            errors += 1

    config["garmin_session"] = garmin.garth.dumps()
    config["last_synced"] = end_date.strftime("%Y-%m-%d")
    save_config(config)

    logger.info(f"Sync complete: {uploaded} uploaded, {skipped} skipped, {errors} errors")
    return {"fetched": len(entries), "uploaded": uploaded, "skipped": skipped, "errors": errors}
