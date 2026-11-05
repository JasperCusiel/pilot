'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AlertTriangle, CheckCircle2, Loader2, X } from 'lucide-react';
import { getApiBaseUrl } from '../lib/apiConfig';
import { useRobotProfileStore, type RobotProfile, type DHJointParams } from '../lib/stores/robotProfileStore';

const BLANK_ROW: DHJointParams = { a_mm: 0, alpha_deg: 0, d_mm: 0, offset_deg: 0 };

function emptyTable(): DHJointParams[] {
  return [0, 1, 2, 3, 4, 5].map(() => ({ ...BLANK_ROW }));
}

export default function DHParameterEditor({ profile, onClose }: { profile: RobotProfile; onClose: () => void }) {
  const fetchProfiles = useRobotProfileStore((s) => s.fetchProfiles);
  const [rows, setRows] = useState<DHJointParams[]>(
    profile.dh_params?.joints?.length === 6 ? profile.dh_params.joints : emptyTable()
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const updateCell = (rowIndex: number, field: keyof DHJointParams, value: string) => {
    const num = parseFloat(value);
    setRows((prev) => {
      const next = [...prev];
      next[rowIndex] = { ...next[rowIndex], [field]: Number.isFinite(num) ? num : 0 };
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(
        `${getApiBaseUrl()}/api/config/robot/profiles/${profile.id}/dh-params`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ joints: rows }),
        }
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || `Save failed (HTTP ${response.status})`);
      }
      const data = await response.json();
      setSuccess(data.message);
      await fetchProfiles();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(
        `${getApiBaseUrl()}/api/config/robot/profiles/${profile.id}/dh-params`,
        { method: 'DELETE' }
      );
      if (!response.ok) throw new Error(`Clear failed (HTTP ${response.status})`);
      setRows(emptyTable());
      setAcknowledged(false);
      await fetchProfiles();
      setSuccess('DH parameters cleared - back to joint-space-only for Cartesian motion.');
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  const allZero = rows.every((r) => r.a_mm === 0 && r.alpha_deg === 0 && r.d_mm === 0 && r.offset_deg === 0);

  return (
    <Card className="p-3">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-base font-semibold">DH Parameters - {profile.name}</h2>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex items-start gap-2 text-xs bg-amber-50 border border-amber-200 text-amber-900 rounded-md p-2.5 mb-3">
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p>
            These drive Cartesian/IK motion for this robot - getting them wrong can produce a
            kinematic solution that looks plausible but moves the real arm incorrectly.
          </p>
          <p>
            This is the standard 4-parameter DH table (one row per joint, J1 first): <strong>a</strong> (link
            length, mm), <strong>alpha</strong> (link twist, deg), <strong>d</strong> (link offset, mm),
            <strong> offset</strong> (joint angle offset, deg - usually 0). Measure these from your arm's own
            geometry/CAD model; they are not derived from the URDF/STL files you dropped.
          </p>
          <p className="font-medium">
            After saving, restart the API and commander processes, then verify with slow, small
            joint-space moves before trusting any Cartesian jog on real hardware.
          </p>
        </div>
      </div>

      <div className="overflow-x-auto -mx-1 px-1">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-muted-foreground">
              <th className="text-left font-medium pb-1.5 pr-2">Joint</th>
              <th className="text-left font-medium pb-1.5 pr-2">a (mm)</th>
              <th className="text-left font-medium pb-1.5 pr-2">alpha (deg)</th>
              <th className="text-left font-medium pb-1.5 pr-2">d (mm)</th>
              <th className="text-left font-medium pb-1.5">offset (deg)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <td className="pr-2 py-0.5 font-mono font-medium">J{i + 1}</td>
                {(['a_mm', 'alpha_deg', 'd_mm', 'offset_deg'] as const).map((field) => (
                  <td key={field} className="pr-2 py-0.5">
                    <input
                      type="number"
                      step="any"
                      value={row[field]}
                      onChange={(e) => updateCell(i, field, e.target.value)}
                      className="w-20 h-7 px-1.5 rounded border bg-background text-xs"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error && (
        <div className="mt-3 flex items-start gap-2 text-xs text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-2">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="mt-3 flex items-start gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md p-2">
          <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{success}</span>
        </div>
      )}

      <label className="flex items-start gap-2 mt-3 text-[11px] text-muted-foreground cursor-pointer">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          className="mt-0.5"
        />
        I measured these myself for this specific arm and understand Cartesian motion will use
        them directly once saved.
      </label>

      <div className="flex gap-2 mt-3">
        <Button
          onClick={handleSave}
          disabled={saving || !acknowledged || allZero}
          className="flex-1 h-8"
          size="sm"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          Save DH Parameters
        </Button>
        {profile.has_dh_params && (
          <Button variant="outline" size="sm" className="h-8" disabled={saving} onClick={handleClear}>
            Clear
          </Button>
        )}
      </div>
    </Card>
  );
}
