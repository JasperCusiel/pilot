'use client';

import { useCallback, useRef, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Upload, FileIcon, Trash2, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import { getApiBaseUrl } from '../lib/apiConfig';
import { useRobotProfileStore } from '../lib/stores/robotProfileStore';
import DHParameterEditor from './DHParameterEditor';

interface DroppedFile {
  file: File;
  isUrdf: boolean;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the "data:...;base64," prefix
      resolve(result.split(',')[1] ?? '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const ACCEPTED_EXTENSIONS = ['.urdf', '.stl', '.glb', '.gltf', '.dae', '.obj'];

export default function CustomRobotUploader() {
  const { profiles, activeId, fetchProfiles } = useRobotProfileStore();
  const [dragOver, setDragOver] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<DroppedFile[]>([]);
  const [discoveredJoints, setDiscoveredJoints] = useState<string[]>([]);
  const [jointMapping, setJointMapping] = useState<string[]>(['', '', '', '', '', '']);
  const [robotName, setRobotName] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [editingDhProfileId, setEditingDhProfileId] = useState<string | null>(null);
  const [editingLimitsProfileId, setEditingLimitsProfileId] = useState<string | null>(null);
  const [limitsDraft, setLimitsDraft] = useState<[number, number][]>([]);
  const [limitsSaving, setLimitsSaving] = useState(false);
  const [limitsError, setLimitsError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const startEditingLimits = (p: typeof profiles[number]) => {
    setLimitsError(null);
    setLimitsDraft(
      (p.joint_limits_deg?.length === 6
        ? p.joint_limits_deg
        : [[-180, 180], [-180, 180], [-180, 180], [-180, 180], [-180, 180], [-180, 180]]
      ).map(([lo, hi]) => [lo, hi] as [number, number])
    );
    setEditingLimitsProfileId(p.id === editingLimitsProfileId ? null : p.id);
  };

  const saveLimits = async (profileId: string) => {
    setLimitsSaving(true);
    setLimitsError(null);
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/config/robot/profiles/${profileId}/joint-limits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limits_deg: limitsDraft }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || `Save failed (HTTP ${response.status})`);
      }
      await fetchProfiles();
      setEditingLimitsProfileId(null);
    } catch (err: any) {
      setLimitsError(err.message || String(err));
    } finally {
      setLimitsSaving(false);
    }
  };

  const customProfiles = profiles.filter((p) => !p.builtin);

  const resetUploadState = () => {
    setDroppedFiles([]);
    setDiscoveredJoints([]);
    setJointMapping(['', '', '', '', '', '']);
    setRobotName('');
    setParseError(null);
    setUploadError(null);
    setUploadSuccess(null);
  };

  const handleFiles = useCallback(async (fileList: FileList | File[]) => {
    setParseError(null);
    setUploadSuccess(null);
    const files = Array.from(fileList).filter((f) =>
      ACCEPTED_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext))
    );
    if (files.length === 0) {
      setParseError('No .urdf/.stl/.glb/.gltf/.dae/.obj files found in what you dropped.');
      return;
    }

    const urdfFiles = files.filter((f) => f.name.toLowerCase().endsWith('.urdf'));
    if (urdfFiles.length !== 1) {
      setParseError(
        urdfFiles.length === 0
          ? 'No .urdf file found - drop the URDF along with its mesh files.'
          : `Found ${urdfFiles.length} .urdf files - drop exactly one robot at a time.`
      );
      return;
    }

    const next: DroppedFile[] = files.map((f) => ({ file: f, isUrdf: f === urdfFiles[0] }));
    setDroppedFiles(next);
    if (!robotName) {
      setRobotName(urdfFiles[0].name.replace(/\.urdf$/i, ''));
    }

    // Parse the URDF client-side to discover joints, purely for the mapping
    // UI - the backend re-parses and validates independently, this is just
    // so we can show you sensible choices before uploading anything.
    try {
      const text = await urdfFiles[0].text();
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      if (doc.querySelector('parsererror')) {
        throw new Error('The URDF file is not well-formed XML');
      }
      const joints = Array.from(doc.querySelectorAll('joint')).filter((j) => {
        const type = j.getAttribute('type');
        return type === 'revolute' || type === 'continuous';
      });
      const names = joints.map((j) => j.getAttribute('name') || '').filter(Boolean);
      if (names.length < 6) {
        setParseError(
          `Found ${names.length} revolute/continuous joint(s) in the URDF, but this app controls 6-axis arms - ` +
          `need exactly 6. (Both the MKS TinyBee firmware and this app's control stack assume a 6-joint chain.)`
        );
        setDiscoveredJoints([]);
        return;
      }
      setDiscoveredJoints(names);
      // Default mapping: first 6 joints found, in document order
      setJointMapping(names.slice(0, 6));
    } catch (err: any) {
      setParseError(`Could not read the URDF: ${err.message || err}`);
      setDiscoveredJoints([]);
    }
  }, [robotName]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const canUpload =
    droppedFiles.length > 0 &&
    discoveredJoints.length >= 6 &&
    jointMapping.every((j) => j) &&
    new Set(jointMapping).size === 6 &&
    robotName.trim().length > 0 &&
    !uploading;

  const handleUpload = async () => {
    setUploading(true);
    setUploadError(null);
    try {
      const urdfEntry = droppedFiles.find((f) => f.isUrdf);
      if (!urdfEntry) throw new Error('No URDF file in the drop');

      const urdf_data = await fileToBase64(urdfEntry.file);
      const meshes = await Promise.all(
        droppedFiles
          .filter((f) => !f.isUrdf)
          .map(async (f) => ({
            filename: f.file.name,
            data: await fileToBase64(f.file),
          }))
      );

      const response = await fetch(`${getApiBaseUrl()}/api/config/robot/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: robotName.trim(),
          urdf_filename: urdfEntry.file.name,
          urdf_data,
          meshes,
          joint_mapping: jointMapping,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || `Upload failed (HTTP ${response.status})`);
      }

      const data = await response.json();
      setUploadSuccess(`"${data.profile.name}" uploaded. Activate it below to view/jog it.`);
      await fetchProfiles();
      resetUploadState();
    } catch (err: any) {
      setUploadError(err.message || String(err));
    } finally {
      setUploading(false);
    }
  };

  const handleActivate = async (id: string) => {
    setActivating(true);
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/config/robot/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!response.ok) throw new Error(`Activate failed (HTTP ${response.status})`);
      await fetchProfiles();
      // The 3D viewer loads its URDF once on mount - reload so the new
      // robot actually takes effect everywhere (viewer, joint limits, etc).
      // See AUDIT.md for why this isn't done live without a reload.
      window.location.reload();
    } catch (err: any) {
      setUploadError(err.message || String(err));
    } finally {
      setActivating(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/config/robot/profiles/${id}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error(`Delete failed (HTTP ${response.status})`);
      await fetchProfiles();
    } catch (err: any) {
      setUploadError(err.message || String(err));
    }
  };

  return (
    <div className="space-y-3">
      <Card className="p-3">
        <h2 className="text-base font-semibold mb-1">Load a Custom Robot</h2>
        <p className="text-[11px] text-muted-foreground mb-3">
          Drop a .urdf file together with the .stl/.glb mesh files it references. This
          sets up 3D visualization and joint-space jogging with limits read straight
          from the URDF. Cartesian/IK motion keeps using PAROL6's geometry until you
          manually add DH parameters - see AUDIT.md for why.
        </p>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
            dragOver ? 'border-primary bg-accent' : 'border-border hover:bg-accent/50'
          }`}
        >
          <Upload className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium">Drag & drop URDF + mesh files here</p>
          <p className="text-[11px] text-muted-foreground mt-1">or click to browse (select all files together)</p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".urdf,.stl,.glb,.gltf,.dae,.obj"
            className="hidden"
            onChange={(e) => e.target.files && handleFiles(e.target.files)}
          />
        </div>

        {parseError && (
          <div className="mt-3 flex items-start gap-2 text-xs text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{parseError}</span>
          </div>
        )}

        {droppedFiles.length > 0 && (
          <div className="mt-3 space-y-1">
            {droppedFiles.map((f, i) => (
              <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                <FileIcon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{f.file.name}</span>
                {f.isUrdf && <span className="text-[10px] text-primary font-medium shrink-0">URDF</span>}
              </div>
            ))}
          </div>
        )}

        {discoveredJoints.length >= 6 && (
          <div className="mt-4 space-y-3">
            <div>
              <label className="text-[10px] text-muted-foreground block mb-1">Robot name</label>
              <input
                type="text"
                value={robotName}
                onChange={(e) => setRobotName(e.target.value)}
                className="w-full h-8 px-2 rounded-md border bg-background text-sm"
                placeholder="My TinyBee Arm"
              />
            </div>

            <div>
              <label className="text-[10px] text-muted-foreground block mb-1.5">
                Map joints to J1 (base) .. J6 (wrist/tool)
              </label>
              <div className="grid grid-cols-2 gap-2">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-xs font-mono w-6 shrink-0">J{i + 1}</span>
                    <Select
                      value={jointMapping[i]}
                      onValueChange={(val) => {
                        const next = [...jointMapping];
                        next[i] = val;
                        setJointMapping(next);
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="select joint" />
                      </SelectTrigger>
                      <SelectContent>
                        {discoveredJoints.map((name) => (
                          <SelectItem key={name} value={name} className="text-xs">
                            {name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
              {new Set(jointMapping).size !== 6 && jointMapping.every((j) => j) && (
                <p className="text-[11px] text-destructive mt-1.5">
                  Each J1..J6 needs a distinct joint - you've mapped the same joint twice.
                </p>
              )}
            </div>

            {uploadError && (
              <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-2">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{uploadError}</span>
              </div>
            )}
            {uploadSuccess && (
              <div className="flex items-start gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md p-2">
                <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{uploadSuccess}</span>
              </div>
            )}

            <Button
              onClick={handleUpload}
              disabled={!canUpload}
              className="w-full h-8"
              size="sm"
            >
              {uploading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              {uploading ? 'Uploading...' : 'Upload Robot'}
            </Button>
          </div>
        )}
      </Card>

      {customProfiles.length > 0 && (
        <Card className="p-3">
          <h2 className="text-base font-semibold mb-2">Your Robots</h2>
          <div className="space-y-2">
            {customProfiles.map((p) => (
              <div key={p.id} className="rounded-md border p-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate flex items-center gap-1.5">
                      {p.name}
                      {p.id === activeId && (
                        <span className="text-[10px] bg-primary text-primary-foreground rounded-full px-1.5 py-0.5">
                          active
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {p.has_dh_params ? 'Cartesian geometry set' : 'Joint-space only (no Cartesian/IK geometry yet)'}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => startEditingLimits(p)}
                    >
                      Limits
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setEditingDhProfileId(p.id === editingDhProfileId ? null : p.id)}
                    >
                      DH Params
                    </Button>
                    {p.id !== activeId && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={activating}
                        onClick={() => handleActivate(p.id)}
                      >
                        Activate
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-destructive"
                      onClick={() => handleDelete(p.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                {editingLimitsProfileId === p.id && (
                  <div className="mt-2 pt-2 border-t space-y-2">
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                      {limitsDraft.map(([lo, hi], i) => (
                        <div key={i} className="flex items-center gap-1.5">
                          <span className="text-[10px] font-mono w-5 shrink-0">J{i + 1}</span>
                          <input
                            type="number"
                            step="any"
                            value={lo}
                            onChange={(e) => {
                              const next = [...limitsDraft];
                              next[i] = [parseFloat(e.target.value) || 0, next[i][1]];
                              setLimitsDraft(next);
                            }}
                            className="w-16 h-6 px-1 rounded border bg-background text-[11px]"
                          />
                          <span className="text-[10px] text-muted-foreground">to</span>
                          <input
                            type="number"
                            step="any"
                            value={hi}
                            onChange={(e) => {
                              const next = [...limitsDraft];
                              next[i] = [next[i][0], parseFloat(e.target.value) || 0];
                              setLimitsDraft(next);
                            }}
                            className="w-16 h-6 px-1 rounded border bg-background text-[11px]"
                          />
                          <span className="text-[10px] text-muted-foreground">deg</span>
                        </div>
                      ))}
                    </div>
                    {limitsError && <p className="text-[11px] text-destructive">{limitsError}</p>}
                    <Button
                      size="sm"
                      className="h-6 text-[11px]"
                      disabled={limitsSaving}
                      onClick={() => saveLimits(p.id)}
                    >
                      Save Limits
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {activeId !== 'parol6' && (
            <Button
              variant="outline"
              size="sm"
              className="w-full h-8 mt-2 text-xs"
              disabled={activating}
              onClick={() => handleActivate('parol6')}
            >
              Switch back to PAROL6 (default)
            </Button>
          )}
        </Card>
      )}

      {editingDhProfileId && (() => {
        const editingProfile = customProfiles.find((p) => p.id === editingDhProfileId);
        return editingProfile ? (
          <DHParameterEditor profile={editingProfile} onClose={() => setEditingDhProfileId(null)} />
        ) : null;
      })()}
    </div>
  );
}
