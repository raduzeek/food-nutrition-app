import json
import os
import time
import hashlib
import base64
import secrets
import logging
from datetime import datetime, timedelta
from urllib.parse import urlencode, urlparse, parse_qs

import requests
import pytz
from garminconnect import Garmin

logger = logging.getLogger("fitbit-garmin-sync")

CONFIG_PATH = "/app/data/config.json"
FITBIT_AUTH_URL = "https://www.fitbit.com/oauth2/authorize"
FITBIT_TOKEN_URL = "https://api.fitbit.com/oauth2/token"
FITBIT_API_BASE = "https://api.fitbit.com"
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


def generate_pkce():
    code_verifier = secrets.token_urlsafe(64)[:128]
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return code_verifier, code_challenge


def get_fitbit_auth_url(client_id, code_challenge):
    params = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": REDIRECT_URI,
        "scope": "weight",
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    return f"{FITBIT_AUTH_URL}?{urlencode(params)}"


def exchange_fitbit_code(client_id, auth_code, code_verifier):
    data = {
        "grant_type": "authorization_code",
        "code": auth_code,
        "redirect_uri": REDIRECT_URI,
        "client_id": client_id,
        "code_verifier": code_verifier,
    }
    resp = requests.post(FITBIT_TOKEN_URL, data=data, headers={
        "Content-Type": "application/x-www-form-urlencoded",
    })
    resp.raise_for_status()
    return resp.json()


def refresh_fitbit_token(client_id, refresh_token):
    data = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": client_id,
    }
    resp = requests.post(FITBIT_TOKEN_URL, data=data, headers={
        "Content-Type": "application/x-www-form-urlencoded",
    })
    resp.raise_for_status()
    return resp.json()


def ensure_fitbit_auth(config):
    client_id = os.environ.get("FITBIT_CLIENT_ID", config.get("fitbit_client_id", ""))
    auth_code = os.environ.get("FITBIT_AUTH_CODE", "")

    if not client_id:
        logger.error("FITBIT_CLIENT_ID not set")
        return None

    config["fitbit_client_id"] = client_id

    if config.get("fitbit_access_token") and config.get("fitbit_token_expires_at"):
        expires_at = datetime.fromisoformat(config["fitbit_token_expires_at"])
        if datetime.now(tz=pytz.utc) < expires_at - timedelta(minutes=5):
            return config

        logger.info("Fitbit token expired, refreshing...")
        try:
            token_data = refresh_fitbit_token(client_id, config["fitbit_refresh_token"])
            config["fitbit_access_token"] = token_data["access_token"]
            config["fitbit_refresh_token"] = token_data["refresh_token"]
            config["fitbit_token_expires_at"] = (
                datetime.now(tz=pytz.utc) + timedelta(seconds=token_data["expires_in"])
            ).isoformat()
            save_config(config)
            logger.info("Fitbit token refreshed successfully")
            return config
        except Exception as e:
            logger.error(f"Token refresh failed: {e}")
            config.pop("fitbit_access_token", None)

    if auth_code:
        code_verifier = config.get("fitbit_code_verifier")
        if not code_verifier:
            logger.error("No code_verifier found in config. Restart the container to generate a new auth URL.")
            return None
        try:
            token_data = exchange_fitbit_code(client_id, auth_code, code_verifier)
            config["fitbit_access_token"] = token_data["access_token"]
            config["fitbit_refresh_token"] = token_data["refresh_token"]
            config["fitbit_token_expires_at"] = (
                datetime.now(tz=pytz.utc) + timedelta(seconds=token_data["expires_in"])
            ).isoformat()
            config.pop("fitbit_code_verifier", None)
            save_config(config)
            logger.info("Fitbit OAuth authorization successful")
            return config
        except Exception as e:
            logger.error(f"Fitbit code exchange failed: {e}")
            return None

    code_verifier, code_challenge = generate_pkce()
    config["fitbit_code_verifier"] = code_verifier
    save_config(config)

    auth_url = get_fitbit_auth_url(client_id, code_challenge)
    logger.info("=" * 70)
    logger.info("FITBIT AUTHORIZATION REQUIRED")
    logger.info("Open this URL in your browser:")
    logger.info(auth_url)
    logger.info("")
    logger.info("After authorizing, copy the 'code' parameter from the callback URL.")
    logger.info("Then set FITBIT_AUTH_CODE=<code> in your docker-compose.yml and restart.")
    logger.info("=" * 70)
    return None


def fetch_fitbit_weight(config, start_date, end_date):
    access_token = config["fitbit_access_token"]
    headers = {"Authorization": f"Bearer {access_token}"}
    all_entries = []

    current = start_date
    while current <= end_date:
        chunk_end = min(current + timedelta(days=29), end_date)
        url = f"{FITBIT_API_BASE}/1/user/-/body/log/weight/date/{current.strftime('%Y-%m-%d')}/30d.json"

        resp = retry_request(requests.get, url, headers=headers)
        if resp is None or resp.status_code != 200:
            logger.error(f"Fitbit API error: {resp.status_code if resp else 'no response'}")
            if resp and resp.status_code == 401:
                raise Exception("Fitbit token invalid")
            break

        data = resp.json()
        entries = data.get("weight", [])
        all_entries.extend(entries)
        current = chunk_end + timedelta(days=1)

    return all_entries


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

    config = ensure_fitbit_auth(config)
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
        entries = fetch_fitbit_weight(config, start_date, end_date)
    except Exception as e:
        logger.error(f"Failed to fetch Fitbit data: {e}")
        return {"fetched": 0, "uploaded": 0, "skipped": 0, "errors": 1}

    logger.info(f"Fetched {len(entries)} entries from Fitbit")

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
