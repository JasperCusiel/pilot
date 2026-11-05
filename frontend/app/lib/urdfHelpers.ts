/**
 * URDF Helper Utilities
 *
 * Centralized functions for URDF robot manipulation to maintain DRY principle.
 * All joint angle transformations happen here in one place.
 */

import { JointAngles } from './types';
import { JOINT_ANGLE_OFFSETS } from './constants';
import { getActiveJointNames } from './stores/robotProfileStore';

/** PAROL6's URDF link names - the long-standing default (and still used by
 *  JOINT_ANGLE_OFFSETS/angleSigns calibration below, which is PAROL6-specific). */
export const DEFAULT_URDF_JOINT_NAMES = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'];

/**
 * Apply joint angles to URDF robot model with proper transformations
 *
 * This is the SINGLE source of truth for how joint angles map to URDF joint values.
 * Used by all visualization and computation code to ensure consistency.
 *
 * @param urdfRobot - The URDF robot instance to update
 * @param jointAngles - Joint angles in degrees {J1, J2, J3, J4, J5, J6}
 *
 * Transformations applied:
 * - angleSigns: Per-joint sign multipliers (for axis direction differences)
 * - JOINT_ANGLE_OFFSETS: Per-joint offset additions (for zero position differences)
 * - Degree to radian conversion
 * - Joint name mapping: J1→urdfJointNames[0], J2→urdfJointNames[1], etc.
 *
 * @param urdfJointNames - The 6 URDF joint names to map J1..J6 onto. Defaults
 *   to the currently active robot profile's names (PAROL6's 'L1'..'L6'
 *   unless a custom robot is active - see Configuration > Robot Model).
 *   angleSigns/JOINT_ANGLE_OFFSETS below are PAROL6-specific calibration
 *   values found by iterative testing; a custom robot starts with no
 *   sign flips/offsets (identity) since those can't be safely guessed from
 *   a URDF alone. If a custom robot's 3D pose doesn't match the physical
 *   arm, this is where to add per-joint corrections for it.
 */
export function applyJointAnglesToUrdf(
  urdfRobot: any,
  jointAngles: JointAngles,
  urdfJointNames: string[] = getActiveJointNames()
): void {
  if (!urdfRobot) return;

  const isDefaultParol6Urdf = urdfJointNames.join(',') === DEFAULT_URDF_JOINT_NAMES.join(',');

  // Angle signs for each joint (calibrated for PAROL6's URDF specifically).
  // A custom robot gets identity signs/offsets - see the doc comment above.
  const angleSigns = [1, 1, 1, 1, 1, 1];

  const jointNames = ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'] as const;

  jointNames.forEach((joint, index) => {
    const angleDeg = jointAngles[joint];
    const sign = angleSigns[index];
    const offset = isDefaultParol6Urdf ? (JOINT_ANGLE_OFFSETS[index] || 0) : 0;

    // Apply transformations: (angle * sign) + offset
    const correctedAngleDeg = angleDeg * sign + offset;

    // Convert to radians
    const angleRad = (correctedAngleDeg * Math.PI) / 180;

    const urdfJointName = urdfJointNames[index];

    try {
      urdfRobot.setJointValue(urdfJointName, angleRad);
    } catch (e) {
      // Silently ignore joint not found errors
      // This can happen during URDF loading or if joint doesn't exist
    }
  });
}

/**
 * Get current joint angles from URDF robot
 *
 * Inverse of applyJointAnglesToUrdf - extracts joint angles from URDF state
 * and reverses the transformations to get back to user-space angles.
 *
 * @param urdfRobot - The URDF robot instance to read from
 * @param urdfJointNames - The 6 URDF joint names J1..J6 map onto; see
 *   applyJointAnglesToUrdf for defaults/details (must match what was used
 *   to set the angles, or this won't be a correct inverse).
 * @returns Joint angles in degrees {J1, J2, J3, J4, J5, J6} or null if failed
 */
export function getJointAnglesFromUrdf(
  urdfRobot: any,
  urdfJointNames: string[] = getActiveJointNames()
): JointAngles | null {
  if (!urdfRobot) return null;

  const isDefaultParol6Urdf = urdfJointNames.join(',') === DEFAULT_URDF_JOINT_NAMES.join(',');
  const angleSigns = [1, 1, 1, 1, 1, 1];
  const jointNames = ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'] as const;
  const result: any = {};

  try {
    jointNames.forEach((joint, index) => {
      const urdfJointName = urdfJointNames[index];
      const angleRad = urdfRobot.joints[urdfJointName]?.angle || 0;
      const angleDeg = (angleRad * 180) / Math.PI;

      // Reverse transformations: (angle - offset) / sign
      const offset = isDefaultParol6Urdf ? (JOINT_ANGLE_OFFSETS[index] || 0) : 0;
      const sign = angleSigns[index];
      result[joint] = (angleDeg - offset) / sign;
    });

    return result as JointAngles;
  } catch (e) {
    return null;
  }
}
