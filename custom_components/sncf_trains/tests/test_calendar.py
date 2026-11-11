"""Tests for the SNCF calendar."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from custom_components.sncf_trains.calendar import (
    MyCalendarEvent,
    SNCFCalendar,
)


def test_calendar_uses_public_transport_section_for_delay():
    """Ignore walking sections when calculating the train delay."""
    calendar = object.__new__(SNCFCalendar)
    journey = {
        "arrival_date_time": "2026-08-21T08:15:00+00:00",
        "sections": [
            {
                "type": "crow_fly",
                "base_arrival_date_time": "2026-08-21T08:00:00+00:00",
            },
            {
                "type": "public_transport",
                "base_arrival_date_time": "2026-08-21T08:10:00+00:00",
            },
            {"type": "crow_fly"},
        ],
    }

    has_delay, delay, summary = calendar._async_calculate_delay(
        journey, "Paris", "Lyon"
    )

    assert has_delay is True
    assert delay == 5
    assert "RETARD (5min)" in summary


@pytest.mark.asyncio
async def test_calendar_filters_events_to_requested_range():
    """Only return calendar events overlapping the requested date range."""
    start = datetime(2026, 8, 21, 8, 0, tzinfo=timezone.utc)
    inside = MyCalendarEvent(
        summary="Train",
        start=start + timedelta(minutes=30),
        end=start + timedelta(minutes=31),
        description="",
        location="Paris",
        uid="inside",
        has_delay=False,
        delay=0,
        departure_date_time=start + timedelta(minutes=30),
        arrival_date_time=start + timedelta(hours=1),
        train_num=1234,
    )
    outside = MyCalendarEvent(
        summary="Train",
        start=start + timedelta(hours=2),
        end=start + timedelta(hours=2, minutes=1),
        description="",
        location="Paris",
        uid="outside",
        has_delay=False,
        delay=0,
        departure_date_time=start + timedelta(hours=2),
        arrival_date_time=start + timedelta(hours=3),
        train_num=5678,
    )

    class CalendarStub:
        available = True

        def _fetch_journeys(self):
            return [inside, outside]

    events = await SNCFCalendar.async_get_events(
        CalendarStub(),
        None,
        start,
        start + timedelta(hours=1),
    )

    assert events == [inside]


def test_calendar_selects_next_upcoming_event():
    """Choose the next future departure rather than the closest past event."""
    now = datetime(2026, 8, 21, 8, 0, tzinfo=timezone.utc)
    past = SimpleNamespace(
        start=now - timedelta(minutes=2),
        end=now - timedelta(minutes=1),
        has_delay=False,
        delay=0,
        departure_date_time=now - timedelta(minutes=2),
        arrival_date_time=now + timedelta(minutes=30),
        train_num=1111,
    )
    upcoming = SimpleNamespace(
        start=now + timedelta(minutes=20),
        end=now + timedelta(minutes=21),
        has_delay=False,
        delay=0,
        departure_date_time=now + timedelta(minutes=20),
        arrival_date_time=now + timedelta(minutes=50),
        train_num=2222,
    )

    class CalendarStub:
        def _fetch_journeys(self):
            return [past, upcoming]

    calendar = CalendarStub()
    with patch(
        "custom_components.sncf_trains.calendar.dt_util.now",
        return_value=now,
    ):
        SNCFCalendar._update_event(calendar)

    assert calendar._event is upcoming
