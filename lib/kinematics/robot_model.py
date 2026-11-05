# This file acts as configuration file for robot you are using
# It works in conjustion with configuration file from robotics toolbox

from swift import Swift
import spatialmath.base.symbolic as sym
from roboticstoolbox import ETS as ET
from roboticstoolbox import *
import roboticstoolbox as rtb
from spatialmath import *
from spatialgeometry import *
from math import pi
import numpy as np
import time
import random

Joint_num = 6 # Number of joints
Microstep = 32
steps_per_revolution=200
degree_per_step_constant = 360/(32*200) 
radian_per_step_constant = (2*pi) / (32*200)
radian_per_sec_2_deg_per_sec_const = 360/ (2*np.pi)
deg_per_sec_2_radian_per_sec_const = (2*np.pi) / 360

# robot length values (metres)
a1 = 110.50 / 1000
a2 = 23.42 / 1000
a3 = 180 / 1000
a4 = 43.5 / 1000
a5 = 176.35 / 1000
a6 = 34.0 / 1000  # Fixed offset from J5/J6 intersection to J6 flange
a7 = 0  # No offset - TCP at J5/J6 axis intersection

alpha_DH = [-pi / 2,pi,pi/2,-pi/2,pi/2,pi]

# --- Custom robot profile overlay -----------------------------------------
# If Configuration > Robot Model has a custom robot active, use ITS joint
# limits (read from that robot's URDF - see robot_profile.py for why this is
# safe to do automatically) and, if the admin has explicitly entered them via
# Configuration > Robot Model > DH Parameters, its Cartesian/IK geometry too.
# Until DH parameters are entered for a custom robot, this keeps using
# PAROL6's geometry below, so Cartesian jogging will be geometrically wrong
# for a different arm shape even though joint limits, joint-space jogging
# and the 3D viewer are already correct from the URDF alone.
try:
    from .robot_profile import get_active_profile as _get_active_robot_profile
    _active_profile = _get_active_robot_profile()
except Exception:
    _active_profile = None

if _active_profile is not None and _active_profile.get("dh_params"):
    # Standard DH table entered by the admin (see DHParameterEditor.tsx /
    # the POST /api/config/robot/profiles/{id}/dh-params endpoint), one
    # {a_mm, alpha_deg, d_mm, offset_deg} dict per joint, J1..J6 order.
    # This is the generic 4-parameter-per-joint DH convention RevoluteDH
    # itself expects - NOT PAROL6's specific a1..a7 parameterization above,
    # which is just one particular set of values for those same 4 numbers.
    _dh_joints = _active_profile["dh_params"]["joints"]
    robot = DHRobot(
        [
            RevoluteDH(
                a=j["a_mm"] / 1000,
                alpha=np.deg2rad(j["alpha_deg"]),
                d=j["d_mm"] / 1000,
                offset=np.deg2rad(j.get("offset_deg", 0)),
            )
            for j in _dh_joints
        ],
        name=_active_profile.get("name", "Custom robot"),
    )
else:
    robot = DHRobot(
        [
            RevoluteDH(d=a1, a=a2, alpha=alpha_DH[0]),
            RevoluteDH(a=a3,d = 0,alpha=alpha_DH[1]),
            RevoluteDH(alpha= alpha_DH[2], a= -a4),
            RevoluteDH(d=-a5, a=0, alpha=alpha_DH[3]),
            RevoluteDH(a=0,d=0,alpha=alpha_DH[4]),
            RevoluteDH(alpha=alpha_DH[5], a = -a7,d = -a6, offset=pi/2),  # +90° offset to align TCP with URDF
        ],
        name="PAROL6",
    )

# TCP is at J6 flange (a6=34mm from J5/J6 intersection)
# URDF needs to match DH coordinate frame (see URDF base_link orientation)

# This arm's real travel limits (degrees, CCW positive), replacing PAROL6's
# defaults - also used as the frontend's joint-slider/jog bounds and by
# check_joint_limits() during trajectory planning.
# J6 is a continuous joint with no physical limit switch ("infinite" travel);
# [-3600, 3600] (10 full turns either way) is a generous practical bound so
# the limit-checking code below still has something finite to work with -
# widen or narrow this if it doesn't suit your actual wiring/cabling limits.
Joint_limits_degree = [[-125, 125], [-135, 78], [-74, 165], [-270, 270], [-90, 90], [-3600, 3600]]

if _active_profile is not None:
    Joint_limits_degree = _active_profile["joint_limits_deg"]

# in radians
Joint_limits_radian = []
for limits in Joint_limits_degree:
    radian_limits = [np.deg2rad(angle) for angle in limits]
    Joint_limits_radian.append(radian_limits)

# --- Wire-protocol unit scale (NOT a physical reduction ratio) ------------
# Historically this codebase sent positions/velocities over serial in
# "Commander steps" - a unit convention that hardcoded PAROL6's own
# reduction ratios [6.4, 20, 20*38/42, 4, 4, 10], purely for upstream
# wire-compatibility with the original PAROL6 STM32 firmware. The TinyBee
# firmware then had to carry a matching fake "PAROL6 geometry" table
# (commander_units.h's old STEPS_PER_DEGREE[]) just to translate that back
# out again before doing anything with it.
#
# Since this fork's firmware and this fork's pilot are maintained together
# and never need to talk to the original PAROL6 firmware/commander app,
# that whole indirection was removed. The wire protocol is now a single,
# uniform, arm-agnostic fixed-point angle scale - every joint, always.
# Physical reduction ratios live in exactly one place: the firmware's
# include/robot_config.h (config::JOINT[i].steps_per_degree) - see that
# file and commander_units.h's unitScale().
#
# This MUST match commander_units.h's kCommanderUnitsPerDegree exactly, or
# every commanded angle will be scaled wrong.
WIRE_UNITS_PER_DEGREE = 1000.0

# min and max jog speeds, true degrees/second (joint-space jog UI).
# Converted from this project's original PAROL6-specific step-rate tuning
# (kept numerically identical - only the units changed, from opaque
# "PAROL6 steps/s" to real degrees/s).
Joint_max_jog_speed_deg_per_sec = [13.18, 8.44, 11.19, 98.44, 98.44, 101.25]
Joint_min_jog_speed_deg_per_sec = [0.879, 0.281, 0.311, 1.406, 1.406, 0.562]
Joint_max_jog_speed = [WIRE_UNITS_PER_DEGREE * d for d in Joint_max_jog_speed_deg_per_sec]
Joint_min_jog_speed = [WIRE_UNITS_PER_DEGREE * d for d in Joint_min_jog_speed_deg_per_sec]

# LINEAR CARTESIAN JOG MAX MIN SPEED IN METERS PER SECOND
Cartesian_linear_velocity_min_JOG = 0.002
Cartesian_linear_velocity_max_JOG = 0.06

# LINEAR CARTESIAN MAX MIN SPEED IN METERS PER SECOND
Cartesian_linear_velocity_min = 0.002
Cartesian_linear_velocity_max = 0.06

# LINEAR CARTESIAN MAX MIN ACC IN METERS PER SECOND²
Cartesian_linear_acc_min = 0.002
Cartesian_linear_acc_max = 0.06

# ANGULAR CARTESIAN JOG MAX MIN SPEED IN DEGREES PER SECOND
Cartesian_angular_velocity_min = 0.7
Cartesian_angular_velocity_max = 25

# Max/min trajectory speed, true degrees/second. Same values as
# Joint_max_jog_speed_deg_per_sec's max-speed sibling (converted from the
# original step-rate tuning, numerically identical behaviour).
Joint_max_speed_deg_per_sec = [57.13, 50.62, 62.17, 281.25, 309.38, 123.75]
Joint_min_speed_deg_per_sec = [0.879, 0.281, 0.311, 1.406, 1.406, 0.562]
Joint_max_speed = [WIRE_UNITS_PER_DEGREE * d for d in Joint_max_speed_deg_per_sec]  # wire units/s
Joint_min_speed = [WIRE_UNITS_PER_DEGREE * d for d in Joint_min_speed_deg_per_sec]  # wire units/s

# Max/min trajectory acceleration, true degrees/second². FIXED as part of
# this change: these used to be a single scalar (32000) run through a
# radians-per-second conversion meant for *speeds*, which worked out to an
# effective ceiling of roughly 1e8-6e8 steps/s^2 per joint - acceleration
# was never actually constraining anything, trajectory timing was governed
# by Joint_max_speed alone with imperceptibly-fast ramps. These are real,
# per-joint deg/s² ceilings now (defaulted to "reach max speed in ~0.3s" -
# a reasonable starting point, not a measured value for your motors/
# inertia - tune these for your arm).
Joint_max_acc_deg_per_sec2 = [190.4, 168.7, 207.2, 937.5, 1031.3, 412.5]
Joint_min_acc_deg_per_sec2 = [5.0, 5.0, 5.0, 5.0, 5.0, 5.0]
Joint_max_acc = [WIRE_UNITS_PER_DEGREE * d for d in Joint_max_acc_deg_per_sec2]  # wire units/s^2
Joint_min_acc = [WIRE_UNITS_PER_DEGREE * d for d in Joint_min_acc_deg_per_sec2]  # wire units/s^2

Cart_lin_velocity_limits = [[-100,100],[-100,100],[-100,100]]
Cart_ang_velocity_limits = [[-100,100],[-100,100],[-100,100]]


Commands_list = [ "Input","Output","Dummy","Begin","Home","Delay","End","Loop","MoveJoint","MovePose","SpeedJoint","MoveCart",
                 "MoveCart","MoveCartRelTRF","Gripper","Gripper_cal"]

Commands_list_true = [item + "()" for item in Commands_list]

# index is kept (unused) in every function below purely so every existing
# call site across robot_state.py/commands.py/commander.py keeps working
# unchanged - the wire scale is now uniform across joints, so it no longer
# needs a per-joint lookup.
def DEG2STEPS(Degrees, index=None):
    return Degrees * WIRE_UNITS_PER_DEGREE

Joint_limits_steps =[[DEG2STEPS(Joint_limits_degree[0][0],0),DEG2STEPS(Joint_limits_degree[0][1],0)],
                      [DEG2STEPS(Joint_limits_degree[1][0],1),DEG2STEPS(Joint_limits_degree[1][1],1)],
                      [DEG2STEPS(Joint_limits_degree[2][0],2),DEG2STEPS(Joint_limits_degree[2][1],2)],
                      [DEG2STEPS(Joint_limits_degree[3][0],3),DEG2STEPS(Joint_limits_degree[3][1],3)],
                      [DEG2STEPS(Joint_limits_degree[4][0],4),DEG2STEPS(Joint_limits_degree[4][1],4)],
                      [DEG2STEPS(Joint_limits_degree[5][0],5),DEG2STEPS(Joint_limits_degree[5][1],5)]]
Joint_limits_steps = [[int(i[0]),int(i[1])] for i in Joint_limits_steps]


def STEPS2DEG(Steps, index=None):
    return Steps / WIRE_UNITS_PER_DEGREE

def RAD2STEPS(Rads,index):
    deg = np.rad2deg(Rads)
    steps = DEG2STEPS(deg,index)
    return steps

def STEPS2RADS(Steps,index):
    deg = STEPS2DEG(Steps,index)
    rads = np.deg2rad(deg)
    return rads

def RAD2DEG(radian):
    return np.rad2deg(radian)

def DEG2RAD(degree):
    return np.deg2rad(degree)

def SPEED_STEPS2DEG(Steps_per_second, index=None):
    return Steps_per_second / WIRE_UNITS_PER_DEGREE

def SPEED_DEG2STEPS(Deg_per_second, index=None):
    return Deg_per_second * WIRE_UNITS_PER_DEGREE

def SPEED_STEP2RAD(Steps_per_second, index=None):
    return np.deg2rad(SPEED_STEPS2DEG(Steps_per_second, index))

def SPEED_RAD2STEP(Rad_per_second, index=None):
    return SPEED_DEG2STEPS(np.rad2deg(Rad_per_second), index)

def RAD_SEC_2_DEG_SEC(rad_per_sec):
    return rad_per_sec * radian_per_sec_2_deg_per_sec_const

def DEG_SEC_2_RAD_SEC(deg_per_sec):
    return deg_per_sec * deg_per_sec_2_radian_per_sec_const


def check_joint_limits(q, target_q=None, allow_recovery=True):
    """
    Check if joint angles are within their limits, with support for recovery movements.
    
    Parameters
    ----------
    q : array_like
        Current joint angles in radians
    target_q : array_like, optional
        Target joint angles in radians. If provided, recovery logic is applied.
    allow_recovery : bool, optional
        Whether to allow recovery movements when current position violates limits
        
    Returns
    -------
    bool
        True if movement is allowed (within limits or valid recovery), False otherwise
    dict
        Dictionary with joint limit violation details and recovery information
    """
    q_array = np.array(q)
    target_array = np.array(target_q) if target_q is not None else None
    violations = {}
    all_valid = True
    
    for i in range(min(len(q_array), len(Joint_limits_radian))):
        min_limit = Joint_limits_radian[i][0]
        max_limit = Joint_limits_radian[i][1]
        current_pos = q_array[i]
        
        # Check if current position violates limits
        current_violates = current_pos < min_limit or current_pos > max_limit
        
        if current_violates:
            violation_type = 'below_min' if current_pos < min_limit else 'above_max'
            
            # If we have a target and recovery is enabled, check if it's a recovery movement
            if target_array is not None and allow_recovery:
                target_pos = target_array[i]
                is_recovery = False
                
                if current_pos > max_limit:  # Past upper limit
                    # Recovery means moving towards or below the upper limit
                    is_recovery = target_pos <= current_pos
                    recovery_direction = "move joint towards negative direction"
                elif current_pos < min_limit:  # Past lower limit
                    # Recovery means moving towards or above the lower limit  
                    is_recovery = target_pos >= current_pos
                    recovery_direction = "move joint towards positive direction"
                
                violations[f'joint_{i+1}'] = {
                    'current_value': current_pos,
                    'target_value': target_pos if target_array is not None else None,
                    'min_limit': min_limit,
                    'max_limit': max_limit,
                    'violation': violation_type,
                    'is_recovery': is_recovery,
                    'recovery_direction': recovery_direction if not is_recovery else None,
                    'movement_allowed': is_recovery
                }
                
                # Only flag as invalid if it's not a recovery movement
                if not is_recovery:
                    all_valid = False
            else:
                # No target provided or recovery disabled - flag as violation
                violations[f'joint_{i+1}'] = {
                    'current_value': current_pos,
                    'target_value': None,
                    'min_limit': min_limit,
                    'max_limit': max_limit,
                    'violation': violation_type,
                    'is_recovery': False,
                    'recovery_direction': None,
                    'movement_allowed': False
                }
                all_valid = False
        elif target_array is not None:
            # Current is within limits, check if target would violate
            target_pos = target_array[i]
            target_violates = target_pos < min_limit or target_pos > max_limit
            
            if target_violates:
                target_violation_type = 'below_min' if target_pos < min_limit else 'above_max'
                violations[f'joint_{i+1}'] = {
                    'current_value': current_pos,
                    'target_value': target_pos,
                    'min_limit': min_limit,
                    'max_limit': max_limit,
                    'violation': f'target_{target_violation_type}',
                    'is_recovery': False,
                    'recovery_direction': None,
                    'movement_allowed': False
                }
                all_valid = False
    
    return all_valid, violations

def extract_from_can_id(can_id):
    # Extracting ID2 (first 4 MSB)
    id2 = (can_id >> 7) & 0xF

    # Extracting CAN Command (next 6 bits)
    can_command = (can_id >> 1) & 0x3F

    # Extracting Error Bit (last bit)
    error_bit = can_id & 0x1
    
    return id2, can_command, error_bit


def combine_2_can_id(id2, can_command, error_bit):
    # Combine components into an 11-bit CAN ID
    can_id = 0

    # Add ID2 (first 4 MSB)
    can_id |= (id2 & 0xF) << 7

    # Add CAN Command (next 6 bits)
    can_id |= (can_command & 0x3F) << 1

    # Add Error Bit (last bit)
    can_id |= (error_bit & 0x1)

    return can_id

# Fuse bitfield list to byte
def fuse_bitfield_2_bytearray(var_in):
    number = 0
    for b in var_in:
        number = (2 * number) + b
    return bytes([number])

# Splits byte to bitfield list
def split_2_bitfield(var_in):
    return [(var_in >> i) & 1 for i in range(7, -1, -1)]


if __name__ == "__main__":
    # Quick validation of unit conversion functions
    for joint_idx in range(6):
        step_resolution = RAD2DEG(STEPS2RADS(1, joint_idx))
        print(f"Joint {joint_idx + 1} step resolution: {step_resolution:.6f} deg")

