"""Regression tests for cached SNCF journey data."""

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from homeassistant.config_entries import ConfigEntry

from custom_components.sncf_trains.const import (
    CONF_API_KEY,
    CONF_FROM,
    CONF_OUTSIDE_INTERVAL,
    CONF_TIME_END,
    CONF_TIME_START,
    CONF_TO,
    CONF_UPDATE_INTERVAL,
)
from custom_components.sncf_trains.coordinator import SncfUpdateCoordinator


@pytest.mark.asyncio
async def test_failed_refresh_keeps_last_known_journeys(hass):
    """A failed API request must not erase the last known route data."""
    subentry = MagicMock()
    subentry.title = "Paris → Lyon"
    subentry.data = {
        CONF_FROM: "stop_area:dep",
        CONF_TO: "stop_area:arr",
        CONF_TIME_START: "07:00",
        CONF_TIME_END: "10:00",
    }
    entry = MagicMock(spec=ConfigEntry)
    entry.data = {CONF_API_KEY: "test"}
    entry.options = {
        CONF_UPDATE_INTERVAL: 2,
        CONF_OUTSIDE_INTERVAL: 60,
    }
    entry.subentries = {"subentry_1": subentry}

    coordinator = SncfUpdateCoordinator(hass, entry)
    previous = [{"id": "cached_journey", "nb_transfers": 0}]
    coordinator.data = {"subentry_1": previous}
    last_success = datetime(2026, 8, 20, 8, 0)
    coordinator.last_successful_update = last_success
    coordinator.api_client = AsyncMock()
    coordinator.api_client.fetch_journeys = AsyncMock(return_value=None)

    with (
        patch(
            "custom_components.sncf_trains.coordinator.dt_util.now",
            return_value=datetime(2026, 8, 21, 8, 0),
        ),
        patch(
            "custom_components.sncf_trains.coordinator.asyncio.sleep",
            new_callable=AsyncMock,
        ),
    ):
        result = await coordinator._async_update_data()

    assert result == {"subentry_1": previous}
    assert coordinator.last_successful_update == last_success
    assert coordinator.api_client.fetch_journeys.await_count == 3
