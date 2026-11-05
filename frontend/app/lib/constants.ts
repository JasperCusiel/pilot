import { JointAngles, JointLimit, CartesianAxis } from "./types";

// Joint names
export const JOINT_NAMES = ["J1", "J2", "J3", "J4", "J5", "J6"] as const;

// Cartesian axis names
export const CARTESIAN_AXES: CartesianAxis[] = [
  "X",
  "Y",
  "Z",
  "RX",
  "RY",
  "RZ",
];

// Joint limits (degrees) - PAROL6's real travel limits, matching
// lib/kinematics/robot_model.py's Joint_limits_degree on the backend (which
// is what actually gets enforced during trajectory planning) and the
// firmware README's PAROL6 reference table.
//
// NOTE: these were previously placeholder-looking values that didn't match
// either of those, which meant the frontend's Cartesian IK preview could
// silently disagree with what the backend would actually allow.
//
// This is the DEFAULT, used when the built-in PAROL6 profile is active. When
// a custom robot profile is active, getActiveJointLimits() below returns
// that robot's limits instead (read from its URDF on upload - see
// Configuration > Robot Model and AUDIT.md).
// This arm's real travel limits (degrees, CCW positive) - must match
// lib/kinematics/robot_model.py's Joint_limits_degree on the backend
// exactly, or the frontend's joint sliders/Cartesian IK clamping will
// enforce different bounds than what the backend actually allows. J6 is a
// continuous joint with no limit switch; [-3600, 3600] is a generous
// practical bound, same choice as the backend - adjust both together if
// you want something different.
export const PAROL6_JOINT_LIMITS = {
  J1: { min: -125, max: 125 },
  J2: { min: -135, max: 78 },
  J3: { min: -74, max: 165 },
  J4: { min: -270, max: 270 },
  J5: { min: -90, max: 90 },
  J6: { min: -3600, max: 3600 },
};

/** @deprecated Use getActiveJointLimits() so custom robot profiles are respected. */
export const JOINT_LIMITS = PAROL6_JOINT_LIMITS;

// Joint angle offsets for URDF visualization (degrees)
// These offsets correct the visual model to match the real robot's coordinate system
// COMMENTED OUT FOR NEW URDF TEST - may need different values
export const JOINT_ANGLE_OFFSETS = [0, 0, 0, 0, 0, 0]; // J6 -90
//                                 J1  J2  J3   J4  J5  J6

// Timeline colors (one per joint track)
export const JOINT_COLORS = [
  "#FF6B6B", // J1 - red
  "#4ECDC4", // J2 - teal
  "#45B7D1", // J3 - blue
  "#FFA07A", // J4 - orange
  "#98D8C8", // J5 - mint
  "#F7DC6F", // J6 - yellow
];

// Cartesian limits (approximate workspace)
export const CARTESIAN_LIMITS = {
  X: { min: -500, max: 500 }, // mm
  Y: { min: -500, max: 500 }, // mm
  Z: { min: 0, max: 500 }, // mm (above base)
  RX: { min: -180, max: 180 }, // degrees
  RY: { min: -180, max: 180 }, // degrees
  RZ: { min: -180, max: 180 }, // degrees
};

// Playback settings
export const DEFAULT_FPS = 60;
export const DEFAULT_DURATION = 10; // seconds

// Orientation extraction configuration (found through iterative testing)
// These values align URDF orientation with backend DH model orientation
// RESET FOR NEW URDF TEST - old values: offset RZ:90, eulerOrder:'ZXY', negateRX:true, negateRY:true
export const ORIENTATION_CONFIG = {
  offset: { RX: 0, RY: 0, RZ: 0 }, // No offset (was: RZ: 90)
  eulerOrder: "XYZ" as const, // Standard Euler order (was: 'ZXY')
  applyQuaternionTransform: false, // No transform (was: true)
  negateRX: false, // No negation (was: true)
  negateRY: false, // No negation (was: true)
  negateRZ: false, // No negation (was: false)
} as const;

// TCP Gizmo Post-Rotation Configuration
// This rotation is applied AFTER calculating TCP orientation from kinematics + TCP offset
// It corrects for any coordinate frame misalignment between the gizmo arrows and display coords
// Adjust these values to make RX=RY=RZ=0 visually align with world axes (X→X, Y→Y, Z→Z)
export const TCP_POST_ROTATION = {
  axis: "z" as "x" | "y" | "z", // Rotation axis (x, y, or z)
  angleDegrees: 0, // Rotation angle in degrees (positive = counterclockwise)
  enabled: true, // Set to false to disable post-rotation entirely
} as const;
