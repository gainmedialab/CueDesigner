import {
  EXPORT_FORMATS,
  PYRO_SAFETY_COPY,
  buildExportPack,
  countExportCues,
  sanitizeFilename,
  type ExportFormatId,
  type Project,
} from "@cuedesigner/core";
import { useEffect, useMemo, useState } from "react";
import { buildZipBlob, downloadBlob } from "./zipDownload";

export interface ExportDialogProps {
  project: Project;
  open: boolean;
  onClose: () => void;
  onStatus: (message: string) => void;
}

const DEFAULT_FORMATS: ExportFormatId[] = [
  "magicq",
  "grandma3",
  "sfx-finale",
  "generic-csv",
];

export function ExportDialog({
  project,
  open,
  onClose,
  onStatus,
}: ExportDialogProps) {
  const [selected, setSelected] = useState<Set<ExportFormatId>>(
    () => new Set(DEFAULT_FORMATS),
  );
  const [deptIds, setDeptIds] = useState<Set<string>>(() => new Set());
  const [perDepartment, setPerDepartment] = useState(false);
  const [sequencePoolStart, setSequencePoolStart] = useState(1);
  const [timecodePoolSlot, setTimecodePoolSlot] = useState(1);
  const [pyroAck, setPyroAck] = useState(false);

  // Reset dept selection to all when opening / departments change
  useEffect(() => {
    if (!open) return;
    setDeptIds(new Set(project.departments.map((d) => d.id)));
    setPyroAck(false);
  }, [open, project.departments]);

  const activeDepts = useMemo(() => {
    if (deptIds.size === 0) return undefined;
    if (deptIds.size === project.departments.length) return undefined;
    return [...deptIds];
  }, [deptIds, project.departments.length]);

  const cueCount = countExportCues(project, activeDepts);
  const needsPyroAck = [...selected].some(
    (id) => EXPORT_FORMATS.find((f) => f.id === id)?.pyroSafety,
  );

  if (!open) return null;

  const toggleFormat = (id: ExportFormatId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleDept = (id: string) => {
    setDeptIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onExport = () => {
    if (selected.size === 0) {
      onStatus("Export: select at least one format.");
      return;
    }
    if (cueCount === 0) {
      onStatus("Export: no cues in the selected departments.");
      return;
    }
    if (needsPyroAck && !pyroAck) {
      onStatus("Export: acknowledge pyro/SFX planning notice first.");
      return;
    }

    const files = buildExportPack(project, [...selected], {
      departmentIds: activeDepts,
      perDepartment,
      sequencePoolStart,
      timecodePoolSlot,
    });

    if (files.length === 0) {
      onStatus("Export: nothing to download.");
      return;
    }

    // Browsers block rapid multi a.click() downloads — one file stays a single
    // download; two+ formats go in one ZIP so every selected format arrives.
    if (files.length === 1) {
      const file = files[0]!;
      downloadBlob(
        file.filename,
        new Blob([file.content], { type: file.mimeType }),
      );
      onStatus(
        `Exported ${file.filename} (${cueCount} cue${cueCount === 1 ? "" : "s"}). Offline download — no network used.`,
      );
    } else {
      const zipName = `${sanitizeFilename(project.name)}_exports.zip`;
      const zip = buildZipBlob(
        files.map((f) => ({ filename: f.filename, content: f.content })),
      );
      downloadBlob(zipName, zip);
      onStatus(
        `Exported ${files.length} files in ${zipName} (${cueCount} cue${cueCount === 1 ? "" : "s"}). Offline download — no network used.`,
      );
    }
    onClose();
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal export-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
      >
        <header className="modal-header">
          <h2 id="export-dialog-title">Export show</h2>
          <button type="button" className="modal-close" onClick={onClose}>
            Close
          </button>
        </header>

        <p className="modal-lead">
          Download cue lists for lighting desks and SFX controllers. Export-only
          — no live desk GO or hardware arming. {cueCount} cue
          {cueCount === 1 ? "" : "s"} selected.
        </p>

        <section className="export-section">
          <h3>Formats</h3>
          <ul className="export-format-list">
            {EXPORT_FORMATS.map((fmt) => (
              <li key={fmt.id}>
                <label className="export-check">
                  <input
                    type="checkbox"
                    checked={selected.has(fmt.id)}
                    onChange={() => toggleFormat(fmt.id)}
                  />
                  <span>
                    <strong>{fmt.label}</strong>
                    <span className="export-desc">{fmt.description}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </section>

        <section className="export-section">
          <h3>Departments</h3>
          <ul className="export-dept-list">
            {project.departments.map((d) => (
              <li key={d.id}>
                <label className="export-check">
                  <input
                    type="checkbox"
                    checked={deptIds.has(d.id)}
                    onChange={() => toggleDept(d.id)}
                  />
                  <span
                    className="export-dept-swatch"
                    style={{ background: d.color }}
                    aria-hidden
                  />
                  <span>{d.name}</span>
                </label>
              </li>
            ))}
          </ul>
          <label className="export-check export-option">
            <input
              type="checkbox"
              checked={perDepartment}
              onChange={(e) => setPerDepartment(e.target.checked)}
            />
            <span>
              One file per department (MagicQ / grandMA2 CSV when selected)
            </span>
          </label>
        </section>

        {(selected.has("grandma3") || selected.has("grandma2")) && (
          <section className="export-section">
            <h3>grandMA pool slots</h3>
            <div className="export-ma-fields">
              <label>
                Sequence start
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={sequencePoolStart}
                  onChange={(e) =>
                    setSequencePoolStart(
                      Math.max(1, Number.parseInt(e.target.value, 10) || 1),
                    )
                  }
                />
              </label>
              <label>
                Timecode slot
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={timecodePoolSlot}
                  onChange={(e) =>
                    setTimecodePoolSlot(
                      Math.max(1, Number.parseInt(e.target.value, 10) || 1),
                    )
                  }
                />
              </label>
            </div>
          </section>
        )}

        {needsPyroAck && (
          <section className="export-section export-safety">
            <p className="safety">{PYRO_SAFETY_COPY}</p>
            <label className="export-check">
              <input
                type="checkbox"
                checked={pyroAck}
                onChange={(e) => setPyroAck(e.target.checked)}
              />
              <span>
                I understand this is planning data for the firing system — the
                app does not arm or fire hardware.
              </span>
            </label>
          </section>
        )}

        <footer className="modal-footer">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={onExport}
            disabled={
              selected.size === 0 ||
              cueCount === 0 ||
              (needsPyroAck && !pyroAck)
            }
          >
            {selected.size > 1 ? "Download zip" : "Download"}
          </button>
        </footer>
      </div>
    </div>
  );
}
