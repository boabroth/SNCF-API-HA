"""Tests for attaching SNCF disruption information to journeys."""

from custom_components.sncf_trains.helpers import (
    attach_disruptions,
    disruption_summary,
)


def test_attach_disruptions_from_section_and_display_links():
    """Attach each linked disruption once, regardless of link location."""
    disruption = {"id": "impact-1", "cause": "Travaux"}
    journeys = [
        {
            "sections": [
                {
                    "links": [{"type": "disruption", "id": "impact-1"}],
                    "display_informations": {
                        "links": [{"type": "disruption", "id": "impact-1"}]
                    },
                }
            ]
        }
    ]

    attach_disruptions(journeys, [disruption])

    assert journeys[0]["disruptions"] == [disruption]


def test_attach_disruptions_ignores_unlinked_and_malformed_data():
    """Ignore malformed API entries and journeys without disruption links."""
    journeys = [
        {"sections": [{"links": [{"type": "disruption", "id": "missing"}]}]},
        {"sections": "invalid"},
        None,
    ]

    attach_disruptions(
        journeys,
        [None, {"id": "impact-1"}, {"id": "impact-2"}],
    )

    assert journeys[0]["disruptions"] == []
    assert journeys[1]["disruptions"] == []


def test_disruption_summary_uses_main_disruption_fields():
    """Expose cause, severity effect and first message."""
    journey = {
        "disruptions": [
            {
                "cause": "Incident technique",
                "severity": {"effect": "SIGNIFICANT_DELAYS"},
                "messages": [{"text": "Trafic ralenti."}],
            }
        ]
    }

    assert disruption_summary(journey) == {
        "disruption_cause": "Incident technique",
        "disruption_effect": "SIGNIFICANT_DELAYS",
        "disruption_message": "Trafic ralenti.",
    }


def test_disruption_summary_falls_back_to_impacted_stop_cause():
    """Use an impacted stop cause when the disruption has no global cause."""
    journey = {
        "disruptions": [
            {
                "impacted_objects": [
                    {"impacted_stops": [{"cause": "Arrêt non desservi"}]}
                ],
                "severity": {"effect": "NO_SERVICE"},
                "messages": [],
            }
        ]
    }

    assert disruption_summary(journey) == {
        "disruption_cause": "Arrêt non desservi",
        "disruption_effect": "NO_SERVICE",
        "disruption_message": None,
    }


def test_disruption_summary_handles_missing_or_malformed_data():
    """Return empty attributes when no usable disruption is available."""
    empty = {
        "disruption_cause": None,
        "disruption_effect": None,
        "disruption_message": None,
    }

    assert disruption_summary({}) == empty
    assert disruption_summary({"disruptions": [None]}) == empty
