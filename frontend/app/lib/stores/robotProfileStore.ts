/**
 * Tracks which robot (PAROL6 or a custom drag-and-dropped one) is active.
 *
 * Populated by RobotProfileLoader (mounted once in layout.tsx) on boot, and
 * refreshed whenever Configuration > Robot Model uploads/activates/deletes a
 * profile. Falls back to PAROL6 defaults if the backend hasn't responded yet
 * or the request fails, so nothing in the app needs to special-case "loading".
 */
import { create } from 'zustand';
import { getApiBaseUrl } from '../apiConfig';
import { PAROL6_JOINT_LIMITS } from '../constants';

export interface DHJointParams {
  a_mm: number;
  alpha_deg: number;
  d_mm: number;
  offset_deg: number;
}

export interface RobotProfile {
  id: string;
  name: string;
  builtin: boolean;
  urdf_path: string;
  joint_names: string[]; // the 6 URDF joint/link names, in J1..J6 order
  joint_limits_deg?: [number, number][];
  dh_params?: { joints: DHJointParams[] } | null;
  has_dh_params: boolean;
  active: boolean;
}

const PAROL6_FALLBACK: RobotProfile = {
  id: 'parol6',
  name: 'PAROL6 (default)',
  builtin: true,
  urdf_path: '/urdf/PAROL6.urdf',
  joint_names: ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'],
  has_dh_params: true,
  active: true,
};

interface RobotProfileState {
  profiles: RobotProfile[];
  activeId: string;
  loaded: boolean;
  fetchProfiles: () => Promise<void>;
}

export const useRobotProfileStore = create<RobotProfileState>((set) => ({
  profiles: [PAROL6_FALLBACK],
  activeId: 'parol6',
  loaded: false,

  fetchProfiles: async () => {
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/config/robot/profiles`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      set({
        profiles: data.profiles?.length ? data.profiles : [PAROL6_FALLBACK],
        activeId: data.active || 'parol6',
        loaded: true,
      });
    } catch (err) {
      console.error('Failed to load robot profiles, using PAROL6 default:', err);
      set({ profiles: [PAROL6_FALLBACK], activeId: 'parol6', loaded: true });
    }
  },
}));

function getActiveProfile(): RobotProfile {
  const state = useRobotProfileStore.getState();
  return state.profiles.find((p) => p.id === state.activeId) ?? PAROL6_FALLBACK;
}

/** Sync getter for non-React code (e.g. kinematics.ts). */
export function getActiveUrdfPath(): string {
  return getActiveProfile().urdf_path;
}

/** The 6 URDF joint/link names in J1..J6 order for the active robot. */
export function getActiveJointNames(): string[] {
  const profile = getActiveProfile();
  return profile.joint_names?.length === 6 ? profile.joint_names : PAROL6_FALLBACK.joint_names;
}

/**
 * Joint limits (degrees) for the active robot, in the same {J1:{min,max},..}
 * shape as the old static JOINT_LIMITS constant. Falls back to PAROL6's real
 * limits if no custom profile is active or it has no limits recorded.
 */
export function getActiveJointLimits(): typeof PAROL6_JOINT_LIMITS {
  const profile = getActiveProfile();
  if (profile.id === 'parol6' || !profile.joint_limits_deg || profile.joint_limits_deg.length !== 6) {
    return PAROL6_JOINT_LIMITS;
  }
  const keys = ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'] as const;
  const result = {} as typeof PAROL6_JOINT_LIMITS;
  keys.forEach((key, i) => {
    const [min, max] = profile.joint_limits_deg![i];
    result[key] = { min, max };
  });
  return result;
}
