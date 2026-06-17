import os
import sys
import signal
import logging
from logging.handlers import RotatingFileHandler
from datetime import datetime

import pytz
from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.interval import IntervalTrigger

from sync import run_sync

TIMEZONE = pytz.timezone(os.environ.get("TZ", "Europe/Prague"))
SYNC_INTERVAL = int(os.environ.get("SYNC_INTERVAL_SECONDS", "3600"))
LOG_PATH = "/app/data/sync.log"


def setup_logging():
    logger = logging.getLogger("fitbit-garmin-sync")
    logger.setLevel(logging.INFO)

    fmt = logging.Formatter(
        fmt="[%(asctime)s] %(levelname)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S %Z",
    )
    fmt.converter = lambda *args: datetime.now(TIMEZONE).timetuple()

    file_handler = RotatingFileHandler(
        LOG_PATH, maxBytes=5 * 1024 * 1024, backupCount=3
    )
    file_handler.setFormatter(fmt)
    logger.addHandler(file_handler)

    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setFormatter(fmt)
    logger.addHandler(stream_handler)

    return logger


def sync_job():
    logger = logging.getLogger("fitbit-garmin-sync")
    try:
        run_sync()
    except Exception as e:
        logger.error(f"Sync failed with unexpected error: {e}", exc_info=True)


def main():
    logger = setup_logging()
    logger.info("Fitbit→Garmin sync starting")
    logger.info(f"Sync interval: {SYNC_INTERVAL} seconds")

    scheduler = BlockingScheduler(timezone=TIMEZONE)

    scheduler.add_job(
        sync_job,
        trigger=IntervalTrigger(seconds=SYNC_INTERVAL, timezone=TIMEZONE),
        id="fitbit_garmin_sync",
        name="Fitbit to Garmin weight sync",
        next_run_time=datetime.now(TIMEZONE),
    )

    next_run = scheduler.get_job("fitbit_garmin_sync").next_run_time
    logger.info(f"Next sync: {next_run.strftime('%Y-%m-%d %H:%M:%S %Z')}")

    def shutdown(signum, frame):
        logger.info("Shutting down scheduler...")
        scheduler.shutdown(wait=False)
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    try:
        scheduler.start()
    except (KeyboardInterrupt, SystemExit):
        logger.info("Scheduler stopped")


if __name__ == "__main__":
    main()
