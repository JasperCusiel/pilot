'use client';

import { useEffect, useRef, Suspense, useState, useCallback } from 'react';
import { annotate, annotationGroup } from 'rough-notation';
import { Canvas, ThreeEvent } from '@react-three/fiber';
import { OrbitControls, Grid, GizmoHelper, GizmoViewport, Environment } from '@react-three/drei';
import * as THREE from 'three';
import { useInputStore, useCommandStore, useHardwareStore, useTimelineStore, useRobotConfigStore } from '@/app/lib/stores';
import { useKinematicsStore } from '@/app/lib/stores/kinematicsStore';
import TargetPoseVisualizer from './TargetPoseVisualizer';
import CommanderTCPVisualizer from './CommanderTCPVisualizer';
import ActualTCPVisualizer from './ActualTCPVisualizer';
import PathVisualizer from './PathVisualizer';
import IKProgressBar from './IKProgressBar';
import JointLabels from './JointLabels';
import InteractiveRobotMeshes from './InteractiveRobotMeshes';
import { JointContextMenu } from './JointContextMenu';
import { TCPPoseDisplay, TCPPoseHeader } from './TCPPoseDisplay';
import { MemoryMonitor, WebGLContextMonitor } from './MemoryMonitor';
import { JOINT_LIMITS, JOINT_ANGLE_OFFSETS, CARTESIAN_LIMITS } from '../lib/constants';
import type { JointName, CartesianAxis } from '../lib/types';
import { inverseKinematicsDetailed } from '../lib/kinematics';
import { getHomePosition, getAllPositions } from '../lib/positions';
import { getApiBaseUrl } from '../lib/apiConfig';
import { logger } from '../lib/logger';
import { moveJoints, executeTrajectory, setGripperOutput } from '../lib/api';
import { generateCartesianWaypoints, calculateWaypointCount } from '../lib/cartesianPlanner';
import { useSafetyConfirmation } from '../hooks/useSafetyConfirmation';
import { calculateTcpPoseFromUrdf } from '../lib/tcpCalculations';
import { threeJsToRobot } from '../lib/coordinateTransform';
import { applyJointAnglesToUrdf } from '../lib/urdfHelpers';
import { useRobotProfileStore, getActiveUrdfPath, getActiveJointNames } from '../lib/stores/robotProfileStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuCheckboxItem } from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Kbd } from '@/components/ui/kbd';
import { Plus, Settings, HelpCircle, Lightbulb } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useConfigStore } from '../lib/configStore';

// @ts-ignore - urdf-loader doesn't have proper types
import URDFLoader from 'urdf-loader';
import { STLLoader, GLTFLoader } from 'three-stdlib';

// Helper to detect mesh file type
const getMeshFileType = (filename: string): 'stl' | 'gltf' | 'glb' | null => {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'stl') return 'stl';
  if (ext === 'gltf') return 'gltf';
  if (ext === 'glb') return 'glb';
  return null;
};
import { useFrame } from '@react-three/fiber';

interface Tool {
  id: string;
  name: string;
  description: string;
  mesh_file: string | null;
  mesh_units?: 'mm' | 'm';
  mesh_offset: {
    x: number;
    y: number;
    z: number;
    rx: number;
    ry: number;
    rz: number;
  };
  tcp_offset: {
    x: number;
    y: number;
    z: number;
    rx: number;
    ry: number;
    rz: number;
  };
  gripper_config?: {
    enabled: boolean;
    io_pin: number;
    open_is_high: boolean;
    mesh_file_open: string | null;
    mesh_file_closed: string | null;
  };
}

// Tool Mesh Component - Positioned at J6 joint
// Supports both single mesh tools and gripper tools with open/closed states
// Supports both STL geometry and GLTF scenes
function ToolMesh({
  geometry,
  gltfScene,
  gripperMeshOpen,
  gripperMeshClosed,
  gltfSceneOpen,
  gltfSceneClosed,
  displayState,
  robotRef,
  tool,
  color,
  transparency,
  useUniformMaterial = false
}: {
  geometry: THREE.BufferGeometry | null;
  gltfScene?: THREE.Group | null;
  gripperMeshOpen?: THREE.BufferGeometry | null;
  gripperMeshClosed?: THREE.BufferGeometry | null;
  gltfSceneOpen?: THREE.Group | null;
  gltfSceneClosed?: THREE.Group | null;
  displayState?: 'open' | 'closed';
  robotRef: any;
  tool: Tool | null;
  color: string;
  transparency: number;
  useUniformMaterial?: boolean; // When true, override GLTF materials with uniform color (for hardware robot)
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const gripperOpenRef = useRef<THREE.Mesh>(null);
  const gripperClosedRef = useRef<THREE.Mesh>(null);
  const gltfRef = useRef<THREE.Group>(null);
  const gltfOpenRef = useRef<THREE.Group>(null);
  const gltfClosedRef = useRef<THREE.Group>(null);

  // Cloned scenes with uniform materials (for hardware robot)
  const [uniformGltfScene, setUniformGltfScene] = useState<THREE.Group | null>(null);
  const [uniformGltfOpen, setUniformGltfOpen] = useState<THREE.Group | null>(null);
  const [uniformGltfClosed, setUniformGltfClosed] = useState<THREE.Group | null>(null);

  // Clone GLTF scenes and apply uniform materials when useUniformMaterial is true (for hardware robot)
  useEffect(() => {
    if (!useUniformMaterial) {
      setUniformGltfScene(null);
      setUniformGltfOpen(null);
      setUniformGltfClosed(null);
      return;
    }

    const cloneWithUniformMaterial = (scene: THREE.Group | null | undefined): THREE.Group | null => {
      if (!scene) return null;
      const cloned = scene.clone(true);
      cloned.traverse((child: any) => {
        if (child.isMesh && child.material) {
          // Replace material with uniform MeshStandardMaterial
          child.material = new THREE.MeshStandardMaterial({
            color: color,
            transparent: transparency < 1.0,
            opacity: transparency,
            metalness: 0.3,
            roughness: 0.6,
            side: THREE.DoubleSide
          });
        }
      });
      return cloned;
    };

    const newScene = cloneWithUniformMaterial(gltfScene);
    const newOpen = cloneWithUniformMaterial(gltfSceneOpen);
    const newClosed = cloneWithUniformMaterial(gltfSceneClosed);

    setUniformGltfScene(newScene);
    setUniformGltfOpen(newOpen);
    setUniformGltfClosed(newClosed);

    // Cleanup cloned scenes when dependencies change or unmount
    return () => {
      [newScene, newOpen, newClosed].forEach(scene => {
        if (scene) {
          scene.traverse((child: any) => {
            if (child.isMesh) {
              if (child.geometry) child.geometry.dispose();
              if (child.material) child.material.dispose();
            }
          });
        }
      });
    };
  }, [useUniformMaterial, gltfScene, gltfSceneOpen, gltfSceneClosed, color, transparency]);

  // Select which GLTF scenes to use based on useUniformMaterial
  const activeGltfScene = useUniformMaterial ? uniformGltfScene : gltfScene;
  const activeGltfOpen = useUniformMaterial ? uniformGltfOpen : gltfSceneOpen;
  const activeGltfClosed = useUniformMaterial ? uniformGltfClosed : gltfSceneClosed;

  // Determine which mesh to show
  const hasGripperGeometries = !!(gripperMeshOpen || gripperMeshClosed || gltfSceneOpen || gltfSceneClosed);
  const showMain = !hasGripperGeometries && !!(geometry || gltfScene);
  const showOpen = hasGripperGeometries && displayState === 'open';
  const showClosed = hasGripperGeometries && displayState === 'closed';

  // Update tool mesh position/rotation to match L6 link every frame
  useFrame(() => {
    // Collect all refs (both STL mesh refs and GLTF scene refs)
    const objects: (THREE.Object3D | null)[] = [
      meshRef.current,
      gripperOpenRef.current,
      gripperClosedRef.current,
      gltfRef.current,
      gltfOpenRef.current,
      gltfClosedRef.current
    ];

    for (const obj of objects) {
      if (!obj || !robotRef) continue;

      const toolMountLinkName = getActiveJointNames()[5]; // PAROL6: 'L6'
      const l6Link = robotRef.links?.[toolMountLinkName];
      if (!l6Link) continue;

      l6Link.updateMatrixWorld(true);

      // Get L6 link's world transform
      const l6WorldPosition = new THREE.Vector3();
      const l6WorldQuaternion = new THREE.Quaternion();
      l6Link.getWorldPosition(l6WorldPosition);
      l6Link.getWorldQuaternion(l6WorldQuaternion);

      // Apply position offset in L6's local frame (rotates with J6)
      if (tool?.mesh_offset) {
        const offset = tool.mesh_offset;

        // Apply position offset rotated by L6 quaternion so it moves with J6
        if (offset.x !== 0 || offset.y !== 0 || offset.z !== 0) {
          const localOffset = new THREE.Vector3(offset.x, offset.y, offset.z);
          const worldOffset = localOffset.applyQuaternion(l6WorldQuaternion);
          obj.position.copy(l6WorldPosition).add(worldOffset);
        } else {
          obj.position.copy(l6WorldPosition);
        }
      } else {
        obj.position.copy(l6WorldPosition);
      }

      // Set base rotation from L6
      obj.quaternion.copy(l6WorldQuaternion);

      // Apply L6 visual origin rotation from URDF: rpy="0 0 -1.5708" (-90° Z)
      const visualOriginRotation = new THREE.Quaternion();
      visualOriginRotation.setFromEuler(new THREE.Euler(0, 0, -Math.PI / 2, 'XYZ'));
      obj.quaternion.multiply(visualOriginRotation);

      // Apply tool's mesh rotation offset
      if (tool?.mesh_offset) {
        const offset = tool.mesh_offset;

        if (offset.rx !== 0 || offset.ry !== 0 || offset.rz !== 0) {
          const offsetRotation = new THREE.Euler(
            (offset.rx * Math.PI) / 180,
            (offset.ry * Math.PI) / 180,
            (offset.rz * Math.PI) / 180,
            'XYZ'
          );
          const offsetQuat = new THREE.Quaternion();
          offsetQuat.setFromEuler(offsetRotation);
          obj.quaternion.multiply(offsetQuat);
        }
      }
    }
  });

  return (
    <>
      {/* Single STL mesh (for non-gripper tools) */}
      {showMain && geometry && !activeGltfScene && (
        <mesh ref={meshRef} geometry={geometry}>
          <meshStandardMaterial
            color={color}
            transparent={transparency < 1.0}
            opacity={transparency}
            metalness={0.3}
            roughness={0.6}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* Main GLTF scene (original materials for commander, uniform for hardware) */}
      {showMain && activeGltfScene && (
        <primitive ref={gltfRef} object={activeGltfScene} />
      )}

      {/* Gripper open state - STL */}
      {showOpen && gripperMeshOpen && !activeGltfOpen && (
        <mesh ref={gripperOpenRef} geometry={gripperMeshOpen}>
          <meshStandardMaterial
            color={color}
            transparent={transparency < 1.0}
            opacity={transparency}
            metalness={0.3}
            roughness={0.6}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* Gripper open state - GLTF - use group wrapper to ensure proper scene removal */}
      <group ref={gltfOpenRef}>
        {showOpen && activeGltfOpen && (
          <primitive object={activeGltfOpen} />
        )}
      </group>

      {/* Gripper closed state - STL */}
      {showClosed && gripperMeshClosed && !activeGltfClosed && (
        <mesh ref={gripperClosedRef} geometry={gripperMeshClosed}>
          <meshStandardMaterial
            color={color}
            transparent={transparency < 1.0}
            opacity={transparency}
            metalness={0.3}
            roughness={0.6}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* Gripper closed state - GLTF - use group wrapper to ensure proper scene removal */}
      <group ref={gltfClosedRef}>
        {showClosed && activeGltfClosed && (
          <primitive object={activeGltfClosed} />
        )}
      </group>
    </>
  );
}

interface URDFRobotProps {
  showLabels: boolean;
  hardwareRobotColor: string;
  hardwareRobotTransparency: number;
  commanderRobotColor: string;
  commanderRobotTransparency: number;
  hardwareJointAngles: any;
  activeToolId?: string;
  setAvailableTools: (tools: Tool[]) => void;
  hardwareTool: Tool | null;
  hardwareGripperState: 'open' | 'closed' | null;
}

function URDFRobot({ showLabels, hardwareRobotColor, hardwareRobotTransparency, commanderRobotColor, commanderRobotTransparency, hardwareJointAngles, activeToolId, setAvailableTools, hardwareTool, hardwareGripperState }: URDFRobotProps) {
  const robotRef = useRef<any>(null);
  const hardwareRobotRef = useRef<any>(null);
  const commandedJointAngles = useCommandStore((state) => state.commandedJointAngles);
  const selectedJoint = useInputStore((state) => state.selectedJoint);
  const showHardwareRobot = useInputStore((state) => state.showHardwareRobot);
  const jointHomedStatus = useCommandStore((state) => state.jointHomedStatus);
  const showTargetRobot = useInputStore((state) => state.showTargetRobot);
  const commandedGripperState = useCommandStore((state) => state.commandedGripperState);
  const commanderToolFromStore = useCommandStore((state) => state.commanderTool);
  // Gate URDF loading until the active robot profile has been fetched (it's
  // an async request that starts around the same time as this component
  // mounts) - otherwise this could load PAROL6.urdf even when a custom
  // robot is actually active, on first page load.
  const robotProfileLoaded = useRobotProfileStore((state) => state.loaded);

  // Tool mesh state (supports both STL geometry and GLTF scenes)
  const [toolMeshGeometry, setToolMeshGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [toolGltfScene, setToolGltfScene] = useState<THREE.Group | null>(null);
  const [gripperMeshOpen, setGripperMeshOpen] = useState<THREE.BufferGeometry | null>(null);
  const [gripperMeshClosed, setGripperMeshClosed] = useState<THREE.BufferGeometry | null>(null);
  const [gripperGltfOpen, setGripperGltfOpen] = useState<THREE.Group | null>(null);
  const [gripperGltfClosed, setGripperGltfClosed] = useState<THREE.Group | null>(null);
  const [currentTool, setCurrentTool] = useState<Tool | null>(null);

  // Helper function to properly dispose URDF robot and all its resources
  const disposeURDFRobot = (robot: any) => {
    if (!robot) return;

    robot.traverse((child: any) => {
      if (child.isMesh) {
        // Dispose geometry
        if (child.geometry) {
          child.geometry.dispose();
        }

        // Dispose materials (handle both single materials and arrays)
        if (child.material) {
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          materials.forEach((mat: any) => {
            if (mat) {
              // Dispose textures if any
              if (mat.map) mat.map.dispose();
              if (mat.normalMap) mat.normalMap.dispose();
              if (mat.roughnessMap) mat.roughnessMap.dispose();
              if (mat.metalnessMap) mat.metalnessMap.dispose();
              // Dispose material itself
              mat.dispose();
            }
          });
        }
      }
    });
  };

  // Load URDF and create 3 robot instances
  // 1. Commander visual (colored robot showing commands)
  // 2. Hardware visual (ghost robot showing feedback)
  // 3. Computation headless (for FK/IK calculations)
  useEffect(() => {
    if (!robotProfileLoaded) return; // wait for the active profile to resolve first

    const urdfPath = getActiveUrdfPath();
    const urdfJointNames = getActiveJointNames(); // [J1..J6] -> URDF joint names for the active robot
    const toolMountJointName = urdfJointNames[5]; // PAROL6: 'L6'. Last joint in the chain, where tools attach.

    const loader = new URDFLoader();

    loader.load(
      urdfPath,
      (loadedRobot: any) => {
        logger.debug('URDF loaded successfully', 'RobotSetup');

        // 1. Commander visual robot (use loaded robot directly)
        const commanderRobot = loadedRobot;
        robotRef.current = commanderRobot;
        useCommandStore.setState({ commanderRobotRef: commanderRobot });

        // Wait for meshes to load before cloning and setting up robots
        setTimeout(() => {
          // Count meshes in commander robot after loading
          let commanderMeshCount = 0;
          commanderRobot.traverse((child: any) => { if (child.isMesh) commanderMeshCount++; });
          logger.debug(`Commander robot loaded with ${commanderMeshCount} meshes`, 'RobotSetup');

          // 2. Hardware visual robot (clone AFTER meshes have loaded)
          const hardwareRobot = commanderRobot.clone();
          hardwareRobotRef.current = hardwareRobot;
          useHardwareStore.setState({ hardwareRobotRef: hardwareRobot });

          // 3. Computation robot (clone AFTER meshes have loaded, headless - not added to scene)
          const computationRobot = commanderRobot.clone();
          // IMPORTANT: Apply the same rotation as the visual robots for coordinate consistency
          // Visual robots are in <group rotation={[-Math.PI / 2, 0, 0]}>
          // So we must apply the same rotation to computation robot for FK/IK to match
          computationRobot.rotation.set(-Math.PI / 2, 0, 0);
          computationRobot.updateMatrixWorld(true); // Update transforms after rotation
          useKinematicsStore.setState({ computationRobotRef: computationRobot });

          // Count meshes in hardware robot after cloning
          let hardwareMeshCount = 0;
          hardwareRobot.traverse((child: any) => { if (child.isMesh) hardwareMeshCount++; });
          logger.debug(`Hardware robot cloned with ${hardwareMeshCount} meshes`, 'RobotSetup');

          // === Setup Commander Robot ===
          // Remove L6 mesh only (keep the link for joint transform)
          let commanderL6Removed = 0;
          commanderRobot.traverse((child: any) => {
            if (child.isMesh) {
              let parent = child.parent;
              while (parent) {
                if (parent.isURDFLink && parent.name === toolMountJointName) {
                  child.parent.remove(child);
                  commanderL6Removed++;
                  break;
                }
                parent = parent.parent;
              }
            }
          });
          logger.debug(`Commander: Removed ${commanderL6Removed} L6 meshes`, 'RobotSetup');

          // Setup meshes with event handlers and coloring
          commanderRobot.traverse((child: any) => {
            if (child.isMesh) {
              // Find which joint this mesh belongs to
              let jointName = null;
              let parent = child.parent;
              while (parent) {
                if (parent.isURDFJoint) {
                  // Map this URDF joint's name back to J1..J6 using the
                  // active profile's joint name list (works for any custom
                  // robot's naming scheme, not just PAROL6's 'L1'..'L6').
                  const jointIndex = urdfJointNames.indexOf(parent.name);
                  if (jointIndex !== -1) {
                    jointName = `J${jointIndex + 1}` as JointName;
                  }
                  break;
                }
                parent = parent.parent;
              }

              // Convert ALL materials to MeshStandardMaterial for PBR/environment lighting support
              if (child.material) {
                const materials = Array.isArray(child.material) ? child.material : [child.material];
                const newMaterials: any[] = [];
                materials.forEach((mat: any) => {
                  if (mat) {
                    // Convert to MeshStandardMaterial if it isn't already
                    let standardMat: THREE.MeshStandardMaterial;
                    if (mat.isMeshStandardMaterial) {
                      standardMat = mat.clone();
                    } else {
                      // Create new MeshStandardMaterial with original color
                      standardMat = new THREE.MeshStandardMaterial({
                        color: mat.color || 0xffffff,
                        map: mat.map || null,
                        side: mat.side || THREE.FrontSide,
                        metalness: 0.1,
                        roughness: 0.5
                      });
                    }
                    standardMat.userData.isCloned = true;

                    // Apply commander robot colors from store
                    const commanderColor = useRobotConfigStore.getState().commanderRobotColor;
                    const commanderTransp = useRobotConfigStore.getState().commanderRobotTransparency;
                    standardMat.color.set(commanderColor);
                    standardMat.transparent = commanderTransp < 1.0;
                    standardMat.opacity = commanderTransp;
                    standardMat.depthWrite = commanderTransp >= 1.0;
                    standardMat.needsUpdate = true;

                    newMaterials.push(standardMat);
                  }
                });
                child.material = Array.isArray(child.material) ? newMaterials : newMaterials[0];
              }

              if (jointName) {
                child.userData.jointName = jointName;
                // Enable raycasting for this mesh so it can be clicked
                child.userData.clickable = true;
              }
            }
          });

          // Set initial joint positions for commander robot
          const initialAngles = useCommandStore.getState().commandedJointAngles;
          applyJointAnglesToUrdf(commanderRobot, initialAngles);
          commanderRobot.updateMatrixWorld(true);

          // === Setup Hardware Robot ===
          // Remove L6 mesh only
          let hardwareL6Removed = 0;
          hardwareRobot.traverse((child: any) => {
            if (child.isMesh) {
              let parent = child.parent;
              while (parent) {
                if (parent.isURDFLink && parent.name === toolMountJointName) {
                  child.parent.remove(child);
                  hardwareL6Removed++;
                  break;
                }
                parent = parent.parent;
              }
            }
          });
          logger.debug(`Hardware: Removed ${hardwareL6Removed} L6 meshes`, 'RobotSetup');

          // Make all hardware meshes transparent with ghost styling
          let hardwareMeshesProcessed = 0;
          let hardwareMeshesWithJoint = 0;
          let hardwareMeshesWithoutJoint = 0;
          hardwareRobot.traverse((child: any) => {
            if (child.isMesh) {
              hardwareMeshesProcessed++;
              // Mark this mesh as part of hardware robot
              child.userData.isActual = true;

              // Find which joint this mesh belongs to
              let jointName = null;
              let parent = child.parent;
              while (parent) {
                if (parent.isURDFJoint) {
                  // Map this URDF joint's name back to J1..J6 using the
                  // active profile's joint name list (works for any custom
                  // robot's naming scheme, not just PAROL6's 'L1'..'L6').
                  const jointIndex = urdfJointNames.indexOf(parent.name);
                  if (jointIndex !== -1) {
                    jointName = `J${jointIndex + 1}` as JointName;
                  }
                  break;
                }
                parent = parent.parent;
              }
              if (jointName) {
                child.userData.jointName = jointName;
                hardwareMeshesWithJoint++;
              } else {
                hardwareMeshesWithoutJoint++;
              }

              // Convert to MeshStandardMaterial for PBR/environment lighting support
              const materials = Array.isArray(child.material) ? child.material : [child.material];
              const newMaterials: any[] = [];
              materials.forEach((mat: any) => {
                if (mat) {
                  // Convert to MeshStandardMaterial if it isn't already
                  let standardMat: THREE.MeshStandardMaterial;
                  if (mat.isMeshStandardMaterial) {
                    standardMat = mat.clone();
                  } else {
                    standardMat = new THREE.MeshStandardMaterial({
                      color: mat.color || 0xffffff,
                      map: mat.map || null,
                      metalness: 0.1,
                      roughness: 0.5
                    });
                  }
                  standardMat.transparent = true;

                  // Base (no jointName) should be fully transparent
                  // Joints use configured hardware robot color and transparency
                  if (!jointName) {
                    standardMat.opacity = 0;
                  } else {
                    const opacity = useRobotConfigStore.getState().hardwareRobotTransparency;
                    const color = useRobotConfigStore.getState().hardwareRobotColor;
                    standardMat.opacity = opacity;
                    standardMat.color.set(color);
                  }

                  standardMat.depthWrite = false;
                  standardMat.side = THREE.DoubleSide;
                  standardMat.userData.isActualMaterial = true;
                  standardMat.needsUpdate = true;

                  newMaterials.push(standardMat);
                }
              });

              child.material = Array.isArray(child.material) ? newMaterials : newMaterials[0];
              child.renderOrder = -1; // Render ghost first

              // Log details for first few meshes
              if (hardwareMeshesProcessed <= 3) {
                logger.debug(`Hardware mesh #${hardwareMeshesProcessed}: joint=${jointName}, hasGeom=${!!child.geometry}, opacity=${jointName ? useRobotConfigStore.getState().hardwareRobotTransparency : 0}`, 'RobotSetup');
              }
            }
          });
          logger.debug(`Hardware: Processed ${hardwareMeshesProcessed} meshes (${hardwareMeshesWithJoint} with jointName, ${hardwareMeshesWithoutJoint} without)`, 'RobotSetup');

          // Set initial joint positions for hardware robot
          const hardwareInitialAngles = getHomePosition();
          applyJointAnglesToUrdf(hardwareRobot, hardwareInitialAngles);
          hardwareRobot.updateMatrixWorld(true);
        }, 500); // Wait 500ms for meshes to load
      },
      undefined, // onProgress callback (not used)
      (error: Error) => {
        logger.error('Failed to load URDF', 'RobotViewer', error);
      }
    );

    // Cleanup function to dispose robot resources when component unmounts
    return () => {
      disposeURDFRobot(robotRef.current);
      disposeURDFRobot(hardwareRobotRef.current);
      robotRef.current = null;
      hardwareRobotRef.current = null;
      useCommandStore.setState({ commanderRobotRef: null });
      useHardwareStore.setState({ hardwareRobotRef: null });
    };
  }, [robotProfileLoaded]);

  // Fetch and load active tool mesh
  useEffect(() => {
    const fetchAndLoadTool = async () => {
      try {
        logger.debug('Tool mesh loading triggered', 'RobotViewer', {
          activeToolId,
          commanderToolFromStore: commanderToolFromStore?.id
        });

        // Determine which tool to load:
        // 1. During scrubbing/playback: use commanderToolFromStore (updated by useScrubbing)
        // 2. During UI selection: use activeToolId prop
        // 3. On initial load: fetch from backend

        let tool: Tool | null = null;
        let allTools: Tool[] = [];

        // Always fetch tools list for availableTools state
        const response = await fetch(`${getApiBaseUrl()}/api/config/tools`);
        if (!response.ok) {
          logger.error(`Failed to fetch tools: ${response.status} ${response.statusText}`, 'RobotViewer');
          return;
        }

        const data = await response.json();
        allTools = data.tools || [];
        setAvailableTools(allTools);

        // Use tool from store if available (updated by scrubbing), otherwise use activeToolId
        const effectiveToolId = commanderToolFromStore?.id || activeToolId || data.active_tool_id;

        // Find the tool in the list
        tool = allTools.find((t: Tool) => t.id === effectiveToolId) || null;
        if (!tool) {
          logger.error(`Tool not found: ${effectiveToolId}`, 'RobotViewer', { availableTools: allTools.map((t: Tool) => t.id) });
          return;
        }

        setCurrentTool(tool);

        // Sync tool to commander and kinematics stores for FK/IK
        // (Only if not already set by scrubbing)
        // NOTE: Do NOT sync to hardwareStore - hardware tool only changes via mount API
        if (commanderToolFromStore?.id !== tool.id) {
          useCommandStore.setState({ commanderTool: tool });
          useKinematicsStore.setState({ computationTool: tool });
          logger.debug(`Synced tool to commander/kinematics stores: ${tool.name}`, 'RobotViewer');
        }

        // Load tool mesh if it has one (for non-gripper tools)
        if (tool.mesh_file && !tool.gripper_config?.enabled) {
          const meshResponse = await fetch(`/urdf/meshes/${tool.mesh_file}`);
          if (!meshResponse.ok) {
            logger.error(`Failed to fetch tool mesh: ${meshResponse.status} ${meshResponse.statusText}`, 'RobotViewer', { mesh_file: tool.mesh_file });
            return;
          }

          const arrayBuffer = await meshResponse.arrayBuffer();
          const fileType = getMeshFileType(tool.mesh_file);
          const units = tool.mesh_units || 'mm';
          const scale = units === 'mm' ? 0.001 : 1;

          if (fileType === 'stl') {
            const loader = new STLLoader();
            const geometry = loader.parse(arrayBuffer);
            geometry.scale(scale, scale, scale);
            setToolMeshGeometry(geometry);
            setToolGltfScene(null);
          } else if (fileType === 'glb' || fileType === 'gltf') {
            const loader = new GLTFLoader();
            const gltf = await new Promise<any>((resolve, reject) => {
              loader.parse(arrayBuffer, '', resolve, reject);
            });
            gltf.scene.scale.set(scale, scale, scale);
            setToolGltfScene(gltf.scene.clone());
            setToolMeshGeometry(null);
          }

          setGripperMeshOpen(null);
          setGripperMeshClosed(null);
          setGripperGltfOpen(null);
          setGripperGltfClosed(null);
          logger.debug(`Tool mesh loaded successfully: ${tool.name} (${tool.mesh_file})`, 'RobotViewer');
        } else if (tool.gripper_config?.enabled) {
          // Load gripper meshes (open and closed states)
          const units = tool.mesh_units || 'mm';
          const scale = units === 'mm' ? 0.001 : 1;

          // Load open state mesh
          if (tool.gripper_config.mesh_file_open) {
            try {
              const meshResponse = await fetch(`/urdf/meshes/${tool.gripper_config.mesh_file_open}`);
              if (meshResponse.ok) {
                const arrayBuffer = await meshResponse.arrayBuffer();
                const fileType = getMeshFileType(tool.gripper_config.mesh_file_open);

                if (fileType === 'stl') {
                  const loader = new STLLoader();
                  const geometry = loader.parse(arrayBuffer);
                  geometry.scale(scale, scale, scale);
                  setGripperMeshOpen(geometry);
                  setGripperGltfOpen(null);
                } else if (fileType === 'glb' || fileType === 'gltf') {
                  const loader = new GLTFLoader();
                  const gltf = await new Promise<any>((resolve, reject) => {
                    loader.parse(arrayBuffer, '', resolve, reject);
                  });
                  gltf.scene.scale.set(scale, scale, scale);
                  setGripperGltfOpen(gltf.scene.clone());
                  setGripperMeshOpen(null);
                }
              } else {
                setGripperMeshOpen(null);
                setGripperGltfOpen(null);
              }
            } catch (error) {
              logger.error('Failed to load gripper open mesh', 'RobotViewer', error);
              setGripperMeshOpen(null);
              setGripperGltfOpen(null);
            }
          } else {
            setGripperMeshOpen(null);
            setGripperGltfOpen(null);
          }

          // Load closed state mesh
          if (tool.gripper_config.mesh_file_closed) {
            try {
              const meshResponse = await fetch(`/urdf/meshes/${tool.gripper_config.mesh_file_closed}`);
              if (meshResponse.ok) {
                const arrayBuffer = await meshResponse.arrayBuffer();
                const fileType = getMeshFileType(tool.gripper_config.mesh_file_closed);

                if (fileType === 'stl') {
                  const loader = new STLLoader();
                  const geometry = loader.parse(arrayBuffer);
                  geometry.scale(scale, scale, scale);
                  setGripperMeshClosed(geometry);
                  setGripperGltfClosed(null);
                } else if (fileType === 'glb' || fileType === 'gltf') {
                  const loader = new GLTFLoader();
                  const gltf = await new Promise<any>((resolve, reject) => {
                    loader.parse(arrayBuffer, '', resolve, reject);
                  });
                  gltf.scene.scale.set(scale, scale, scale);
                  setGripperGltfClosed(gltf.scene.clone());
                  setGripperMeshClosed(null);
                }
              } else {
                setGripperMeshClosed(null);
                setGripperGltfClosed(null);
              }
            } catch (error) {
              logger.error('Failed to load gripper closed mesh', 'RobotViewer', error);
              setGripperMeshClosed(null);
              setGripperGltfClosed(null);
            }
          } else {
            setGripperMeshClosed(null);
            setGripperGltfClosed(null);
          }

          // Clear single mesh state for gripper tools
          setToolMeshGeometry(null);
          setToolGltfScene(null);
          logger.debug(`Gripper tool meshes loaded: ${tool.name}`, 'RobotViewer', {
            open: tool.gripper_config.mesh_file_open,
            closed: tool.gripper_config.mesh_file_closed
          });
        } else {
          // No mesh at all
          setToolMeshGeometry(null);
          setToolGltfScene(null);
          setGripperMeshOpen(null);
          setGripperMeshClosed(null);
          setGripperGltfOpen(null);
          setGripperGltfClosed(null);
        }
      } catch (error) {
        logger.error('Failed to load tool mesh', 'RobotViewer', error);
      }
    };

    fetchAndLoadTool();
  }, [activeToolId, commanderToolFromStore]); // Watch entire object to detect any tool changes

  // Update joint angles for target robot + apply coloring
  useEffect(() => {
    if (!robotRef.current) return;

    // Apply commanded joint angles to commander robot using centralized helper
    applyJointAnglesToUrdf(robotRef.current, commandedJointAngles);

    // Apply coloring to joint meshes (separate pass for clarity)
    let coloredMeshCount = 0;
    let skippedActualCount = 0;

    robotRef.current.traverse((child: any) => {
      if (child.isMesh) {
        // Check if this is a ghost mesh that should be skipped
        if (child.userData.isActual) {
          skippedActualCount++;
          return; // Skip ghost meshes!
        }

        // Only highlight selected joint (no color coding based on position)
        if (child.userData.jointName && child.material) {
          coloredMeshCount++;
          const jointKey = child.userData.jointName as JointName;

          // Add emissive for selection only
          if (selectedJoint === jointKey) {
            child.material.emissive.setHex(0xf97316); // orange-500 - contrasts well with blue transparent actual robot
            child.material.emissiveIntensity = 0.5;
          } else {
            child.material.emissive.setHex(0x000000);
            child.material.emissiveIntensity = 0;
          }

          child.material.needsUpdate = true;
        }
      }
    });
  }, [commandedJointAngles, selectedJoint]);

  // Update hardware robot from hardware feedback (WebSocket data)
  useEffect(() => {
    if (!hardwareRobotRef.current) return;

    // Use hardware joint angles from robot feedback, or fallback to home position
    const angles = hardwareJointAngles || getHomePosition();

    // Apply hardware joint angles using centralized helper
    applyJointAnglesToUrdf(hardwareRobotRef.current, angles);
  }, [hardwareJointAngles]);

  // Update hardware robot appearance when config changes
  useEffect(() => {
    if (!hardwareRobotRef.current) return;

    hardwareRobotRef.current.traverse((child: any) => {
      if (child.isMesh && child.userData.isActual && child.userData.jointName) {
        // Handle both single materials and material arrays
        const materials = Array.isArray(child.material) ? child.material : [child.material];

        materials.forEach((mat: any) => {
          if (mat && mat.userData.isActualMaterial) {
            // Update color and transparency from config
            mat.color.set(hardwareRobotColor);
            mat.transparent = true;
            mat.opacity = hardwareRobotTransparency;
            mat.depthWrite = false;
            mat.needsUpdate = true;
          }
        });
      }
    });
  }, [hardwareRobotColor, hardwareRobotTransparency]);

  // Update commander robot appearance when config changes
  useEffect(() => {
    if (!robotRef.current) return;

    robotRef.current.traverse((child: any) => {
      if (child.isMesh && !child.userData.isActual && child.userData.jointName) {
        // Handle both single materials and material arrays
        const materials = Array.isArray(child.material) ? child.material : [child.material];

        materials.forEach((mat: any) => {
          if (mat && mat.userData.isCloned) {
            // Update color and transparency from config
            mat.color.set(commanderRobotColor);
            mat.transparent = commanderRobotTransparency < 1.0;
            mat.opacity = commanderRobotTransparency;
            mat.depthWrite = commanderRobotTransparency >= 1.0;
            mat.needsUpdate = true;
          }
        });
      }
    });
  }, [commanderRobotColor, commanderRobotTransparency]);

  // Debug hardware robot rendering conditions
  useEffect(() => {
    logger.debug(`Hardware robot render check: showHardwareRobot=${showHardwareRobot}, hardwareRobotRef=${!!hardwareRobotRef.current}, shouldRender=${showHardwareRobot && !!hardwareRobotRef.current}`, 'RobotRender');
    if (hardwareRobotRef.current) {
      let meshCount = 0;
      hardwareRobotRef.current.traverse((child: any) => { if (child.isMesh) meshCount++; });
      logger.debug(`Hardware robot has ${meshCount} meshes in scene`, 'RobotRender');
    }
  }, [showHardwareRobot, hardwareRobotRef.current]);

  return (
    <>
      <group rotation={[-Math.PI / 2, 0, 0]}>
        {/* Hardware robot (transparent, shows hardware feedback) */}
        {showHardwareRobot && hardwareRobotRef.current && <primitive object={hardwareRobotRef.current} />}

        {/* Target robot with interactive meshes (shows commanded position) */}
        {showTargetRobot && robotRef.current && <InteractiveRobotMeshes robot={robotRef.current} />}
      </group>

      {/* Tool mesh - attached to target robot (outside rotated group) */}
      {showTargetRobot && robotRef.current && (
        <ToolMesh
          geometry={toolMeshGeometry}
          gltfScene={toolGltfScene}
          gripperMeshOpen={gripperMeshOpen}
          gripperMeshClosed={gripperMeshClosed}
          gltfSceneOpen={gripperGltfOpen}
          gltfSceneClosed={gripperGltfClosed}
          displayState={commandedGripperState}
          robotRef={robotRef.current}
          tool={currentTool}
          color={commanderRobotColor}
          transparency={commanderRobotTransparency}
        />
      )}

      {/* Tool mesh - attached to hardware robot (outside rotated group) */}
      {/* Hardware robot shows PHYSICALLY mounted tool (not timeline tool) */}
      {/* Uses uniform material to match robot appearance (strips GLB textures/colors) */}
      {showHardwareRobot && hardwareRobotRef.current && hardwareTool && (
        <ToolMesh
          geometry={toolMeshGeometry}
          gltfScene={toolGltfScene}
          gripperMeshOpen={gripperMeshOpen}
          gripperMeshClosed={gripperMeshClosed}
          gltfSceneOpen={gripperGltfOpen}
          gltfSceneClosed={gripperGltfClosed}
          displayState={hardwareGripperState || 'open'}
          robotRef={hardwareRobotRef.current}
          tool={hardwareTool}
          color={hardwareRobotColor}
          transparency={hardwareRobotTransparency}
          useUniformMaterial={true}
        />
      )}

      <Grid args={[10, 10]} cellColor="#6b6b6b" sectionColor="#3f3f3f" />
    </>
  );
}

export default function RobotViewer({ activeToolId }: { activeToolId?: string } = {}) {
  // Input store: User input state
  const inputJointAngles = useInputStore((state) => state.inputJointAngles);
  const setInputJointAngle = useInputStore((state) => state.setInputJointAngle);
  const inputCartesianPose = useInputStore((state) => state.inputCartesianPose);
  const setInputCartesianValue = useInputStore((state) => state.setInputCartesianValue);
  const selectedJoint = useInputStore((state) => state.selectedJoint);
  const setSelectedJoint = useInputStore((state) => state.setSelectedJoint);
  const showHardwareRobot = useInputStore((state) => state.showHardwareRobot);
  const setShowHardwareRobot = useInputStore((state) => state.setShowHardwareRobot);
  const showTargetRobot = useInputStore((state) => state.showTargetRobot);
  const setShowTargetRobot = useInputStore((state) => state.setShowTargetRobot);
  const showPath = useInputStore((state) => state.showPath);
  const setShowPath = useInputStore((state) => state.setShowPath);

  // Command store: Commanded robot state
  const commandedJointAngles = useCommandStore((state) => state.commandedJointAngles);
  const setCommandedJointAngle = useCommandStore((state) => state.setCommandedJointAngle);
  const setCommandedJointAngles = useCommandStore((state) => state.setCommandedJointAngles);
  const commandedTcpPose = useCommandStore((state) => state.commandedTcpPose);
  const commanderRobotRef = useCommandStore((state) => state.commanderRobotRef);
  const teachModeEnabled = useCommandStore((state) => state.teachModeEnabled);
  const setTeachModeEnabled = useCommandStore((state) => state.setTeachModeEnabled);
  const liveControlEnabled = useCommandStore((state) => state.liveControlEnabled);
  const setLiveControlEnabled = useCommandStore((state) => state.setLiveControlEnabled);
  const speed = useCommandStore((state) => state.speed);
  const commanderTool = useCommandStore((state) => state.commanderTool);
  const commandedGripperState = useCommandStore((state) => state.commandedGripperState);

  // Hardware store: Hardware feedback
  const hardwareJointAngles = useHardwareStore((state) => state.hardwareJointAngles);
  const hardwareTcpPose = useHardwareStore((state) => state.hardwareTcpPose);
  const hardwareCartesianPose = useHardwareStore((state) => state.hardwareCartesianPose);
  const connectionStatus = useHardwareStore((state) => state.connectionStatus);
  const robotStatus = useHardwareStore((state) => state.robotStatus);

  // Timeline store: Timeline state
  const motionMode = useTimelineStore((state) => state.timeline.mode);

  // Config store: Robot configuration
  const tcpOffset = useRobotConfigStore((state) => state.tcpOffset);
  const ikAxisMask = useRobotConfigStore((state) => state.ikAxisMask);
  const hardwareRobotColor = useRobotConfigStore((state) => state.hardwareRobotColor);
  const hardwareRobotTransparency = useRobotConfigStore((state) => state.hardwareRobotTransparency);
  const commanderRobotColor = useRobotConfigStore((state) => state.commanderRobotColor);
  const commanderRobotTransparency = useRobotConfigStore((state) => state.commanderRobotTransparency);

  // Kinematics store: Computation robot for IK/FK
  const computationRobotRef = useKinematicsStore((state) => state.computationRobotRef);
  const computationTool = useKinematicsStore((state) => state.computationTool);

  // Hardware store: Actual robot state (separate from commander)
  const hardwareTool = useHardwareStore((state) => state.hardwareTool);
  const hardwareGripperState = useHardwareStore((state) => state.gripperStatus);

  // Safety confirmation hook
  const { confirmAction, SafetyDialog } = useSafetyConfirmation();

  // Step angles for keyboard controls
  const stepAngle = useInputStore((state) => state.stepAngle);
  const cartesianPositionStep = useInputStore((state) => state.cartesianPositionStep);

  const [showLabels, setShowLabels] = useState(true);

  // Available tools for per-segment tool support
  const [availableTools, setAvailableTools] = useState<Tool[]>([]);

  // Record preset dialog state
  const [recordDialogOpen, setRecordDialogOpen] = useState(false);
  const [presetName, setPresetName] = useState('');

  // Help dialog state
  const [helpDialogOpen, setHelpDialogOpen] = useState(false);

  // Help annotations state - show by default on first visit, persist preference
  const [showHelpAnnotations, setShowHelpAnnotations] = useState(false);
  const [annotationsInitialized, setAnnotationsInitialized] = useState(false);
  const connectionStatusRef = useRef<HTMLDivElement>(null);
  const liveControlRef = useRef<HTMLDivElement>(null);
  const targetPresetsRef = useRef<HTMLDivElement>(null);
  const helpButtonRef = useRef<HTMLDivElement>(null);

  // Config store for saving presets
  const { config, saveConfig } = useConfigStore();
  const isDebugMode = config?.ui?.debug_mode === true;

  // Get all saved positions from config
  const savedPositions = getAllPositions();

  // Track last valid cartesian pose for IK failure recovery
  const lastValidCartesianPose = useRef(inputCartesianPose);

  // Keep ref in sync with external inputCartesianPose changes
  // (e.g., from timeline pause sync, manual slider changes)
  useEffect(() => {
    lastValidCartesianPose.current = inputCartesianPose;
  }, [inputCartesianPose]);

  // Initialize help annotations from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem('hideHelpAnnotations');
    // If never set (first visit), show annotations; otherwise respect stored preference
    setShowHelpAnnotations(stored !== 'true');
    setAnnotationsInitialized(true);
  }, []);

  // Persist help annotations preference to localStorage (only after initialization)
  useEffect(() => {
    if (annotationsInitialized) {
      localStorage.setItem('hideHelpAnnotations', showHelpAnnotations ? 'false' : 'true');
    }
  }, [showHelpAnnotations, annotationsInitialized]);

  // Help annotations effect
  useEffect(() => {
    if (!showHelpAnnotations) return;

    const annotations: ReturnType<typeof annotate>[] = [];

    if (connectionStatusRef.current) {
      const a1 = annotate(connectionStatusRef.current, {
        type: 'underline',
        color: '#f97316', // orange-500
        strokeWidth: 2,
        padding: 2,
        animationDuration: 400,
      });
      annotations.push(a1);
    }

    if (liveControlRef.current) {
      const a2 = annotate(liveControlRef.current, {
        type: 'underline',
        color: '#facc15', // yellow-400
        strokeWidth: 2,
        padding: 2,
        animationDuration: 400,
      });
      annotations.push(a2);
    }

    // Mode tabs (in page.tsx, query by data attribute)
    const modeTabsEl = document.querySelector('[data-help-target="mode-tabs"]') as HTMLElement;
    if (modeTabsEl) {
      const a3 = annotate(modeTabsEl, {
        type: 'bracket',
        brackets: ['top'],
        color: '#22c55e', // green-500
        strokeWidth: 2,
        padding: 4,
        animationDuration: 400,
      });
      annotations.push(a3);
    }

    // Timeline (in page.tsx, query by data attribute)
    const timelineEl = document.querySelector('[data-help-target="timeline"]') as HTMLElement;
    if (timelineEl) {
      const a4 = annotate(timelineEl, {
        type: 'box',
        color: '#3b82f6', // blue-500
        strokeWidth: 2,
        padding: 4,
        animationDuration: 400,
      });
      annotations.push(a4);
    }

    // Target Presets (ref in this component)
    if (targetPresetsRef.current) {
      const a5 = annotate(targetPresetsRef.current, {
        type: 'box',
        color: '#ec4899', // pink-500
        strokeWidth: 2,
        padding: 4,
        animationDuration: 400,
      });
      annotations.push(a5);
    }

    // Tool Selector (in page.tsx, query by data attribute)
    const toolSelectorEl = document.querySelector('[data-help-target="tool-selector"]') as HTMLElement;
    if (toolSelectorEl) {
      const a6 = annotate(toolSelectorEl, {
        type: 'bracket',
        brackets: ['left'],
        color: '#a855f7', // purple-500
        strokeWidth: 2,
        padding: 4,
        animationDuration: 400,
      });
      annotations.push(a6);
    }

    // Help button (keyboard shortcuts)
    if (helpButtonRef.current) {
      const a7 = annotate(helpButtonRef.current, {
        type: 'circle',
        color: '#14b8a6', // teal-500
        strokeWidth: 2,
        padding: 2,
        animationDuration: 400,
      });
      annotations.push(a7);
    }

    // Show all annotations
    const group = annotationGroup(annotations);
    group.show();

    return () => {
      annotations.forEach(a => {
        a.hide();
        a.remove();
      });
    };
  }, [showHelpAnnotations]);

  // Handle going to a preset position
  const handleGoToPosition = async (joints: { J1: number; J2: number; J3: number; J4: number; J5: number; J6: number }, presetName: string) => {
    // Safety confirmation check
    const confirmed = await confirmAction(
      `Move robot to "${presetName}" preset position?`,
      'Confirm Preset Movement'
    );
    if (!confirmed) return;

    // Set both input and commanded joint positions
    Object.entries(joints).forEach(([joint, angle]) => {
      setInputJointAngle(joint as any, angle);
      setCommandedJointAngle(joint as any, angle);
    });

    // If in cartesian mode, also update cartesian input sliders and RGB gizmo
    // to match the FK of the joint angles
    if (motionMode === 'cartesian' && commanderRobotRef) {
      // Apply joint angles to commander robot using centralized helper
      applyJointAnglesToUrdf(commanderRobotRef, joints);

      // Calculate FK to get cartesian position
      const threeJsPose = calculateTcpPoseFromUrdf(commanderRobotRef, tcpOffset);

      if (threeJsPose) {
        // Convert Three.js coords to robot coords
        const robotPose = threeJsToRobot(threeJsPose);

        // Update cartesian input sliders to match
        setInputCartesianValue('X', robotPose.X);
        setInputCartesianValue('Y', robotPose.Y);
        setInputCartesianValue('Z', robotPose.Z);
        setInputCartesianValue('RX', robotPose.RX);
        setInputCartesianValue('RY', robotPose.RY);
        setInputCartesianValue('RZ', robotPose.RZ);
      }
    }
  };

  // Handle record button click - open dialog
  const handleRecordClick = () => {
    setPresetName('');
    setRecordDialogOpen(true);
  };

  // Save preset to config.yaml
  const handleSavePreset = async () => {
    if (!presetName.trim()) {
      alert('Please enter a name for the preset');
      return;
    }

    // Get current commanded joint angles
    const newPreset = {
      name: presetName.trim(),
      joints: [
        commandedJointAngles.J1,
        commandedJointAngles.J2,
        commandedJointAngles.J3,
        commandedJointAngles.J4,
        commandedJointAngles.J5,
        commandedJointAngles.J6,
      ],
    };

    // Add to existing presets
    const currentPresets = config?.ui?.saved_positions || [];
    const updatedPresets = [...currentPresets, newPreset];

    try {
      // Save config with updated presets - saveConfig handles the PATCH request and store update
      await saveConfig({
        ui: {
          ...config?.ui,
          saved_positions: updatedPresets,
        } as any,
      });

      // Close dialog and reset name
      setRecordDialogOpen(false);
      setPresetName('');
    } catch (error) {
      logger.error('Error saving preset', 'RobotViewer', error);
      alert('Failed to save preset. Please try again.');
    }
  };

  // Keyboard controls for joint adjustment
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Ignore keyboard events when typing in input fields
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target as HTMLElement).isContentEditable
      ) {
        return;
      }

      // Handle Escape key to deselect
      if (event.key === 'Escape') {
        setSelectedJoint(null);
        return;
      }

      // Handle number keys 1-6 to select joints J1-J6 (but not Alt+number for presets)
      if (event.key >= '1' && event.key <= '6' && !event.altKey) {
        const jointNumber = parseInt(event.key);
        const jointName = `J${jointNumber}` as JointName;
        setSelectedJoint(jointName);
        return;
      }

      // Handle W/S keys for joint adjustment (only when joint is selected)
      if (selectedJoint && (event.key === 'w' || event.key === 'W' || event.key === 's' || event.key === 'S')) {
        event.preventDefault(); // Prevent page scrolling

        const currentAngle = inputJointAngles[selectedJoint];
        const limits = JOINT_LIMITS[selectedJoint];

        // Calculate step based on modifier keys
        let adjustmentStep = stepAngle;
        if (event.shiftKey) {
          // Shift: fine control (step / 10)
          adjustmentStep = stepAngle / 10;
        } else if (event.ctrlKey || event.metaKey) {
          // Ctrl/Cmd: coarse control (step × 5)
          adjustmentStep = stepAngle * 5;
        }

        // Apply direction (W increases, S decreases)
        const direction = (event.key === 'w' || event.key === 'W') ? 1 : -1;
        const newAngle = currentAngle + (direction * adjustmentStep);

        // Clamp to joint limits
        const clampedAngle = Math.max(limits.min, Math.min(limits.max, newAngle));

        // Update both input and commanded stores
        setInputJointAngle(selectedJoint, clampedAngle);
        setCommandedJointAngle(selectedJoint, clampedAngle);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedJoint, inputJointAngles, stepAngle, setInputJointAngle, setCommandedJointAngle, setSelectedJoint]);

  // Keyboard controls for cartesian TCP adjustment (WASD-QE keys)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isDebugMode) {
        console.log('========== QWEASD Key Pressed ==========');
        console.log('Key:', event.key);
        console.log('Motion Mode:', motionMode);
      }

      // Only active in cartesian mode
      if (motionMode !== 'cartesian') {
        if (isDebugMode) {
          console.log('❌ Exiting: Not in cartesian mode');
        }
        return;
      }

      // Ignore keyboard events when typing in input fields
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target as HTMLElement).isContentEditable
      ) {
        if (isDebugMode) {
          console.log('❌ Exiting: Typing in input field');
        }
        return;
      }

      // Key mapping: WASD-QE for position, Alt+WASD-QE for rotation
      const keyMap: { [key: string]: { axis: CartesianAxis, direction: number, isRotation: boolean } } = {
        'a': { axis: 'Y', direction: -1, isRotation: false },
        'd': { axis: 'Y', direction: 1, isRotation: false },
        'w': { axis: 'X', direction: 1, isRotation: false },
        's': { axis: 'X', direction: -1, isRotation: false },
        'q': { axis: 'Z', direction: -1, isRotation: false },
        'e': { axis: 'Z', direction: 1, isRotation: false },
        'A': { axis: 'Y', direction: -1, isRotation: false },
        'D': { axis: 'Y', direction: 1, isRotation: false },
        'W': { axis: 'X', direction: 1, isRotation: false },
        'S': { axis: 'X', direction: -1, isRotation: false },
        'Q': { axis: 'Z', direction: -1, isRotation: false },
        'E': { axis: 'Z', direction: 1, isRotation: false },
      };

      const keyPressed = event.key;
      const keyConfig = keyMap[keyPressed.toLowerCase()];

      if (isDebugMode) {
        console.log('Key Config:', keyConfig);
      }

      if (!keyConfig) {
        if (isDebugMode) {
          console.log('❌ Exiting: Key not in keyMap');
        }
        return;
      }

      if (isDebugMode) {
        console.log('✓ Valid cartesian jog key, preventing default');
      }
      event.preventDefault(); // Prevent page scrolling

      // Determine axis (switch to rotation if Alt is pressed)
      let axis: CartesianAxis = keyConfig.axis;
      if (event.altKey) {
        // Convert X/Y/Z to RX/RY/RZ
        axis = `R${keyConfig.axis}` as CartesianAxis;
      }

      // Calculate step size based on modifier keys and axis type
      const isRotationAxis = axis.startsWith('R');
      let step: number;

      if (isRotationAxis) {
        // Rotation steps in degrees (from step_angle setting)
        if (event.shiftKey) {
          step = stepAngle / 10; // Fine
        } else if (event.ctrlKey || event.metaKey) {
          step = stepAngle * 5; // Coarse
        } else {
          step = stepAngle; // Normal
        }
      } else {
        // Position steps in mm (from cartesian_position_step_mm setting)
        if (event.shiftKey) {
          step = cartesianPositionStep / 10; // Fine
        } else if (event.ctrlKey || event.metaKey) {
          step = cartesianPositionStep * 5; // Coarse
        } else {
          step = cartesianPositionStep; // Normal
        }
      }

      // Get current value and limits (read fresh from store to avoid stale closure)
      const currentValue = useInputStore.getState().inputCartesianPose[axis];
      const limits = CARTESIAN_LIMITS[axis];

      if (isDebugMode) {
        console.log('Current inputCartesianPose:', useInputStore.getState().inputCartesianPose);
        console.log('Current value for', axis, ':', currentValue);
        console.log('Step:', step);
      }

      // Calculate new value
      const newValue = currentValue + (keyConfig.direction * step);

      if (isDebugMode) {
        console.log('New value (before clamp):', newValue);
      }

      // Clamp to limits
      const clampedValue = Math.max(limits.min, Math.min(limits.max, newValue));

      if (isDebugMode) {
        console.log('Clamped value:', clampedValue);
      }

      // Build new cartesian pose with updated value (use fresh store state)
      const currentPose = useInputStore.getState().inputCartesianPose;
      const newCartesianPose = { ...currentPose, [axis]: clampedValue };

      if (isDebugMode) {
        console.log('New cartesian pose for IK:', newCartesianPose);
        console.log('commanderRobotRef:', commanderRobotRef ? 'EXISTS' : 'NULL');
        console.log('computationRobotRef:', computationRobotRef ? 'EXISTS' : 'NULL');
        console.log('computationTool:', computationTool);
      }

      // Try to solve IK for the new pose
      if (!commanderRobotRef) {
        if (isDebugMode) {
          console.log('⚠️ No commanderRobotRef, just updating value without IK');
        }
        // If robot not loaded yet, just update the value
        setInputCartesianValue(axis, clampedValue);
        return;
      }

      if (isDebugMode) {
        console.log('🎯 Calling IK solver...');
      }

      const ikResult = inverseKinematicsDetailed(
        newCartesianPose,
        useCommandStore.getState().commandedJointAngles, // Use fresh state for IK seed
        computationRobotRef,
        computationTool,
        ikAxisMask
      );

      if (isDebugMode) {
        console.log('IK Result:', ikResult);
        console.log('IK Success:', ikResult.success);
        console.log('IK Joint Angles:', ikResult.jointAngles);
        console.log('IK Error:', ikResult.error);
        console.log('=======================================');
      }

      if (ikResult.success && ikResult.jointAngles) {
        // IK succeeded - update both cartesian input and commanded joint angles
        setInputCartesianValue(axis, clampedValue);
        setCommandedJointAngles(ikResult.jointAngles);

        // Store as last valid pose
        lastValidCartesianPose.current = newCartesianPose;
      } else {
        // IK failed - revert to last valid pose
        logger.warn('Failed to reach target position, reverting to last valid pose', 'IK');
        // Update input cartesian pose to last valid
        Object.entries(lastValidCartesianPose.current).forEach(([key, value]) => {
          setInputCartesianValue(key as CartesianAxis, value);
        });

        // Optional: Play error sound or show visual feedback
        // You could add a toast notification here
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [motionMode, setInputCartesianValue, setCommandedJointAngles, commanderRobotRef, computationRobotRef, computationTool, ikAxisMask, stepAngle, cartesianPositionStep]);

  // Spacebar shortcut: Move to Target (Joint) with safety confirmation
  useEffect(() => {
    const handleKeyDown = async (event: KeyboardEvent) => {
      // Ignore keyboard events when typing in input fields
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target as HTMLElement).isContentEditable
      ) {
        return;
      }

      // Handle spacebar key (but not Shift+Space, which is handled separately)
      if ((event.key === ' ' || event.code === 'Space') && !event.shiftKey) {
        event.preventDefault(); // Prevent page scrolling

        logger.debug('Space pressed, commanded angles', 'JointMotion', { commandedJointAngles });

        // Safety confirmation check
        const confirmed = await confirmAction(
          'Move robot to target position using joint space motion?',
          'Confirm Joint Movement'
        );
        if (!confirmed) {
          logger.debug('User cancelled', 'JointMotion');
          return;
        }

        // Execute joint movement
        try {
          logger.debug('Sending moveJoints command...', 'JointMotion');
          const result = await moveJoints(commandedJointAngles, speed);
          logger.debug('Result', 'JointMotion', result);
          if (!result.success) {
            alert(`Failed to move robot (joint): ${result.error || 'Unknown error'}`);
          } else {
            logger.debug('Command sent successfully', 'JointMotion');
            // Also send gripper state if tool has gripper enabled
            if (commanderTool?.gripper_config?.enabled && commandedGripperState) {
              await setGripperOutput(commanderTool, commandedGripperState);
            }
          }
        } catch (error) {
          logger.error('Error sending move command', 'JointMotion', error);
          alert('Failed to communicate with robot');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [commandedJointAngles, speed, confirmAction, commanderTool, commandedGripperState]);

  // Alt+number shortcuts: Go to preset positions
  useEffect(() => {
    const handleKeyDown = async (event: KeyboardEvent) => {
      // Ignore keyboard events when typing in input fields
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target as HTMLElement).isContentEditable
      ) {
        return;
      }

      // Handle Alt+number keys for preset positions
      if (event.altKey && event.key >= '1' && event.key <= '9') {
        event.preventDefault(); // Prevent browser shortcuts

        const presetIndex = parseInt(event.key) - 1; // Convert to 0-based index

        // Check if preset exists
        if (presetIndex < savedPositions.length) {
          const position = savedPositions[presetIndex];
          await handleGoToPosition(position.joints, position.name);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [savedPositions, handleGoToPosition]);

  // Shift+Spacebar shortcut: Execute Cartesian Motion using frontend IK
  useEffect(() => {
    const handleKeyDown = async (event: KeyboardEvent) => {
      // Ignore keyboard events when typing in input fields
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target as HTMLElement).isContentEditable
      ) {
        return;
      }

      // Handle Shift+Space for cartesian movement
      if ((event.key === ' ' || event.code === 'Space') && event.shiftKey) {
        event.preventDefault();

        // Get required data from stores
        const hardwareJointAngles = useHardwareStore.getState().hardwareJointAngles;
        const hardwareTcpPose = useHardwareStore.getState().hardwareTcpPose;
        const commandedJointAngles = useCommandStore.getState().commandedJointAngles;
        const commandedTcpPose = useCommandStore.getState().commandedTcpPose;
        const commanderRobotRef = useCommandStore.getState().commanderRobotRef;
        const tcpOffset = useRobotConfigStore.getState().tcpOffset;
        const ikAxisMask = useRobotConfigStore.getState().ikAxisMask;
        const speed = useCommandStore.getState().speed;

        // Validate prerequisites
        if (!hardwareJointAngles || !hardwareTcpPose || !commandedTcpPose) {
          alert('Robot pose not available - wait for URDF to load');
          return;
        }

        if (!commanderRobotRef) {
          alert('URDF robot model not loaded yet');
          return;
        }

        // Safety confirmation
        const confirmed = await confirmAction(
          'Move robot to target position using cartesian space motion (straight line)?',
          'Confirm Cartesian Movement'
        );
        if (!confirmed) return;

        // Execute cartesian movement using frontend IK
        try {
          logger.debug('Start pose', 'CartesianMotion', { pose: hardwareTcpPose });
          logger.debug('Target pose', 'CartesianMotion', { pose: commandedTcpPose });

          // Calculate duration based on speed percentage
          const baseDuration = 2.0; // Base duration in seconds
          const duration = baseDuration * (100 / speed);
          const numWaypoints = calculateWaypointCount(duration);

          logger.debug(`Generating ${numWaypoints} waypoints for ${duration.toFixed(2)}s (${speed}% speed)`, 'CartesianMotion');

          // Generate Cartesian waypoints (straight-line interpolation)
          const cartesianWaypoints = generateCartesianWaypoints(hardwareTcpPose, commandedTcpPose, { duration });

          logger.debug(`Generated ${cartesianWaypoints.length} waypoints`, 'CartesianMotion');

          // Solve IK for each waypoint using frontend solver
          logger.debug('Solving IK for waypoints...', 'CartesianMotion');
          const startTime = performance.now();
          const jointTrajectory: number[][] = [];
          let currentSeed = { ...hardwareJointAngles };

          for (let i = 0; i < cartesianWaypoints.length; i++) {
            const waypoint = cartesianWaypoints[i];

            // Solve IK using frontend numerical solver
            const ikResult = inverseKinematicsDetailed(
              waypoint,
              currentSeed,
              computationRobotRef,
              computationTool,
              ikAxisMask
            );

            if (!ikResult.success || !ikResult.jointAngles) {
              alert(`IK failed at waypoint ${i + 1}/${cartesianWaypoints.length}: ${ikResult.error?.message || 'Unknown error'}`);
              logger.error('IK failed at waypoint', 'CartesianMotion', { waypoint: i, result: ikResult });
              return;
            }

            // Add to trajectory as array [J1, J2, J3, J4, J5, J6]
            const joints = ikResult.jointAngles;
            jointTrajectory.push([joints.J1, joints.J2, joints.J3, joints.J4, joints.J5, joints.J6]);

            // Use this solution as seed for next waypoint (faster convergence)
            currentSeed = joints;
          }

          const elapsed = performance.now() - startTime;
          logger.debug(`IK solved for ${jointTrajectory.length} waypoints in ${elapsed.toFixed(0)}ms`, 'CartesianMotion');

          // Execute trajectory at 100Hz
          logger.debug('Executing trajectory at 100Hz...', 'CartesianMotion');
          const execResult = await executeTrajectory({
            trajectory: jointTrajectory,
            duration: duration,
            wait_for_ack: false
          });

          if (!execResult.success) {
            alert(`Failed to execute trajectory: ${execResult.message}`);
            logger.error('Execute failed', 'CartesianMotion', execResult);
          } else {
            logger.debug(`Trajectory executing (${jointTrajectory.length} waypoints)`, 'CartesianMotion');
          }

        } catch (error) {
          logger.error('Cartesian motion error', 'CartesianMotion', error);
          alert(`Cartesian motion failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [confirmAction]);

  // Handle click on canvas background to deselect joint
  const handleCanvasClick = (event: any) => {
    // Only deselect if clicking on canvas background (not on robot meshes)
    // InteractiveRobotMeshes will call stopPropagation() for mesh clicks
    setSelectedJoint(null);
  };

  return (
    <div className="w-full h-full bg-neutral-100 rounded-lg overflow-hidden border relative">
      {/* IK Progress Bar Overlay */}
      <IKProgressBar />

      {/* Context Menu */}
      <JointContextMenu />

      {/* Coordinate Overlay */}
      <div className="absolute top-4 left-4 bg-black/70 text-white p-3 rounded-lg text-xs font-mono z-10 backdrop-blur-sm max-w-[420px]">
        {/* TCP Pose Section - Robot Coordinates (Z-up) */}
        <div className="mb-3">
          <div className="font-semibold mb-2 text-sm">TCP Pose (Robot Coords)</div>
          {commandedTcpPose || hardwareTcpPose || hardwareCartesianPose ? (
            <div>
              <TCPPoseHeader className="text-[10px] text-gray-400" />
              {commandedTcpPose && (
                <TCPPoseDisplay
                  pose={commandedTcpPose}
                  label="Commanded"
                  colors={{
                    x: '#ff8800',  // Orange
                    y: '#00dddd',  // Cyan
                    z: '#dd00dd'   // Magenta/Fuchsia
                  }}
                  className="mb-0.5"
                />
              )}
              <TCPPoseDisplay
                pose={hardwareJointAngles !== null ? hardwareTcpPose : null}
                label="Hardware"
                colors={{
                  x: '#ffff00',  // Yellow
                  y: '#88ff00',  // Lime
                  z: '#aa00ff'   // Purple
                }}
                className="mb-0.5"
              />
              {isDebugMode && (
                <TCPPoseDisplay
                  pose={hardwareCartesianPose}
                  label="HW Firmware"
                  colors={{
                    x: '#00ff00',  // Green
                    y: '#00ffaa',  // Cyan-Green
                    z: '#00aaff'   // Sky Blue
                  }}
                />
              )}
            </div>
          ) : (
            <div className="text-gray-500 italic">Loading robot model...</div>
          )}
        </div>

        {/* Joint Angles Section */}
        <div className="pt-3 border-t border-gray-700">
          <div className="font-semibold mb-2 text-sm">Joint Angles</div>
          <div>
            {/* Column Headers */}
            <div className="grid grid-cols-7 gap-1 mb-1 text-[10px] text-gray-400 text-center">
              <div></div>
              <div>J1</div>
              <div>J2</div>
              <div>J3</div>
              <div>J4</div>
              <div>J5</div>
              <div>J6</div>
            </div>
            {/* Commanded Row */}
            <div className="grid grid-cols-7 gap-1 mb-0.5">
              <div className="text-gray-400">Commanded:  </div>
              <div className="text-center">{commandedJointAngles.J1.toFixed(1)}</div>
              <div className="text-center">{commandedJointAngles.J2.toFixed(1)}</div>
              <div className="text-center">{commandedJointAngles.J3.toFixed(1)}</div>
              <div className="text-center">{commandedJointAngles.J4.toFixed(1)}</div>
              <div className="text-center">{commandedJointAngles.J5.toFixed(1)}</div>
              <div className="text-center">{commandedJointAngles.J6.toFixed(1)}</div>
            </div>
            {/* Hardware Row */}
            <div className="grid grid-cols-7 gap-1">
              <div className="text-gray-400">Hardware:  </div>
              <div className="text-center">{hardwareJointAngles?.J1.toFixed(1) ?? 'N/A'}</div>
              <div className="text-center">{hardwareJointAngles?.J2.toFixed(1) ?? 'N/A'}</div>
              <div className="text-center">{hardwareJointAngles?.J3.toFixed(1) ?? 'N/A'}</div>
              <div className="text-center">{hardwareJointAngles?.J4.toFixed(1) ?? 'N/A'}</div>
              <div className="text-center">{hardwareJointAngles?.J5.toFixed(1) ?? 'N/A'}</div>
              <div className="text-center">{hardwareJointAngles?.J6.toFixed(1) ?? 'N/A'}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Robot Status - Top Right */}
      <div className="absolute top-4 right-4 bg-black/70 text-white p-2 rounded-lg text-[10px] z-10 backdrop-blur-sm">
        <div className="space-y-1">
          <div ref={connectionStatusRef} className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className={`text-sm ${connectionStatus === 'connected' ? 'text-green-500' : 'text-red-500'}`}>●</span>
              <span className="text-gray-400">Backend</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className={`text-sm ${robotStatus?.is_stopped != null ? 'text-green-500' : 'text-red-500'}`}>●</span>
              <span className="text-gray-400">Robot</span>
              {robotStatus?.commander_hz != null && (
                <span className="font-medium">{robotStatus.commander_hz.toFixed(0)}Hz</span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <span className={`text-sm ${robotStatus?.homed?.every(h => h) ? 'text-green-500' : 'text-red-500'}`}>●</span>
              <span className="text-gray-400">Homed</span>
            </div>
          </div>
          <div ref={liveControlRef} className="flex items-center gap-1.5 pt-1 border-t border-white/20">
            <span className={liveControlEnabled && hardwareJointAngles !== null ? 'text-yellow-400' : 'text-gray-500'}>
              {liveControlEnabled && hardwareJointAngles !== null ? '●' : '○'}
            </span>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-gray-400 cursor-help">Live Control:</span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Hardware follows commanded position</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <Switch
              checked={liveControlEnabled && hardwareJointAngles !== null}
              onCheckedChange={setLiveControlEnabled}
              disabled={robotStatus?.is_stopped == null}
              className="scale-75"
            />
            {liveControlEnabled && hardwareJointAngles !== null && (
              <span className="text-[8px] bg-yellow-500/30 text-yellow-400 px-1 rounded">LIVE</span>
            )}
          </div>
        </div>
      </div>

      {/* Help annotation notes */}
      {showHelpAnnotations && (
        <>
          <div
            className="absolute top-[23px] right-[225px] z-20 text-orange-400 pointer-events-none whitespace-nowrap"
            style={{ fontFamily: "'Patrick Hand', cursive", fontSize: '16px', lineHeight: '1.2' }}
          >
            Connection status to backend and robot
          </div>
          <div
            className="absolute top-[62px] right-[225px] z-20 text-yellow-400 pointer-events-none whitespace-nowrap"
            style={{ fontFamily: "'Patrick Hand', cursive", fontSize: '16px', lineHeight: '1.2' }}
          >
            Live control, robot will move instantly
          </div>
          <div
            className="fixed top-[30px] right-[16px] z-[100] w-[300px] text-green-400 pointer-events-none text-center"
            style={{ fontFamily: "'Patrick Hand', cursive", fontSize: '16px', lineHeight: '1.2' }}
          >
            Toggle between joint angles and coordinate input
          </div>
          <div
            className="fixed bottom-[180px] left-1/2 -translate-x-1/2 z-[100] text-blue-400 pointer-events-none text-center"
            style={{ fontFamily: "'Patrick Hand', cursive", fontSize: '18px', lineHeight: '1.2' }}
          >
            Record, preview and playback motions
          </div>
          <div
            className="absolute bottom-[90px] left-[250px] z-20 max-w-[180px] text-pink-400 pointer-events-none"
            style={{ fontFamily: "'Patrick Hand', cursive", fontSize: '16px', lineHeight: '1.2' }}
          >
            Save and recall robot positions
          </div>
          <div
            className="fixed top-[454px] right-[336px] z-[100] max-w-[180px] text-purple-400 pointer-events-none text-right"
            style={{ fontFamily: "'Patrick Hand', cursive", fontSize: '16px', lineHeight: '1.2' }}
          >
            Change tool and open/close gripper
          </div>
          <div
            className="absolute top-[155px] right-[70px] z-20 text-teal-400 pointer-events-none whitespace-nowrap"
            style={{ fontFamily: "'Patrick Hand', cursive", fontSize: '16px', lineHeight: '1.2' }}
          >
            Keyboard shortcuts
          </div>
        </>
      )}

      {/* Display Controls - Gear Icon Dropdown */}
      <div className="absolute top-[110px] right-4 z-10">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="bg-black/70 text-white p-2 rounded-lg backdrop-blur-sm hover:bg-black/80 transition-colors">
              <Settings className="w-4 h-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuCheckboxItem
              checked={showHardwareRobot}
              onCheckedChange={setShowHardwareRobot}
            >
              Show Hardware Robot
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={showTargetRobot}
              onCheckedChange={setShowTargetRobot}
            >
              Show Commanded Robot
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={showPath}
              onCheckedChange={setShowPath}
            >
              Show Path Preview
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Help Icon - Below Settings */}
      <div ref={helpButtonRef} className="absolute top-[150px] right-4 z-10">
        <button
          onClick={() => setHelpDialogOpen(true)}
          className="bg-black/70 text-white p-2 rounded-lg backdrop-blur-sm hover:bg-black/80 transition-colors"
          title="Keyboard Shortcuts"
        >
          <HelpCircle className="w-4 h-4" />
        </button>
      </div>

      {/* Tour/Annotations Toggle - Below Help */}
      <div className="absolute top-[190px] right-4 z-10">
        <button
          onClick={() => setShowHelpAnnotations(!showHelpAnnotations)}
          className={cn(
            "bg-black/70 text-white p-2 rounded-lg backdrop-blur-sm hover:bg-black/80 transition-colors",
            showHelpAnnotations && "ring-2 ring-orange-500"
          )}
          title="Toggle Help Annotations"
        >
          <Lightbulb className="w-4 h-4" />
        </button>
      </div>
      {showHelpAnnotations && (
        <div
          className="absolute top-[195px] right-[70px] z-20 text-orange-400 pointer-events-none whitespace-nowrap"
          style={{ fontFamily: "'Patrick Hand', cursive", fontSize: '16px', lineHeight: '1.2' }}
        >
          Hide annotations
        </div>
      )}

      {/* Target Preset Buttons - Bottom Left */}
      <div ref={targetPresetsRef} className="absolute bottom-4 left-4 bg-black/70 text-white p-3 rounded-lg text-xs z-10 backdrop-blur-sm">
        <div className="flex items-center justify-between mb-2">
          <div className="font-semibold">Target Presets</div>
          <button
            onClick={handleRecordClick}
            className="ml-2 p-1 rounded hover:bg-white/10 transition-colors"
            title="Add current position as preset"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
        {savedPositions.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {savedPositions.map((position, index) => (
              <Button
                key={position.name}
                variant="outline"
                size="sm"
                className="h-8 text-xs justify-start hover:bg-white/10"
                onClick={() => handleGoToPosition(position.joints, position.name)}
              >
                <span className="font-mono mr-2 text-gray-400">{index + 1}.</span>
                {position.name}
                <span className="ml-auto text-[9px] text-gray-500">Alt+{index + 1}</span>
              </Button>
            ))}
          </div>
        )}
      </div>

      <Canvas
        camera={{ position: [0.5, 0.4, 0.8], fov: 50 }}
        gl={{ toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.0 }}
        onPointerMissed={handleCanvasClick}
      >
        <Environment preset="studio" />
        <ambientLight intensity={0.3} />
        <directionalLight position={[10, 10, 5]} intensity={0.5} />
        <Suspense fallback={null}>
          <URDFRobot
            showLabels={showLabels}
            hardwareRobotColor={hardwareRobotColor}
            hardwareRobotTransparency={hardwareRobotTransparency}
            commanderRobotColor={commanderRobotColor}
            commanderRobotTransparency={commanderRobotTransparency}
            hardwareJointAngles={hardwareJointAngles}
            activeToolId={activeToolId}
            setAvailableTools={setAvailableTools}
            hardwareTool={hardwareTool}
            hardwareGripperState={hardwareGripperState}
          />

          {/* Commander TCP visualizer (orange/cyan/magenta) - shows commanded position from commander robot */}
          {/* NOTE: NO rotation applied - gets world position directly from URDF */}
          {showTargetRobot && <CommanderTCPVisualizer />}

          {/* Actual TCP visualizer (yellow/lime/purple) - shows hardware feedback from actual robot */}
          {/* NOTE: NO rotation applied - gets world position directly from URDF */}
          {showHardwareRobot && <ActualTCPVisualizer />}

          {/* Cartesian input gizmo (red/green/blue) - only in cartesian mode */}
          {/* Shows user's cartesian slider input - where they WANT to command the robot */}
          {/* NOTE: NO parent rotation - TargetPoseVisualizer handles coordinate transform internally */}
          {motionMode === 'cartesian' && <TargetPoseVisualizer />}

          {/* Path visualization between timeline keyframes */}
          <PathVisualizer visible={showPath} availableTools={availableTools} />
        </Suspense>
        <OrbitControls target={[0, 0.2, 0]} />

        {/* WebGL Context Loss Monitor - detects and logs WebGL crashes */}
        <WebGLContextMonitor />

        {/* Interactive rotating coordinate system gizmo */}
        <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
          <group rotation={[-Math.PI / 2, 0, 0]}>
            <GizmoViewport
              axisColors={['#ff0000', '#00ff00', '#0000ff']}
              labelColor="white"
            />
          </group>
        </GizmoHelper>
      </Canvas>

      {/* Disconnected Overlay */}
      {connectionStatus !== 'connected' && (
        <div className="absolute inset-0 bg-blue-900/70 flex items-center justify-center z-20 backdrop-blur-sm">
          <div className="text-white text-center">
            <div className="text-2xl font-semibold mb-2">Cannot connect to backend</div>
            <div className="text-sm text-blue-200">Waiting for API server on port 3001...</div>
          </div>
        </div>
      )}

      {/* Safety confirmation dialog */}
      <SafetyDialog />

      {/* Record Preset Dialog */}
      <Dialog open={recordDialogOpen} onOpenChange={setRecordDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record Preset Position</DialogTitle>
            <DialogDescription>
              Enter a name for this preset. Current commanded joint angles will be saved.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              placeholder="e.g., Pick Position"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleSavePreset();
                }
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRecordDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSavePreset}>
              Save Preset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Help Dialog - Keyboard Shortcuts */}
      <Dialog open={helpDialogOpen} onOpenChange={setHelpDialogOpen}>
        <DialogContent className="max-w-5xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Keyboard Shortcuts</DialogTitle>
            <DialogDescription>
              Available keyboard shortcuts for robot control
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-8 py-4">
            {/* Left Column */}
            <div className="space-y-6">
              {/* Joint Control */}
              <div>
                <h3 className="font-semibold text-sm mb-3 text-foreground">Joint Control</h3>
              <div className="space-y-2">
                <div className="flex items-center justify-between py-1">
                  <div className="flex gap-2 items-center">
                    <Kbd>1</Kbd>
                    <Kbd>2</Kbd>
                    <Kbd>3</Kbd>
                    <Kbd>4</Kbd>
                    <Kbd>5</Kbd>
                    <Kbd>6</Kbd>
                  </div>
                  <span className="text-sm text-muted-foreground ml-4">Select joints J1-J6</span>
                </div>
                <div className="flex items-center justify-between py-1">
                  <Kbd>Esc</Kbd>
                  <span className="text-sm text-muted-foreground ml-4">Deselect current joint</span>
                </div>
                <div className="flex items-center justify-between py-1">
                  <Kbd>W</Kbd>
                  <span className="text-sm text-muted-foreground ml-4">Increase selected joint angle</span>
                </div>
                <div className="flex items-center justify-between py-1">
                  <Kbd>S</Kbd>
                  <span className="text-sm text-muted-foreground ml-4">Decrease selected joint angle</span>
                </div>
                <div className="flex items-start justify-between py-1 ml-6">
                  <div className="flex gap-2 items-center">
                    <Kbd>Shift</Kbd>
                    <span className="text-xs">+</span>
                    <Kbd>W</Kbd>
                    <span className="text-xs">/</span>
                    <Kbd>S</Kbd>
                  </div>
                  <span className="text-sm text-muted-foreground ml-4">Fine control (step ÷ 10)</span>
                </div>
                <div className="flex items-start justify-between py-1 ml-6">
                  <div className="flex gap-2 items-center">
                    <Kbd>Ctrl</Kbd>
                    <span className="text-xs">+</span>
                    <Kbd>W</Kbd>
                    <span className="text-xs">/</span>
                    <Kbd>S</Kbd>
                  </div>
                  <span className="text-sm text-muted-foreground ml-4">Coarse control (step × 5)</span>
                </div>
              </div>
              </div>

              {/* Cartesian Movement */}
              <div>
                <h3 className="font-semibold text-sm mb-3 text-foreground">Cartesian Movement (Position)</h3>
              <div className="space-y-2">
                <div className="flex items-center justify-between py-1">
                  <Kbd>W</Kbd>
                  <span className="text-sm text-muted-foreground ml-4">Move +X direction</span>
                </div>
                <div className="flex items-center justify-between py-1">
                  <Kbd>S</Kbd>
                  <span className="text-sm text-muted-foreground ml-4">Move -X direction</span>
                </div>
                <div className="flex items-center justify-between py-1">
                  <Kbd>A</Kbd>
                  <span className="text-sm text-muted-foreground ml-4">Move -Y direction</span>
                </div>
                <div className="flex items-center justify-between py-1">
                  <Kbd>D</Kbd>
                  <span className="text-sm text-muted-foreground ml-4">Move +Y direction</span>
                </div>
                <div className="flex items-center justify-between py-1">
                  <Kbd>Q</Kbd>
                  <span className="text-sm text-muted-foreground ml-4">Move -Z direction</span>
                </div>
                <div className="flex items-center justify-between py-1">
                  <Kbd>E</Kbd>
                  <span className="text-sm text-muted-foreground ml-4">Move +Z direction</span>
                </div>
                <div className="flex items-start justify-between py-1 ml-6">
                  <div className="flex gap-2 items-center">
                    <Kbd>Shift</Kbd>
                    <span className="text-xs">+</span>
                    <span className="text-xs">WASDQE</span>
                  </div>
                  <span className="text-sm text-muted-foreground ml-4">Fine position control (step ÷ 10)</span>
                </div>
                <div className="flex items-start justify-between py-1 ml-6">
                  <div className="flex gap-2 items-center">
                    <Kbd>Ctrl</Kbd>
                    <span className="text-xs">+</span>
                    <span className="text-xs">WASDQE</span>
                  </div>
                  <span className="text-sm text-muted-foreground ml-4">Coarse position control (step × 5)</span>
                </div>
              </div>
              </div>
            </div>

            {/* Right Column */}
            <div className="space-y-6">
              {/* Cartesian Rotation */}
              <div>
                <h3 className="font-semibold text-sm mb-3 text-foreground">Cartesian Movement (Rotation)</h3>
              <div className="space-y-2">
                <div className="flex items-start justify-between py-1">
                  <div className="flex gap-2 items-center">
                    <Kbd>Alt</Kbd>
                    <span className="text-xs">+</span>
                    <Kbd>W</Kbd>
                    <span className="text-xs">/</span>
                    <Kbd>S</Kbd>
                  </div>
                  <span className="text-sm text-muted-foreground ml-4">Rotate around RX axis</span>
                </div>
                <div className="flex items-start justify-between py-1">
                  <div className="flex gap-2 items-center">
                    <Kbd>Alt</Kbd>
                    <span className="text-xs">+</span>
                    <Kbd>A</Kbd>
                    <span className="text-xs">/</span>
                    <Kbd>D</Kbd>
                  </div>
                  <span className="text-sm text-muted-foreground ml-4">Rotate around RY axis</span>
                </div>
                <div className="flex items-start justify-between py-1">
                  <div className="flex gap-2 items-center">
                    <Kbd>Alt</Kbd>
                    <span className="text-xs">+</span>
                    <Kbd>Q</Kbd>
                    <span className="text-xs">/</span>
                    <Kbd>E</Kbd>
                  </div>
                  <span className="text-sm text-muted-foreground ml-4">Rotate around RZ axis</span>
                </div>
              </div>
              </div>

              {/* Movement Commands */}
              <div>
                <h3 className="font-semibold text-sm mb-3 text-foreground">Movement Commands</h3>
              <div className="space-y-2">
                <div className="flex items-center justify-between py-1">
                  <Kbd>Space</Kbd>
                  <span className="text-sm text-muted-foreground ml-4">Move to target (joint space)</span>
                </div>
                <div className="flex items-start justify-between py-1">
                  <div className="flex gap-2 items-center">
                    <Kbd>Shift</Kbd>
                    <span className="text-xs">+</span>
                    <Kbd>Space</Kbd>
                  </div>
                  <span className="text-sm text-muted-foreground ml-4">Execute cartesian motion (straight line)</span>
                </div>
              </div>
              </div>

              {/* Preset Positions */}
              <div>
                <h3 className="font-semibold text-sm mb-3 text-foreground">Preset Positions</h3>
              <div className="space-y-2">
                <div className="flex items-start justify-between py-1">
                  <div className="flex gap-2 items-center">
                    <Kbd>Alt</Kbd>
                    <span className="text-xs">+</span>
                    <Kbd>1</Kbd>
                    <span className="text-xs">-</span>
                    <Kbd>9</Kbd>
                  </div>
                  <span className="text-sm text-muted-foreground ml-4">Go to preset position 1-9</span>
                </div>
              </div>
              </div>

              {/* Timeline */}
              <div>
                <h3 className="font-semibold text-sm mb-3 text-foreground">Timeline</h3>
              <div className="space-y-2">
                <div className="flex items-start justify-between py-1">
                  <div className="flex gap-2 items-center">
                    <Kbd>Delete</Kbd>
                    <span className="text-xs">/</span>
                    <Kbd>Backspace</Kbd>
                  </div>
                  <span className="text-sm text-muted-foreground ml-4">Delete selected keyframe(s)</span>
                </div>
              </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setHelpDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
