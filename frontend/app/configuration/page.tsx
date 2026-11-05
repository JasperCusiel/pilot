'use client';

import { useRef, useState, useEffect, Suspense, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Grid, GizmoHelper, GizmoViewport, Environment } from '@react-three/drei';
import Header from '../components/Header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Upload, Trash2, FileIcon, Plus } from 'lucide-react';
import URDFLoader from 'urdf-loader';
import { STLLoader, GLTFLoader } from 'three-stdlib';
import * as THREE from 'three';

// Helper to detect mesh file type
const getMeshFileType = (filename: string): 'stl' | 'gltf' | 'glb' | null => {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'stl') return 'stl';
  if (ext === 'gltf') return 'gltf';
  if (ext === 'glb') return 'glb';
  return null;
};
import { useRobotConfigStore } from '../lib/stores/robotConfigStore';
import { useConfigStore } from '../lib/configStore';
import { applyJointAnglesToUrdf } from '../lib/urdfHelpers';
import GripperTCPVisualizer from '../components/GripperTCPVisualizer';
import ToolCard from '../components/ToolCard';
import ToolDeleteDialog from '../components/ToolDeleteDialog';
import CustomRobotUploader from '../components/CustomRobotUploader';
import { getApiBaseUrl } from '../lib/apiConfig';
import { logger } from '../lib/logger';

// Tool Interface
interface Tool {
  id: string;
  name: string;
  description: string;
  mesh_file: string | null;
  mesh_units?: 'mm' | 'm'; // Units of the mesh file (default: mm)
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
}

// Static URDF Robot Component (no controls, fixed pose, no L6)
function StaticURDFRobot({
  onRobotLoad,
  color,
  transparency,
  metalness,
  roughness
}: {
  onRobotLoad: (robot: any) => void;
  color: string;
  transparency: number;
  metalness: number;
  roughness: number;
}) {
  const [localRobot, setLocalRobot] = useState<any>(null);

  useEffect(() => {
    const loader = new URDFLoader();

    loader.load(
      '/urdf/PAROL6.urdf',
      (loadedRobot: any) => {
        onRobotLoad(loadedRobot);

        setTimeout(() => {
          // Remove L6 link (gripper)
          loadedRobot.traverse((child: any) => {
            if (child.isURDFLink && child.name === 'L6') {
              if (child.parent) {
                child.parent.remove(child);
              }
            }
          });

          // Set fixed pose: J1=0, J2=-90, J3=180, J4=0, J5=0, J6=90
          const fixedAngles = { J1: 0, J2: -90, J3: 180, J4: 0, J5: 0, J6: 90 };

          // Apply joint angles using centralized helper
          applyJointAnglesToUrdf(loadedRobot, fixedAngles);
          loadedRobot.updateMatrixWorld(true);

          // Convert materials to MeshStandardMaterial for PBR support
          loadedRobot.traverse((child: any) => {
            if (child.isMesh && child.material) {
              const materials = Array.isArray(child.material) ? child.material : [child.material];
              const newMaterials: any[] = [];

              materials.forEach((mat: any) => {
                if (mat) {
                  // Convert to MeshStandardMaterial if it isn't already
                  let standardMat: any;
                  if (mat.isMeshStandardMaterial) {
                    standardMat = mat.clone();
                  } else {
                    // Create new MeshStandardMaterial with original color
                    standardMat = new THREE.MeshStandardMaterial({
                      color: mat.color || 0xffffff,
                      map: mat.map || null,
                      side: mat.side || THREE.FrontSide
                    });
                  }
                  newMaterials.push(standardMat);
                }
              });

              child.material = Array.isArray(child.material) ? newMaterials : newMaterials[0];
            }
          });

          // Set localRobot AFTER materials are ready, so the color effect can apply colors
          setLocalRobot(loadedRobot);
        }, 500);
      }
    );

    return () => {
      if (localRobot) {
        localRobot.traverse((child: any) => {
          if (child.isMesh) {
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
              const materials = Array.isArray(child.material) ? child.material : [child.material];
              materials.forEach((mat: any) => mat.dispose && mat.dispose());
            }
          }
        });
      }
    };
  }, []);

  // Re-apply color, transparency, and material properties when they change
  useEffect(() => {
    if (localRobot) {
      localRobot.traverse((child: any) => {
        if (child.isMesh && child.material) {
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          materials.forEach((mat: any) => {
            if (mat && mat.isMeshStandardMaterial) {
              // All materials are now MeshStandardMaterial, so we can set all properties
              mat.color.set(color);
              mat.transparent = transparency < 1.0;
              mat.opacity = transparency;
              mat.metalness = metalness;
              mat.roughness = roughness;
              mat.needsUpdate = true;
            }
          });
        }
      });
    }
  }, [color, transparency, metalness, roughness, localRobot]);

  return (
    <group rotation={[-Math.PI / 2, 0, 0]}>
      {localRobot && <primitive object={localRobot} />}
    </group>
  );
}

// Tool Mesh Component - Positioned at J6 joint (L6 attachment point)
// Supports both STL geometry and GLTF scenes
function ToolMeshPreview({
  stlGeometry,
  gltfScene,
  robotRef,
  offset,
  stlGeometryOpen,
  stlGeometryClosed,
  gltfSceneOpen,
  gltfSceneClosed,
  displayState,
  color,
  transparency,
  metalness,
  roughness
}: {
  stlGeometry: THREE.BufferGeometry | null;
  gltfScene: THREE.Group | null;
  robotRef: any;
  offset: { x: number; y: number; z: number; rx: number; ry: number; rz: number };
  stlGeometryOpen?: THREE.BufferGeometry | null;
  stlGeometryClosed?: THREE.BufferGeometry | null;
  gltfSceneOpen?: THREE.Group | null;
  gltfSceneClosed?: THREE.Group | null;
  displayState?: 'open' | 'closed';
  color: string;
  transparency: number;
  metalness: number;
  roughness: number;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const meshOpenRef = useRef<THREE.Mesh>(null);
  const meshClosedRef = useRef<THREE.Mesh>(null);
  const gltfRef = useRef<THREE.Group>(null);
  const gltfOpenRef = useRef<THREE.Group>(null);
  const gltfClosedRef = useRef<THREE.Group>(null);

  // Update mesh position/rotation to match J6 joint every frame
  useFrame(() => {
    if (!robotRef) return;

    const j6Joint = robotRef.joints?.['L6'];
    if (!j6Joint) return;

    j6Joint.updateMatrixWorld(true);

    // Get L6 world transform
    const l6WorldPosition = new THREE.Vector3();
    const l6WorldQuaternion = new THREE.Quaternion();
    j6Joint.getWorldPosition(l6WorldPosition);
    j6Joint.getWorldQuaternion(l6WorldQuaternion);

    // Helper function to update an object's transform (works for both Mesh and Group)
    const updateObjectTransform = (obj: THREE.Object3D | null) => {
      if (!obj) return;

      // Apply position offset in L6's local frame (rotates with J6)
      if (offset.x !== 0 || offset.y !== 0 || offset.z !== 0) {
        const localOffset = new THREE.Vector3(offset.x, offset.y, offset.z);
        const worldOffset = localOffset.applyQuaternion(l6WorldQuaternion);
        obj.position.copy(l6WorldPosition).add(worldOffset);
      } else {
        obj.position.copy(l6WorldPosition);
      }

      // Set base rotation from L6
      obj.quaternion.copy(l6WorldQuaternion);

      // Apply L6 visual origin rotation from URDF: rpy="0 0 -1.5708" (-90° Z)
      const visualOriginRotation = new THREE.Quaternion();
      visualOriginRotation.setFromEuler(new THREE.Euler(0, 0, -Math.PI / 2, 'XYZ'));
      obj.quaternion.multiply(visualOriginRotation);

      // Apply user rotation offset (degrees -> radians -> quaternion)
      if (offset.rx !== 0 || offset.ry !== 0 || offset.rz !== 0) {
        const userRotationEuler = new THREE.Euler(
          offset.rx * Math.PI / 180,
          offset.ry * Math.PI / 180,
          offset.rz * Math.PI / 180,
          'XYZ'
        );
        const userRotationQuat = new THREE.Quaternion();
        userRotationQuat.setFromEuler(userRotationEuler);
        obj.quaternion.multiply(userRotationQuat);
      }
    };

    // Update all active meshes/scenes
    updateObjectTransform(meshRef.current);
    updateObjectTransform(meshOpenRef.current);
    updateObjectTransform(meshClosedRef.current);
    updateObjectTransform(gltfRef.current);
    updateObjectTransform(gltfOpenRef.current);
    updateObjectTransform(gltfClosedRef.current);
  });

  // Determine which geometries/scenes to show
  const hasGripperGeometries = !!(stlGeometryOpen || stlGeometryClosed || gltfSceneOpen || gltfSceneClosed);
  const showMain = !hasGripperGeometries && !!(stlGeometry || gltfScene);
  const showOpen = hasGripperGeometries && displayState === 'open';
  const showClosed = hasGripperGeometries && displayState === 'closed';

  return (
    <>
      {/* Main single STL */}
      {showMain && stlGeometry && !gltfScene && (
        <mesh ref={meshRef} geometry={stlGeometry}>
          <meshStandardMaterial
            color={color}
            transparent={transparency < 1.0}
            opacity={transparency}
            metalness={metalness}
            roughness={roughness}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* Main GLTF scene (preserves per-mesh colors) */}
      {showMain && gltfScene && (
        <primitive ref={gltfRef} object={gltfScene} />
      )}

      {/* Open state STL */}
      {stlGeometryOpen && !gltfSceneOpen && (
        <mesh ref={meshOpenRef} geometry={stlGeometryOpen} visible={showOpen}>
          <meshStandardMaterial
            color={color}
            transparent={transparency < 1.0}
            opacity={transparency}
            metalness={metalness}
            roughness={roughness}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* Open state GLTF */}
      {gltfSceneOpen && (
        <primitive ref={gltfOpenRef} object={gltfSceneOpen} visible={showOpen} />
      )}

      {/* Closed state STL */}
      {stlGeometryClosed && !gltfSceneClosed && (
        <mesh ref={meshClosedRef} geometry={stlGeometryClosed} visible={showClosed}>
          <meshStandardMaterial
            color={color}
            transparent={transparency < 1.0}
            opacity={transparency}
            metalness={metalness}
            roughness={roughness}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* Closed state GLTF */}
      {gltfSceneClosed && (
        <primitive ref={gltfClosedRef} object={gltfSceneClosed} visible={showClosed} />
      )}
    </>
  );
}

export default function ConfigurationPage() {
  // Config from backend
  const { config, fetchConfig } = useConfigStore();

  // Robot appearance settings from store
  const hardwareRobotColor = useRobotConfigStore((state) => state.hardwareRobotColor);
  const hardwareRobotTransparency = useRobotConfigStore((state) => state.hardwareRobotTransparency);
  const commanderRobotColor = useRobotConfigStore((state) => state.commanderRobotColor);
  const commanderRobotTransparency = useRobotConfigStore((state) => state.commanderRobotTransparency);
  const setHardwareRobotColor = useRobotConfigStore((state) => state.setHardwareRobotColor);
  const setHardwareRobotTransparency = useRobotConfigStore((state) => state.setHardwareRobotTransparency);
  const setCommanderRobotColor = useRobotConfigStore((state) => state.setCommanderRobotColor);
  const setCommanderRobotTransparency = useRobotConfigStore((state) => state.setCommanderRobotTransparency);

  // Robot settings
  const [j2BacklashOffset, setJ2BacklashOffset] = useState<number>(6.0);

  // Tool management state
  const [tools, setTools] = useState<Tool[]>([]);
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [activeToolId, setActiveToolId] = useState<string>('default_j6_tip');
  const [isCreatingNew, setIsCreatingNew] = useState(false);

  // Editor state (current form values)
  const [editedToolName, setEditedToolName] = useState('');
  const [editedToolDescription, setEditedToolDescription] = useState('');
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [fileInfo, setFileInfo] = useState<{ name: string; size: string } | null>(null);
  const [stlGeometry, setStlGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [gltfScene, setGltfScene] = useState<THREE.Group | null>(null); // For GLB/GLTF files
  const [stlUnits, setStlUnits] = useState<'mm' | 'm'>('mm'); // Default to mm
  const [meshOffset, setMeshOffset] = useState({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 }); // Manual offset adjustment (position + rotation)
  const [tcpOffset, setTcpOffset] = useState({ x: 0, y: -45.2, z: -62.8, rx: 90, ry: 180, rz: 0 }); // TCP offset (position in mm, rotation in degrees)

  // Tool type and gripper configuration state
  type ToolType = 'static' | 'binary' | 'variable';
  const [toolType, setToolType] = useState<ToolType>('static');
  const [gripperIoPin, setGripperIoPin] = useState<1 | 2>(1);
  const [gripperOpenIsHigh, setGripperOpenIsHigh] = useState(true);
  const [stlFileOpen, setStlFileOpen] = useState<File | null>(null);
  const [stlFileClosed, setStlFileClosed] = useState<File | null>(null);
  const [stlGeometryOpen, setStlGeometryOpen] = useState<THREE.BufferGeometry | null>(null);
  const [stlGeometryClosed, setStlGeometryClosed] = useState<THREE.BufferGeometry | null>(null);
  const [gltfSceneOpen, setGltfSceneOpen] = useState<THREE.Group | null>(null); // For GLB/GLTF gripper open state
  const [gltfSceneClosed, setGltfSceneClosed] = useState<THREE.Group | null>(null); // For GLB/GLTF gripper closed state
  const [displayState, setDisplayState] = useState<'open' | 'closed'>('open');

  // UI state
  const [robot, setRobot] = useState<any>(null); // URDF robot reference
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingTools, setIsLoadingTools] = useState(false);
  const [robotView, setRobotView] = useState<'commander' | 'hardware'>('commander'); // Which robot to show in 3D view

  // Material properties (for testing, not saved to config)
  // Default values for shiny white plastic look
  const [metalness, setMetalness] = useState(0.1);
  const [roughness, setRoughness] = useState(0.25);

  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Dialog state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [toolToDelete, setToolToDelete] = useState<Tool | null>(null);

  // Fetch config from backend on mount
  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // Sync robot appearance and settings from config when config loads
  useEffect(() => {
    if (config?.ui?.hardware_robot) {
      setHardwareRobotColor(config.ui.hardware_robot.color);
      setHardwareRobotTransparency(config.ui.hardware_robot.transparency);
    }
    if (config?.ui?.commander_robot) {
      setCommanderRobotColor(config.ui.commander_robot.color);
      setCommanderRobotTransparency(config.ui.commander_robot.transparency);
    }
    if (config?.robot?.j2_backlash_offset !== undefined) {
      setJ2BacklashOffset(config.robot.j2_backlash_offset);
    }
  }, [config, setHardwareRobotColor, setHardwareRobotTransparency, setCommanderRobotColor, setCommanderRobotTransparency]);

  // API Integration Functions
  // Load tools from backend
  const loadTools = async () => {
    setIsLoadingTools(true);
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/config/tools`);
      if (!response.ok) throw new Error('Failed to load tools');
      const data = await response.json();
      setTools(data.tools || []);
      setActiveToolId(data.active_tool_id || 'default_j6_tip');
    } catch (err) {
      logger.error('Error loading tools', 'ConfigurationPage', { error: err });
      setError(err instanceof Error ? err.message : 'Failed to load tools');
    } finally {
      setIsLoadingTools(false);
    }
  };

  // Load tool into editor
  const loadToolIntoEditor = async (toolId: string) => {
    const tool = tools.find(t => t.id === toolId);
    if (tool) {
      setSelectedToolId(toolId);
      setEditedToolName(tool.name);
      setEditedToolDescription(tool.description);
      setMeshOffset(tool.mesh_offset);
      setTcpOffset(tool.tcp_offset);
      setIsCreatingNew(false);

      // Set tool type based on gripper config
      if (tool.gripper_config?.enabled) {
        setToolType('binary');
        setGripperIoPin(tool.gripper_config.io_pin);
        setGripperOpenIsHigh(tool.gripper_config.open_is_high);

        // Load open state mesh if present (STL, GLB, or GLTF)
        if (tool.gripper_config.mesh_file_open) {
          try {
            const url = `/urdf/meshes/${tool.gripper_config.mesh_file_open}`;
            const response = await fetch(url);
            if (response.ok) {
              const arrayBuffer = await response.arrayBuffer();
              const fileType = getMeshFileType(tool.gripper_config.mesh_file_open);
              const units = tool.mesh_units || 'mm';
              const scale = units === 'mm' ? 0.001 : 1.0;

              if (fileType === 'stl') {
                const loader = new STLLoader();
                const geometry = loader.parse(arrayBuffer);
                geometry.scale(scale, scale, scale);
                setStlGeometryOpen(geometry);
                setGltfSceneOpen(null);
              } else if (fileType === 'glb' || fileType === 'gltf') {
                const loader = new GLTFLoader();
                const gltf = await new Promise<any>((resolve, reject) => {
                  loader.parse(arrayBuffer, '', resolve, reject);
                });
                gltf.scene.scale.set(scale, scale, scale);
                setGltfSceneOpen(gltf.scene.clone());
                setStlGeometryOpen(null);
              }
              setStlFileOpen(new File([arrayBuffer], tool.gripper_config.mesh_file_open));
            }
          } catch (err) {
            logger.error('Error loading open state mesh', 'loadToolIntoEditor', { error: err });
          }
        }

        // Load closed state mesh if present (STL, GLB, or GLTF)
        if (tool.gripper_config.mesh_file_closed) {
          try {
            const url = `/urdf/meshes/${tool.gripper_config.mesh_file_closed}`;
            const response = await fetch(url);
            if (response.ok) {
              const arrayBuffer = await response.arrayBuffer();
              const fileType = getMeshFileType(tool.gripper_config.mesh_file_closed);
              const units = tool.mesh_units || 'mm';
              const scale = units === 'mm' ? 0.001 : 1.0;

              if (fileType === 'stl') {
                const loader = new STLLoader();
                const geometry = loader.parse(arrayBuffer);
                geometry.scale(scale, scale, scale);
                setStlGeometryClosed(geometry);
                setGltfSceneClosed(null);
              } else if (fileType === 'glb' || fileType === 'gltf') {
                const loader = new GLTFLoader();
                const gltf = await new Promise<any>((resolve, reject) => {
                  loader.parse(arrayBuffer, '', resolve, reject);
                });
                gltf.scene.scale.set(scale, scale, scale);
                setGltfSceneClosed(gltf.scene.clone());
                setStlGeometryClosed(null);
              }
              setStlFileClosed(new File([arrayBuffer], tool.gripper_config.mesh_file_closed));
            }
          } catch (err) {
            logger.error('Error loading closed state mesh', 'loadToolIntoEditor', { error: err });
          }
        }
      } else {
        // Static tool - clear gripper config
        setToolType('static');
        setStlGeometryOpen(null);
        setStlGeometryClosed(null);
        setGltfSceneOpen(null);
        setGltfSceneClosed(null);
        setStlFileOpen(null);
        setStlFileClosed(null);
      }

      // Load mesh file if tool has one (STL, GLB, or GLTF)
      if (tool.mesh_file) {
        try {
          setIsLoading(true);
          const url = `/urdf/meshes/${tool.mesh_file}`;
          const response = await fetch(url);
          if (response.ok) {
            const arrayBuffer = await response.arrayBuffer();
            const fileType = getMeshFileType(tool.mesh_file);
            const units = tool.mesh_units || 'mm';
            const scale = units === 'mm' ? 0.001 : 1.0;

            if (fileType === 'stl') {
              const loader = new STLLoader();
              const geometry = loader.parse(arrayBuffer);
              geometry.scale(scale, scale, scale);
              setStlGeometry(geometry);
              setGltfScene(null);
            } else if (fileType === 'glb' || fileType === 'gltf') {
              const loader = new GLTFLoader();
              const gltf = await new Promise<any>((resolve, reject) => {
                loader.parse(arrayBuffer, '', resolve, reject);
              });
              gltf.scene.scale.set(scale, scale, scale);
              setGltfScene(gltf.scene.clone());
              setStlGeometry(null);
            }

            setFileInfo({
              name: tool.mesh_file,
              size: `${(arrayBuffer.byteLength / 1024).toFixed(2)} KB`
            });
            setStlUnits(units);
          } else {
            logger.error(`Fetch failed with status: ${response.status}`, 'loadToolIntoEditor', { toolId, meshFile: tool.mesh_file });
            setError(`Failed to load mesh: ${tool.mesh_file} (HTTP ${response.status})`);
          }
        } catch (err) {
          logger.error('Error loading tool mesh', 'loadToolIntoEditor', { error: err, toolId, meshFile: tool.mesh_file });
          setError(`Failed to load mesh: ${tool.mesh_file}`);
        } finally {
          setIsLoading(false);
        }
      } else {
        // No mesh file - clear geometry
        setUploadedFile(null);
        setFileInfo(null);
        setStlGeometry(null);
        setGltfScene(null);
      }
    }
  };

  // Create new tool
  const handleCreateNew = () => {
    setSelectedToolId(null);
    setIsCreatingNew(true);
    setEditedToolName('');
    setEditedToolDescription('');
    setMeshOffset({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 });
    setTcpOffset({ x: 0, y: 0, z: -62.8, rx: 0, ry: 0, rz: 0 });
    setUploadedFile(null);
    setFileInfo(null);
    setStlGeometry(null);
    setGltfScene(null);

    // Reset to static tool type and clear gripper state
    setToolType('static');
    setGripperIoPin(1);
    setGripperOpenIsHigh(true);
    setStlFileOpen(null);
    setStlFileClosed(null);
    setStlGeometryOpen(null);
    setStlGeometryClosed(null);
    setGltfSceneOpen(null);
    setGltfSceneClosed(null);
    setDisplayState('open');
  };

  // Save tool (create or update)
  const handleSaveTool = async () => {
    if (!editedToolName.trim()) {
      setSaveError('Tool name is required');
      return;
    }

    setIsSaving(true);
    setSaveSuccess(false);
    setSaveError(null);

    try {
      // Convert main STL to base64 if present
      let base64Data = null;
      if (uploadedFile) {
        const arrayBuffer = await uploadedFile.arrayBuffer();
        base64Data = btoa(
          new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
        );
      }

      // Convert open state STL to base64 if present
      let base64DataOpen = null;
      if (stlFileOpen) {
        const arrayBuffer = await stlFileOpen.arrayBuffer();
        base64DataOpen = btoa(
          new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
        );
      }

      // Convert closed state STL to base64 if present
      let base64DataClosed = null;
      if (stlFileClosed) {
        const arrayBuffer = await stlFileClosed.arrayBuffer();
        base64DataClosed = btoa(
          new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
        );
      }

      const payload: any = {
        name: editedToolName,
        description: editedToolDescription,
        mesh_file: uploadedFile ? uploadedFile.name : null,
        mesh_units: stlUnits, // 'mm' or 'm'
        mesh_offset_position: { x: meshOffset.x, y: meshOffset.y, z: meshOffset.z },
        mesh_offset_rotation: { rx: meshOffset.rx, ry: meshOffset.ry, rz: meshOffset.rz },
        tcp_offset_position: { x: tcpOffset.x, y: tcpOffset.y, z: tcpOffset.z },
        tcp_offset_rotation: { rx: tcpOffset.rx, ry: tcpOffset.ry, rz: tcpOffset.rz },
        stl_data: base64Data,
      };

      // Add gripper config if binary tool type
      if (toolType === 'binary') {
        payload.gripper_config = {
          enabled: true,
          io_pin: gripperIoPin,
          open_is_high: gripperOpenIsHigh,
          mesh_file_open: stlFileOpen ? stlFileOpen.name : null,
          mesh_file_closed: stlFileClosed ? stlFileClosed.name : null,
        };
        payload.stl_data_open = base64DataOpen;
        payload.stl_data_closed = base64DataClosed;
      } else {
        payload.gripper_config = null;
      }

      let response;
      if (isCreatingNew) {
        // Create new tool
        response = await fetch(`${getApiBaseUrl()}/api/config/tools`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } else {
        // Update existing tool
        response = await fetch(`${getApiBaseUrl()}/api/config/tools/${selectedToolId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to save tool');
      }

      setSaveSuccess(true);
      await loadTools(); // Refresh tools list
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      logger.error('Error saving tool', 'saveTool', { error: err });
      setSaveError(err instanceof Error ? err.message : 'Failed to save tool');
    } finally {
      setIsSaving(false);
    }
  };

  // Delete tool
  const handleDeleteTool = (tool: Tool) => {
    setToolToDelete(tool);
    setDeleteDialogOpen(true);
  };

  const confirmDeleteTool = async () => {
    if (!toolToDelete) return;

    try {
      const response = await fetch(`${getApiBaseUrl()}/api/config/tools/${toolToDelete.id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to delete tool');
      }

      await loadTools(); // Refresh tools list

      // Clear editor if deleted tool was selected
      if (selectedToolId === toolToDelete.id) {
        setSelectedToolId(null);
        setIsCreatingNew(false);
      }
    } catch (err) {
      logger.error('Error deleting tool', 'confirmDeleteTool', { error: err });
      setError(err instanceof Error ? err.message : 'Failed to delete tool');
    } finally {
      setDeleteDialogOpen(false);
      setToolToDelete(null);
    }
  };


  // Compute unsaved changes
  const hasUnsavedChanges = useMemo(() => {
    if (isCreatingNew) {
      return editedToolName.trim().length > 0 || editedToolDescription.trim().length > 0 || uploadedFile !== null;
    }

    if (!selectedToolId) return false;

    const savedTool = tools.find(t => t.id === selectedToolId);
    if (!savedTool) return false;

    return (
      editedToolName !== savedTool.name ||
      editedToolDescription !== savedTool.description ||
      JSON.stringify(meshOffset) !== JSON.stringify(savedTool.mesh_offset) ||
      JSON.stringify(tcpOffset) !== JSON.stringify(savedTool.tcp_offset)
    );
  }, [isCreatingNew, selectedToolId, tools, editedToolName, editedToolDescription, meshOffset, tcpOffset, uploadedFile]);

  // Load tools on mount
  useEffect(() => {
    loadTools();
  }, []);

  // Preselect the active (mounted) tool when tools load
  useEffect(() => {
    if (tools.length > 0 && activeToolId && !selectedToolId && !isCreatingNew) {
      loadToolIntoEditor(activeToolId);
    }
  }, [tools, activeToolId]);

  // Warn before leaving with unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges]);

  // Load mesh file (STL, GLB, or GLTF)
  const loadMesh = async (file: File) => {
    setIsLoading(true);
    setError(null);

    try {
      // Validate file type
      const fileType = getMeshFileType(file.name);
      if (!fileType) {
        throw new Error('Please upload a valid mesh file (.stl, .glb, or .gltf)');
      }

      // Read file as ArrayBuffer
      const arrayBuffer = await file.arrayBuffer();
      const scale = stlUnits === 'mm' ? 0.001 : 1.0; // mm->m or keep as-is

      if (fileType === 'stl') {
        // Load STL
        const loader = new STLLoader();
        const geometry = loader.parse(arrayBuffer);

        // Scale based on selected units
        geometry.scale(scale, scale, scale);

        setStlGeometry(geometry);
        setGltfScene(null); // Clear GLTF scene
      } else {
        // Load GLB/GLTF
        const loader = new GLTFLoader();
        const gltf = await new Promise<any>((resolve, reject) => {
          loader.parse(arrayBuffer, '', resolve, reject);
        });

        // Apply scaling to entire scene
        gltf.scene.scale.set(scale, scale, scale);

        setGltfScene(gltf.scene.clone());
        setStlGeometry(null); // Clear STL geometry
      }

      // Update file info
      const sizeKB = (file.size / 1024).toFixed(2);
      setFileInfo({
        name: file.name,
        size: sizeKB + ' KB',
      });

      setUploadedFile(file);
      setIsLoading(false);
    } catch (err) {
      logger.error('Error loading mesh', 'loadMesh', { error: err });
      setError(err instanceof Error ? err.message : 'Failed to load mesh file');
      setIsLoading(false);
    }
  };

  // Handle file input change
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      loadMesh(file);
    }
  };

  // Handle drag and drop
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const file = e.dataTransfer.files?.[0];
    if (file) {
      loadMesh(file);
    }
  };

  // Clear uploaded mesh
  const handleClear = () => {
    if (stlGeometry) {
      stlGeometry.dispose();
    }
    setStlGeometry(null);
    setUploadedFile(null);
    setFileInfo(null);
    setError(null);
  };

  // Load open state mesh for gripper (STL, GLB, or GLTF)
  const loadMeshOpen = async (file: File) => {
    setIsLoading(true);
    setError(null);

    try {
      const fileType = getMeshFileType(file.name);
      if (!fileType) {
        throw new Error('Please upload a valid mesh file (.stl, .glb, or .gltf)');
      }

      const arrayBuffer = await file.arrayBuffer();
      const scale = stlUnits === 'mm' ? 0.001 : 1.0;

      if (fileType === 'stl') {
        const loader = new STLLoader();
        const geometry = loader.parse(arrayBuffer);
        geometry.scale(scale, scale, scale);
        setStlGeometryOpen(geometry);
        setGltfSceneOpen(null);
      } else {
        const loader = new GLTFLoader();
        const gltf = await new Promise<any>((resolve, reject) => {
          loader.parse(arrayBuffer, '', resolve, reject);
        });
        gltf.scene.scale.set(scale, scale, scale);
        setGltfSceneOpen(gltf.scene.clone());
        setStlGeometryOpen(null);
      }

      setStlFileOpen(file);
      setIsLoading(false);
    } catch (err) {
      logger.error('Error loading open mesh', 'loadMeshOpen', { error: err });
      setError(err instanceof Error ? err.message : 'Failed to load mesh file');
      setIsLoading(false);
    }
  };

  // Load closed state mesh for gripper (STL, GLB, or GLTF)
  const loadMeshClosed = async (file: File) => {
    setIsLoading(true);
    setError(null);

    try {
      const fileType = getMeshFileType(file.name);
      if (!fileType) {
        throw new Error('Please upload a valid mesh file (.stl, .glb, or .gltf)');
      }

      const arrayBuffer = await file.arrayBuffer();
      const scale = stlUnits === 'mm' ? 0.001 : 1.0;

      if (fileType === 'stl') {
        const loader = new STLLoader();
        const geometry = loader.parse(arrayBuffer);
        geometry.scale(scale, scale, scale);
        setStlGeometryClosed(geometry);
        setGltfSceneClosed(null);
      } else {
        const loader = new GLTFLoader();
        const gltf = await new Promise<any>((resolve, reject) => {
          loader.parse(arrayBuffer, '', resolve, reject);
        });
        gltf.scene.scale.set(scale, scale, scale);
        setGltfSceneClosed(gltf.scene.clone());
        setStlGeometryClosed(null);
      }

      setStlFileClosed(file);
      setIsLoading(false);
    } catch (err) {
      logger.error('Error loading closed mesh', 'loadMeshClosed', { error: err });
      setError(err instanceof Error ? err.message : 'Failed to load mesh file');
      setIsLoading(false);
    }
  };

  // Handle file input change for open state
  const handleFileChangeOpen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      loadMeshOpen(file);
    }
  };

  // Handle file input change for closed state
  const handleFileChangeClosed = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      loadMeshClosed(file);
    }
  };

  // Clear open state STL
  const handleClearOpen = () => {
    if (stlGeometryOpen) {
      stlGeometryOpen.dispose();
    }
    setStlGeometryOpen(null);
    setStlFileOpen(null);
  };

  // Clear closed state STL
  const handleClearClosed = () => {
    if (stlGeometryClosed) {
      stlGeometryClosed.dispose();
    }
    setStlGeometryClosed(null);
    setStlFileClosed(null);
  };

  // Save configuration to URDF
  const handleSaveToURDF = async () => {
    if (!uploadedFile) {
      setSaveError('No mesh file uploaded');
      return;
    }

    setIsSaving(true);
    setSaveSuccess(false);
    setSaveError(null);

    try {
      // Read file as base64
      const arrayBuffer = await uploadedFile.arrayBuffer();
      const base64Data = btoa(
        new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
      );

      // Call API endpoint
      const response = await fetch(`${getApiBaseUrl()}/api/urdf/update-gripper`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mesh_filename: uploadedFile.name,
          mesh_offset_position: {
            x: meshOffset.x,
            y: meshOffset.y,
            z: meshOffset.z,
          },
          mesh_offset_rotation: {
            rx: meshOffset.rx,
            ry: meshOffset.ry,
            rz: meshOffset.rz,
          },
          tcp_offset_position: {
            x: tcpOffset.x,
            y: tcpOffset.y,
            z: tcpOffset.z,
          },
          tcp_offset_rotation: {
            rx: tcpOffset.rx,
            ry: tcpOffset.ry,
            rz: tcpOffset.rz,
          },
          stl_data: base64Data,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to save configuration');
      }

      const result = await response.json();

      setSaveSuccess(true);
      setIsSaving(false);

      // Clear success message after 3 seconds
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      logger.error('Error saving to URDF', 'saveToURDF', { error: err });
      setSaveError(err instanceof Error ? err.message : 'Failed to save configuration');
      setIsSaving(false);
    }
  };

  // Re-scale STL when units change
  useEffect(() => {
    if (stlGeometry && uploadedFile) {
      loadMesh(uploadedFile);
    }
  }, [stlUnits]);

  return (
    <main className="h-screen flex flex-col bg-background">
      <Header />

      <div className="flex-1 p-4 grid grid-cols-[400px_1fr] gap-4 overflow-hidden">
        {/* Left Panel - Tool List + Editor */}
        <div className="overflow-auto">
          <Tabs defaultValue="tools" className="w-full">
            <TabsList className="w-full mb-3">
              <TabsTrigger value="tools" className="flex-1">Tools</TabsTrigger>
              <TabsTrigger value="robot" className="flex-1">Robot</TabsTrigger>
              <TabsTrigger value="robot-model" className="flex-1">Robot Model</TabsTrigger>
              <TabsTrigger value="environment" className="flex-1" disabled>Environment</TabsTrigger>
            </TabsList>

            <TabsContent value="tools" className="space-y-3 mt-0">
              {/* Tool Selector */}
              <Card className="p-3">
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <label className="text-xs font-medium mb-1 block">Select Tool</label>
                <Select
                  value={selectedToolId || ''}
                  onValueChange={(value) => {
                    if (value) {
                      loadToolIntoEditor(value);
                    }
                  }}
                >
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue placeholder={isLoadingTools ? "Loading..." : "Select a tool..."} />
                  </SelectTrigger>
                  <SelectContent>
                    {tools.map((tool) => (
                      <SelectItem key={tool.id} value={tool.id}>
                        {tool.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button size="sm" onClick={handleCreateNew} className="h-8 mt-5">
                <Plus className="w-3.5 h-3.5 mr-1" />
                New
              </Button>
            </div>
          </Card>

          {/* Tool Editor */}
          {(selectedToolId || isCreatingNew) && (
            <Card className="p-3">
              <h2 className="text-base font-semibold mb-2">
                {isCreatingNew ? 'New Tool' : editedToolName || 'Edit Tool'}
              </h2>

              {/* Tool Metadata */}
              <div className="space-y-2 mb-3">
                <div>
                  <label className="text-xs font-medium mb-1 block">Name</label>
                  <input
                    type="text"
                    value={editedToolName}
                    onChange={(e) => setEditedToolName(e.target.value)}
                    placeholder="Tool name"
                    className="w-full h-8 px-2 text-sm bg-background border rounded"
                  />
                </div>

                <div>
                  <label className="text-xs font-medium mb-1 block">Description (optional)</label>
                  <input
                    type="text"
                    value={editedToolDescription}
                    onChange={(e) => setEditedToolDescription(e.target.value)}
                    placeholder="Brief description"
                    className="w-full h-8 px-2 text-sm bg-background border rounded"
                  />
                </div>

                {/* Tool Type Selector */}
                <div>
                  <label className="text-xs font-medium mb-1.5 block">Tool Type</label>
                  <div className="flex gap-1">
                    <Button
                      variant={toolType === 'static' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setToolType('static')}
                      className="flex-1 h-7 text-xs"
                    >
                      Static
                    </Button>
                    <Button
                      variant={toolType === 'binary' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setToolType('binary')}
                      className="flex-1 h-7 text-xs"
                    >
                      Binary
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled
                      className="flex-1 h-7 text-xs opacity-50"
                    >
                      Variable <span className="text-[9px] ml-0.5">(Soon)</span>
                    </Button>
                  </div>
                </div>
              </div>

            {/* Upload Area - Always visible when creating/editing */}
            {/* Conditional STL Upload: Single or Dual based on tool type */}
            {toolType === 'static' && (selectedToolId || isCreatingNew) && (
              <div
                className={`
                  border-2 border-dashed rounded-lg p-4 text-center cursor-pointer
                  transition-colors
                  ${isDragging ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}
                `}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => document.getElementById('file-input')?.click()}
              >
                <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
                <p className="text-xs font-medium mb-0.5">
                  {isDragging ? 'Drop mesh file here' : 'Upload Mesh'}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  Click or drag & drop
                </p>
                <input
                  id="file-input"
                  type="file"
                  accept=".stl,.glb,.gltf"
                  className="hidden"
                  onChange={handleFileChange}
                />
              </div>
            )}

            {/* Dual STL Upload for Binary tool type */}
            {toolType === 'binary' && (selectedToolId || isCreatingNew) && (
              <div className="space-y-2">
                <label className="text-xs font-medium block">Gripper State Meshes</label>
                <div className="grid grid-cols-2 gap-2">
                  {/* Open State Upload */}
                  <div>
                    <label className="text-[10px] text-muted-foreground block mb-1">Open State</label>
                    {!stlFileOpen ? (
                      <div
                        className="border-2 border-dashed rounded p-2 text-center cursor-pointer transition-colors border-border hover:border-primary/50"
                        onClick={() => document.getElementById('file-input-open')?.click()}
                      >
                        <Upload className="w-5 h-5 mx-auto mb-1 text-muted-foreground" />
                        <p className="text-[9px] text-muted-foreground">Upload Mesh</p>
                        <input
                          id="file-input-open"
                          type="file"
                          accept=".stl,.glb,.gltf"
                          className="hidden"
                          onChange={handleFileChangeOpen}
                        />
                      </div>
                    ) : (
                      <div className="p-2 bg-card border rounded flex items-center justify-between gap-1">
                        <FileIcon className="w-3 h-3 text-primary shrink-0" />
                        <p className="text-[9px] font-medium truncate flex-1">{stlFileOpen.name}</p>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={handleClearOpen}
                          className="h-5 w-5 shrink-0"
                        >
                          <Trash2 className="w-2.5 h-2.5" />
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* Closed State Upload */}
                  <div>
                    <label className="text-[10px] text-muted-foreground block mb-1">Closed State</label>
                    {!stlFileClosed ? (
                      <div
                        className="border-2 border-dashed rounded p-2 text-center cursor-pointer transition-colors border-border hover:border-primary/50"
                        onClick={() => document.getElementById('file-input-closed')?.click()}
                      >
                        <Upload className="w-5 h-5 mx-auto mb-1 text-muted-foreground" />
                        <p className="text-[9px] text-muted-foreground">Upload Mesh</p>
                        <input
                          id="file-input-closed"
                          type="file"
                          accept=".stl,.glb,.gltf"
                          className="hidden"
                          onChange={handleFileChangeClosed}
                        />
                      </div>
                    ) : (
                      <div className="p-2 bg-card border rounded flex items-center justify-between gap-1">
                        <FileIcon className="w-3 h-3 text-primary shrink-0" />
                        <p className="text-[9px] font-medium truncate flex-1">{stlFileClosed.name}</p>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={handleClearClosed}
                          className="h-5 w-5 shrink-0"
                        >
                          <Trash2 className="w-2.5 h-2.5" />
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Unit Selector - shown when any STL is uploaded or when creating/editing */}
            {(uploadedFile || stlFileOpen || stlFileClosed || selectedToolId || isCreatingNew) && (
              <div className="mt-2 p-2 bg-card border rounded">
                <label className="text-xs font-medium mb-1.5 block">Mesh Units</label>
                <div className="flex gap-1">
                  <Button
                    variant={stlUnits === 'mm' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setStlUnits('mm')}
                    className="flex-1 h-7 text-xs"
                  >
                    mm
                  </Button>
                  <Button
                    variant={stlUnits === 'm' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setStlUnits('m')}
                    className="flex-1 h-7 text-xs"
                  >
                    m
                  </Button>
                </div>
              </div>
            )}

            {/* Loading State */}
            {isLoading && (
              <div className="mt-2 p-2 bg-blue-500/10 border border-blue-500/20 rounded text-xs text-blue-400">
                Loading...
              </div>
            )}

            {/* Error State */}
            {error && (
              <div className="mt-2 p-2 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-400">
                {error}
              </div>
            )}

            {/* File Info - Only for Static tools */}
            {toolType === 'static' && fileInfo && !error && (
              <div className="mt-2 p-2 bg-card border rounded flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <FileIcon className="w-4 h-4 text-primary shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate">{fileInfo.name}</p>
                    <p className="text-[10px] text-muted-foreground">{fileInfo.size}</p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleClear}
                  className="h-7 w-7 shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            )}

            {/* Mesh Offset Adjustment */}
            {(selectedToolId || isCreatingNew) && (
              <div className="mt-2 p-2 bg-card border rounded">
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium">Mesh Offset</label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setMeshOffset({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 })}
                    className="h-6 px-2 text-[10px]"
                  >
                    Reset
                  </Button>
                </div>

                <div className="grid grid-cols-6 gap-1">
                  <div>
                    <label className="text-[9px] text-muted-foreground block text-center mb-0.5">X (m)</label>
                    <input
                      type="number"
                      step="0.001"
                      value={meshOffset.x}
                      onChange={(e) => setMeshOffset({ ...meshOffset, x: parseFloat(e.target.value) || 0 })}
                      className="h-7 px-1 text-xs bg-background border rounded text-center w-full"
                    />
                  </div>
                  <div>
                    <label className="text-[9px] text-muted-foreground block text-center mb-0.5">Y (m)</label>
                    <input
                      type="number"
                      step="0.001"
                      value={meshOffset.y}
                      onChange={(e) => setMeshOffset({ ...meshOffset, y: parseFloat(e.target.value) || 0 })}
                      className="h-7 px-1 text-xs bg-background border rounded text-center w-full"
                    />
                  </div>
                  <div>
                    <label className="text-[9px] text-muted-foreground block text-center mb-0.5">Z (m)</label>
                    <input
                      type="number"
                      step="0.001"
                      value={meshOffset.z}
                      onChange={(e) => setMeshOffset({ ...meshOffset, z: parseFloat(e.target.value) || 0 })}
                      className="h-7 px-1 text-xs bg-background border rounded text-center w-full"
                    />
                  </div>
                  <div>
                    <label className="text-[9px] text-muted-foreground block text-center mb-0.5">RX (°)</label>
                    <input
                      type="number"
                      step="1"
                      value={meshOffset.rx}
                      onChange={(e) => setMeshOffset({ ...meshOffset, rx: parseFloat(e.target.value) || 0 })}
                      className="h-7 px-1 text-xs bg-background border rounded text-center w-full"
                    />
                  </div>
                  <div>
                    <label className="text-[9px] text-muted-foreground block text-center mb-0.5">RY (°)</label>
                    <input
                      type="number"
                      step="1"
                      value={meshOffset.ry}
                      onChange={(e) => setMeshOffset({ ...meshOffset, ry: parseFloat(e.target.value) || 0 })}
                      className="h-7 px-1 text-xs bg-background border rounded text-center w-full"
                    />
                  </div>
                  <div>
                    <label className="text-[9px] text-muted-foreground block text-center mb-0.5">RZ (°)</label>
                    <input
                      type="number"
                      step="1"
                      value={meshOffset.rz}
                      onChange={(e) => setMeshOffset({ ...meshOffset, rz: parseFloat(e.target.value) || 0 })}
                      className="h-7 px-1 text-xs bg-background border rounded text-center w-full"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* TCP Offset Configuration */}
            {(selectedToolId || isCreatingNew) && (
              <div className="mt-2 p-2 bg-card border rounded">
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium">TCP Offset</label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setTcpOffset({ x: 0, y: -45.2, z: -62.8, rx: 90, ry: 180, rz: 0 })}
                    className="h-6 px-2 text-[10px]"
                  >
                    Reset
                  </Button>
                </div>

                <div className="grid grid-cols-6 gap-1">
                  <div>
                    <label className="text-[9px] text-muted-foreground block text-center mb-0.5">X (mm)</label>
                    <input
                      type="number"
                      step="0.1"
                      value={tcpOffset.x}
                      onChange={(e) => setTcpOffset({ ...tcpOffset, x: parseFloat(e.target.value) || 0 })}
                      className="h-7 px-1 text-xs bg-background border rounded text-center w-full"
                    />
                  </div>
                  <div>
                    <label className="text-[9px] text-muted-foreground block text-center mb-0.5">Y (mm)</label>
                    <input
                      type="number"
                      step="0.1"
                      value={tcpOffset.y}
                      onChange={(e) => setTcpOffset({ ...tcpOffset, y: parseFloat(e.target.value) || 0 })}
                      className="h-7 px-1 text-xs bg-background border rounded text-center w-full"
                    />
                  </div>
                  <div>
                    <label className="text-[9px] text-muted-foreground block text-center mb-0.5">Z (mm)</label>
                    <input
                      type="number"
                      step="0.1"
                      value={tcpOffset.z}
                      onChange={(e) => setTcpOffset({ ...tcpOffset, z: parseFloat(e.target.value) || 0 })}
                      className="h-7 px-1 text-xs bg-background border rounded text-center w-full"
                    />
                  </div>
                  <div>
                    <label className="text-[9px] text-muted-foreground block text-center mb-0.5">RX (°)</label>
                    <input
                      type="number"
                      step="1"
                      value={tcpOffset.rx}
                      onChange={(e) => setTcpOffset({ ...tcpOffset, rx: parseFloat(e.target.value) || 0 })}
                      className="h-7 px-1 text-xs bg-background border rounded text-center w-full"
                    />
                  </div>
                  <div>
                    <label className="text-[9px] text-muted-foreground block text-center mb-0.5">RY (°)</label>
                    <input
                      type="number"
                      step="1"
                      value={tcpOffset.ry}
                      onChange={(e) => setTcpOffset({ ...tcpOffset, ry: parseFloat(e.target.value) || 0 })}
                      className="h-7 px-1 text-xs bg-background border rounded text-center w-full"
                    />
                  </div>
                  <div>
                    <label className="text-[9px] text-muted-foreground block text-center mb-0.5">RZ (°)</label>
                    <input
                      type="number"
                      step="1"
                      value={tcpOffset.rz}
                      onChange={(e) => setTcpOffset({ ...tcpOffset, rz: parseFloat(e.target.value) || 0 })}
                      className="h-7 px-1 text-xs bg-background border rounded text-center w-full"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Gripper I/O Configuration - Only shown for Binary tool type */}
            {toolType === 'binary' && (selectedToolId || isCreatingNew) && (
              <div className="mt-2 p-2 bg-card border rounded">
                <label className="text-xs font-medium mb-1.5 block">Gripper I/O</label>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[9px] text-muted-foreground mb-0.5 block text-center">I/O Pin</label>
                    <Select value={gripperIoPin.toString()} onValueChange={(val) => setGripperIoPin(parseInt(val) as 1 | 2)}>
                      <SelectTrigger className="h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">Output 1</SelectItem>
                        <SelectItem value="2">Output 2</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="text-[9px] text-muted-foreground mb-0.5 block text-center">Open State</label>
                    <div className="h-7 flex items-center justify-center gap-1.5 bg-background border rounded px-2">
                      <span className="text-[10px]">{gripperOpenIsHigh ? 'HIGH' : 'LOW'}</span>
                      <Switch
                        checked={gripperOpenIsHigh}
                        onCheckedChange={setGripperOpenIsHigh}
                        className="scale-75"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

              {/* Tool Action Buttons */}
              <div className="mt-3 space-y-1.5">
                {/* Success/Error Messages */}
                {saveSuccess && (
                  <div className="p-2 bg-green-500/10 border border-green-500/20 rounded text-xs text-green-400">
                    Saved!
                  </div>
                )}
                {saveError && (
                  <div className="p-2 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-400">
                    {saveError}
                  </div>
                )}

                {/* Save Button */}
                <Button
                  onClick={handleSaveTool}
                  disabled={isSaving || !editedToolName.trim()}
                  className="w-full h-8"
                  size="sm"
                >
                  {hasUnsavedChanges && <span className="mr-1">●</span>}
                  {isSaving ? 'Saving...' : isCreatingNew ? 'Create' : 'Save'}
                </Button>

                {/* Delete Button (only for existing tools, not when creating new) */}
                {selectedToolId && !isCreatingNew && (
                  <Button
                    variant="destructive"
                    onClick={() => handleDeleteTool(tools.find(t => t.id === selectedToolId)!)}
                    disabled={selectedToolId === activeToolId}
                    className="w-full h-8"
                    size="sm"
                  >
                    Delete Tool
                  </Button>
                )}
              </div>
            </Card>
          )}
            </TabsContent>

            <TabsContent value="robot" className="space-y-3 mt-0">
              {/* Robot Settings */}
              <Card className="p-3">
                <h2 className="text-base font-semibold mb-2">Robot Settings</h2>
                <div className="space-y-3">
                  {/* Default Speed */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[10px] text-muted-foreground">Default Speed</label>
                      <span className="text-[10px] text-muted-foreground">{config?.ui?.default_speed_percentage ?? 50}%</span>
                    </div>
                    <input
                      type="range"
                      min="1"
                      max="100"
                      step="1"
                      value={config?.ui?.default_speed_percentage ?? 50}
                      onChange={(e) => {
                        const { saveConfig } = useConfigStore.getState();
                        saveConfig({
                          ui: {
                            ...config?.ui,
                            default_speed_percentage: parseInt(e.target.value)
                          }
                        });
                      }}
                      className="w-full"
                    />
                  </div>

                  {/* Default Acceleration */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[10px] text-muted-foreground">Default Accel</label>
                      <span className="text-[10px] text-muted-foreground">{config?.ui?.default_acceleration_percentage ?? 90}%</span>
                    </div>
                    <input
                      type="range"
                      min="1"
                      max="100"
                      step="1"
                      value={config?.ui?.default_acceleration_percentage ?? 90}
                      onChange={(e) => {
                        const { saveConfig } = useConfigStore.getState();
                        saveConfig({
                          ui: {
                            ...config?.ui,
                            default_acceleration_percentage: parseInt(e.target.value)
                          }
                        });
                      }}
                      className="w-full"
                    />
                  </div>

                  {/* J2 Backlash Offset */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[10px] text-muted-foreground">J2 Backlash Offset</label>
                      <span className="text-[10px] text-muted-foreground">{j2BacklashOffset.toFixed(1)}°</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="10"
                      step="0.1"
                      value={j2BacklashOffset}
                      onChange={(e) => setJ2BacklashOffset(parseFloat(e.target.value))}
                      className="w-full"
                    />
                    <p className="text-[9px] text-muted-foreground mt-1">
                      Offset applied from -3° to -90°, tapering to 0 between -90° and -100°. Requires API restart.
                    </p>
                  </div>
                </div>
              </Card>

              {/* Robot Appearance */}
              <Card className="p-3">
            <h2 className="text-base font-semibold mb-2">Robot Appearance</h2>

            <div className="space-y-2">
              {/* Commander Robot */}
              <div>
                <label className="text-[10px] text-muted-foreground block mb-1">Commander Robot</label>
                <div className="grid grid-cols-2 gap-1.5">
                  <input
                    type="color"
                    value={commanderRobotColor}
                    onChange={(e) => setCommanderRobotColor(e.target.value)}
                    className="w-full h-7 cursor-pointer rounded border"
                  />
                  <div className="flex items-center gap-1">
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={commanderRobotTransparency}
                      onChange={(e) => setCommanderRobotTransparency(parseFloat(e.target.value))}
                      className="flex-1"
                    />
                    <span className="text-[9px] text-muted-foreground w-8">
                      {(commanderRobotTransparency * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>
              </div>

              {/* Hardware Robot */}
              <div>
                <label className="text-[10px] text-muted-foreground block mb-1">Hardware Robot</label>
                <div className="grid grid-cols-2 gap-1.5">
                  <input
                    type="color"
                    value={hardwareRobotColor}
                    onChange={(e) => setHardwareRobotColor(e.target.value)}
                    className="w-full h-7 cursor-pointer rounded border"
                  />
                  <div className="flex items-center gap-1">
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={hardwareRobotTransparency}
                      onChange={(e) => setHardwareRobotTransparency(parseFloat(e.target.value))}
                      className="flex-1"
                    />
                    <span className="text-[9px] text-muted-foreground w-8">
                      {(hardwareRobotTransparency * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>
              </div>

              {/* Material Properties */}
              <div className="pt-2 mt-2 border-t border-border">
                <label className="text-[10px] text-muted-foreground block mb-2">Material Properties</label>

                {/* Metalness */}
                <div className="mb-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[9px] text-muted-foreground">Metalness</span>
                    <span className="text-[9px] text-muted-foreground">{metalness.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={metalness}
                    onChange={(e) => setMetalness(parseFloat(e.target.value))}
                    className="w-full"
                  />
                </div>

                {/* Roughness */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[9px] text-muted-foreground">Roughness</span>
                    <span className="text-[9px] text-muted-foreground">{roughness.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={roughness}
                    onChange={(e) => setRoughness(parseFloat(e.target.value))}
                    className="w-full"
                  />
                </div>
              </div>
            </div>

            {/* Save Button */}
            <Button
              onClick={async () => {
                try {
                  const { saveConfig } = useConfigStore.getState();
                  await saveConfig({
                    robot: {
                      ...config?.robot,
                      j2_backlash_offset: j2BacklashOffset
                    },
                    ui: {
                      ...config?.ui,
                      hardware_robot: {
                        color: hardwareRobotColor,
                        transparency: hardwareRobotTransparency
                      },
                      commander_robot: {
                        color: commanderRobotColor,
                        transparency: commanderRobotTransparency
                      }
                    }
                  });
                } catch (err) {
                  logger.error('Error saving robot settings', 'ConfigurationPage', { error: err });
                }
              }}
              className="w-full h-8 mt-2"
              size="sm"
            >
              Save
            </Button>
          </Card>
            </TabsContent>

            <TabsContent value="robot-model" className="space-y-3 mt-0">
              <CustomRobotUploader />
            </TabsContent>
          </Tabs>
        </div>

        {/* Right Panel - 3D Preview (React Three Fiber Canvas) */}
        <div className="w-full h-full bg-neutral-100 rounded-lg overflow-hidden border relative">
          <div className="absolute top-4 left-4 z-10 bg-black/70 px-3 py-1.5 rounded-lg backdrop-blur-sm">
            <h3 className="text-sm font-semibold">Tool Preview</h3>
          </div>

          <Canvas
              camera={{ position: [0.5, 0.4, 0.8], fov: 50 }}
              gl={{ toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.0 }}
            >
              <Environment preset="studio" />
              <ambientLight intensity={0.3} />
              <directionalLight position={[10, 10, 5]} intensity={0.5} />

            <Suspense fallback={null}>
              {/* Static URDF Robot - color based on view selection */}
              <StaticURDFRobot
                onRobotLoad={setRobot}
                color={robotView === 'commander' ? commanderRobotColor : hardwareRobotColor}
                transparency={robotView === 'commander' ? commanderRobotTransparency : hardwareRobotTransparency}
                metalness={metalness}
                roughness={roughness}
              />

              {/* Uploaded STL Mesh - positioned at L6 attachment point, color and transparency match robot */}
              <ToolMeshPreview
                stlGeometry={stlGeometry}
                gltfScene={gltfScene}
                robotRef={robot}
                offset={meshOffset}
                stlGeometryOpen={stlGeometryOpen}
                stlGeometryClosed={stlGeometryClosed}
                gltfSceneOpen={gltfSceneOpen}
                gltfSceneClosed={gltfSceneClosed}
                displayState={displayState}
                color={robotView === 'commander' ? commanderRobotColor : hardwareRobotColor}
                transparency={robotView === 'commander' ? commanderRobotTransparency : hardwareRobotTransparency}
                metalness={metalness}
                roughness={roughness}
              />

              {/* TCP Gizmo (orange/cyan/magenta arrows) - shows functional tool center point */}
              <GripperTCPVisualizer robotRef={robot} tcpOffset={tcpOffset} />
            </Suspense>

            <OrbitControls target={[0, 0.2, 0]} />

            {/* Grid - meter scale */}
            <Grid args={[10, 10]} cellColor="#6b6b6b" sectionColor="#3f3f3f" />

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

          {/* 3D View Controls */}
          <div className="absolute bottom-4 left-4 z-10 bg-black/70 px-3 py-2 rounded-lg backdrop-blur-sm">
            <div className="flex items-center gap-4">
              {/* Show as toggle */}
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground">Show as:</span>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant={robotView === 'commander' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setRobotView('commander')}
                    className="h-6 px-2 text-[10px]"
                  >
                    Commander
                  </Button>
                  <Button
                    variant={robotView === 'hardware' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setRobotView('hardware')}
                    className="h-6 px-2 text-[10px]"
                  >
                    Hardware
                  </Button>
                </div>
              </div>

              {/* Gripper state toggle (only shown if gripper geometries exist) */}
              {(stlGeometryOpen || stlGeometryClosed || gltfSceneOpen || gltfSceneClosed) && (
                <>
                  <div className="w-px h-6 bg-muted-foreground/30" />
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground">Gripper state:</span>
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant={displayState === 'open' ? 'default' : 'ghost'}
                        size="sm"
                        onClick={() => setDisplayState('open')}
                        className="h-6 px-2 text-[10px]"
                      >
                        Open
                      </Button>
                      <Button
                        variant={displayState === 'closed' ? 'default' : 'ghost'}
                        size="sm"
                        onClick={() => setDisplayState('closed')}
                        className="h-6 px-2 text-[10px]"
                      >
                        Closed
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Dialogs */}
      <ToolDeleteDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        tool={toolToDelete}
        onConfirm={confirmDeleteTool}
      />
    </main>
  );
}
