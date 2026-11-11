"""Regression tests for duplicate physical trainsets in SNCF composition data."""

from custom_components.sncf_trains.rolling_stock import analyser_composition


def test_duplicate_feed_elements_count_one_physical_trainset():
    """Repeated assignment numbers represent one physical trainset."""
    elements = [
        {"numeroAffectation": "0SSCA-B85075"},
        {"numeroAffectation": "0SSCA-B85075"},
    ]

    result = analyser_composition(elements)

    assert result["train_units"] == 1
    assert result["train_cars"] == 6
    assert result["train_composition"] == [
        "0SSCA-B85075",
        "0SSCA-B85075",
    ]


def test_distinct_coupled_trainsets_are_still_counted_separately():
    """Different physical trainsets must still be summed."""
    elements = [
        {"numeroAffectation": "B85075"},
        {"numeroAffectation": "B85077"},
    ]

    result = analyser_composition(elements)

    assert result["train_units"] == 2
    assert result["train_cars"] == 12
