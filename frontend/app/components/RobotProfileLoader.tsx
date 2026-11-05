'use client';

import { useEffect } from 'react';
import { useRobotProfileStore } from '../lib/stores/robotProfileStore';

/**
 * Invisible component that loads the list of robot profiles (PAROL6 +
 * any custom uploads) once on app start, and whenever the Configuration
 * page activates/uploads/deletes one. Placed once at the root layout,
 * same pattern as WebSocketConnector.
 */
export default function RobotProfileLoader() {
  const fetchProfiles = useRobotProfileStore((state) => state.fetchProfiles);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  return null;
}
