import type { ReactNode } from 'react';

export type ShortcutRow = [key: string, action: string];

export interface ShortcutSection {
  title: string;
  rows: ShortcutRow[];
}

interface ShortcutsModalProps {
  onClose: () => void;
  sections: ShortcutSection[];
  footnote?: ReactNode;
}

export function ShortcutsModal({ onClose, sections, footnote }: ShortcutsModalProps) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2 id="shortcuts-title">Keyboard shortcuts</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close shortcuts">
            ×
          </button>
        </header>
        <div className="modal-body">
          {sections.map((section) => (
            <ShortcutSectionView key={section.title} title={section.title} rows={section.rows} />
          ))}
          {footnote ? <p className="modal-footnote">{footnote}</p> : null}
        </div>
      </div>
    </div>
  );
}

function ShortcutSectionView({ title, rows }: { title: string; rows: ShortcutRow[] }) {
  return (
    <section>
      <h3 className="modal-section-title">{title}</h3>
      <table>
        <tbody>
          {rows.map(([key, action]) => (
            <tr key={`${title}-${key}`}>
              <td className="key">
                {key.split(' + ').map((part, index, all) => (
                  <span key={part}>
                    <kbd>{part}</kbd>
                    {index < all.length - 1 ? ' + ' : null}
                  </span>
                ))}
              </td>
              <td>{action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
