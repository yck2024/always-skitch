import { TopNav } from '../components/TopNav';

// Freeform is the multi-image annotation board at /freeform. This is just the
// routing-foundation empty state; the canvas, paste handler, and tools land in
// later issues. See src/freeform/CONTEXT.md (Freeform context glossary) and
// ADR 0002 (separate route, not mode toggle) for the design rationale.
export default function FreeformApp() {
  return (
    <div className="app">
      <TopNav />
      <main className="workspace">
        <div className="canvas-shell">
          <div className="empty-state">
            <div className="empty-icon" aria-hidden="true">∞</div>
            <h1>Freeform</h1>
            <p>Paste an image to start — or paste several to build a board.</p>
          </div>
        </div>
      </main>
    </div>
  );
}
