"""Helpers for component."""

from datetime import datetime
from typing import Any

from homeassistant.util import dt as dt_util


def parse_datetime(dt_str: str) -> datetime | None:
    """Parse string to datetime."""
    if not dt_str:
        return None

    try:
        dt = dt_util.parse_datetime(dt_str)
        return dt_util.as_local(dt) if dt else None
    except (ValueError, TypeError):
        return None


def format_time(dt_str: str) -> str:
    """Format a Navitia datetime string as dd/mm/YYYY - HH:MM."""
    dt = parse_datetime(dt_str)
    return dt.strftime("%d/%m/%Y - %H:%M") if dt else "N/A"


def get_train_num(journey: dict[str, Any]) -> str:
    """Extract the commercial train number from a journey."""
    # ---------------------------------------------------------
    # 1. Le journey peut directement contenir le numéro
    # ---------------------------------------------------------
    trip_num = journey.get("trip_short_name")

    if trip_num:
        return str(trip_num)

    # ---------------------------------------------------------
    # 2. Cherche dans les sections
    #
    # Les nouveaux trajets peuvent avoir par exemple :
    #
    # section[0] = crow_fly / walking
    # section[1] = public_transport
    # section[2] = crow_fly / walking
    #
    # Il ne faut donc plus supposer que sections[0] est le train.
    # ---------------------------------------------------------
    sections = journey.get("sections", [])

    if not isinstance(sections, list):
        return ""

    # ---------------------------------------------------------
    # 3. Priorité aux sections public_transport
    # ---------------------------------------------------------
    for section in sections:
        if not isinstance(section, dict):
            continue

        if section.get("type") != "public_transport":
            continue

        infos = section.get("display_informations", {})

        if not isinstance(infos, dict):
            continue

        trip_num = infos.get("trip_short_name")

        if trip_num:
            return str(trip_num)

        trip_num = infos.get("num")

        if trip_num:
            return str(trip_num)

    # ---------------------------------------------------------
    # 4. Fallback : chercher dans n'importe quelle section
    #
    # Utile pour conserver la compatibilité avec les anciens
    # formats de réponse API.
    # ---------------------------------------------------------
    for section in sections:
        if not isinstance(section, dict):
            continue

        infos = section.get("display_informations", {})

        if not isinstance(infos, dict):
            continue

        trip_num = infos.get("trip_short_name")

        if trip_num:
            return str(trip_num)

        trip_num = infos.get("num")

        if trip_num:
            return str(trip_num)

    # ---------------------------------------------------------
    # 5. Aucun numéro trouvé
    # ---------------------------------------------------------
    return ""


def get_duration(journey: dict[str, Any]) -> int:
    """Compute journey duration in minutes."""
    dep = parse_datetime(journey.get("departure_date_time", ""))

    arr = parse_datetime(journey.get("arrival_date_time", ""))

    if dep and arr:
        return int((arr - dep).total_seconds() / 60)

    return 0



def attach_disruptions(journeys: list, disruptions: list) -> None:
    """Attach response-level SNCF disruptions to the journeys they affect."""
    if not isinstance(journeys, list) or not isinstance(disruptions, list):
        return

    disruptions_by_id: dict[str, dict[str, Any]] = {}
    for disruption in disruptions:
        if not isinstance(disruption, dict):
            continue
        for key in ("id", "disruption_id", "impact_id"):
            identifier = disruption.get(key)
            if identifier:
                disruptions_by_id[str(identifier)] = disruption

    for journey in journeys:
        if not isinstance(journey, dict):
            continue

        attached: list[dict[str, Any]] = []
        sections = journey.get("sections")
        if not isinstance(sections, list):
            journey["disruptions"] = attached
            continue

        for section in sections:
            if not isinstance(section, dict):
                continue

            links = section.get("links")
            links = links if isinstance(links, list) else []
            display = section.get("display_informations")
            if isinstance(display, dict):
                display_links = display.get("links")
                if isinstance(display_links, list):
                    links = [*links, *display_links]

            for link in links:
                if not isinstance(link, dict) or link.get("type") != "disruption":
                    continue
                identifier = link.get("id")
                disruption = disruptions_by_id.get(str(identifier)) if identifier else None
                if disruption is not None and disruption not in attached:
                    attached.append(disruption)

        journey["disruptions"] = attached


def disruption_summary(journey: dict[str, Any]) -> dict[str, str | None]:
    """Return the cause, effect and message of a journey's first disruption."""
    summary: dict[str, str | None] = {
        "disruption_cause": None,
        "disruption_effect": None,
        "disruption_message": None,
    }
    disruptions = journey.get("disruptions")
    if not isinstance(disruptions, list) or not disruptions:
        return summary

    main = disruptions[0]
    if not isinstance(main, dict):
        return summary

    cause = main.get("cause")
    if not isinstance(cause, str) or not cause:
        impacted_objects = main.get("impacted_objects")
        if isinstance(impacted_objects, list):
            for impacted in impacted_objects:
                if not isinstance(impacted, dict):
                    continue
                impacted_stops = impacted.get("impacted_stops")
                if not isinstance(impacted_stops, list):
                    continue
                cause = next(
                    (
                        stop.get("cause")
                        for stop in impacted_stops
                        if isinstance(stop, dict)
                        and isinstance(stop.get("cause"), str)
                        and stop.get("cause")
                    ),
                    None,
                )
                if cause:
                    break

    severity = main.get("severity")
    effect = severity.get("effect") if isinstance(severity, dict) else None
    messages = main.get("messages")
    message = None
    if isinstance(messages, list) and messages and isinstance(messages[0], dict):
        message = messages[0].get("text")

    summary["disruption_cause"] = cause if isinstance(cause, str) else None
    summary["disruption_effect"] = effect if isinstance(effect, str) else None
    summary["disruption_message"] = message if isinstance(message, str) else None
    return summary
