"""
Active robot profile loader.

robot_model.py below this file defines PAROL6's geometry (DH parameters,
joint limits, reduction ratio) as module-level constants. Those are the
correct values for an unmodified PAROL6 arm and remain the default for
everyone.

If the user has uploaded a custom robot (Configuration > Robot Model in the
frontend, POST /api/config/robot/upload) and set it active, config.yaml's
robot_profiles.active will point at it. This module reads that profile and
hands back ONLY the pieces that are safe to override automatically:

  - joint_limits_deg: read straight from the uploaded URDF's <limit> tags.
    This is just the mechanical travel the model author already specified,
    so it's safe to trust.
  - dh_params: None unless a human has explicitly filled this in via
    Configuration > Robot Model > DH Parameters (POST
    /api/config/robot/profiles/{id}/dh-params). Cartesian/IK motion for a
    custom arm is NOT geometrically correct until this is set -
    robot_model.py keeps using PAROL6's DH parameters until then, and
    switches to this profile's once it's present.

Deliberately NOT touched by a profile: Joint_reduction_ratio. The serial
protocol to the firmware always speaks in "Commander steps", which assume
PAROL6's reduction ratios by design (see the firmware's commander_units.h).
The firmware does the real-arm step conversion on its side. Changing the
reduction ratio here would desync pilot from the firmware's unit convention
for every arm, not just fix it for custom ones - so it's intentionally left
as a PAROL6 constant regardless of which profile is active.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional, TypedDict

import yaml

logger = logging.getLogger(__name__)

_CONFIG_PATH = Path(__file__).resolve().parent.parent.parent / "config.yaml"


class ActiveRobotProfile(TypedDict, total=False):
    id: str
    name: str
    joint_limits_deg: list  # [[min, max] x6] or absent
    dh_params: Optional[dict]  # {"joints": [{"a_mm","alpha_deg","d_mm","offset_deg"} x6]} or None


def get_active_profile() -> Optional[ActiveRobotProfile]:
    """
    Return the active custom robot profile's data, or None if the active
    profile is 'parol6' (the built-in default) or anything can't be read.
    Never raises - any problem here should just mean "use PAROL6 defaults",
    not break robot_model.py's import.
    """
    try:
        with open(_CONFIG_PATH, "r") as f:
            config = yaml.safe_load(f) or {}
    except Exception as e:
        logger.debug(f"robot_profile: could not read config.yaml ({e}), using PAROL6 defaults")
        return None

    profiles_cfg = config.get("robot_profiles") or {}
    active_id = profiles_cfg.get("active", "parol6")
    if not active_id or active_id == "parol6":
        return None

    for entry in profiles_cfg.get("custom", []) or []:
        if entry.get("id") == active_id:
            if not entry.get("joint_limits_deg"):
                logger.warning(
                    f"robot_profiles: active profile '{active_id}' has no joint_limits_deg, "
                    "falling back to PAROL6 limits"
                )
                return None
            return {
                "id": entry["id"],
                "name": entry.get("name", entry["id"]),
                "joint_limits_deg": entry["joint_limits_deg"],
                "dh_params": entry.get("dh_params"),
            }

    logger.warning(
        f"robot_profiles: active id '{active_id}' not found in robot_profiles.custom, "
        "falling back to PAROL6 limits"
    )
    return None
