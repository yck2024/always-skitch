import { NavLink } from 'react-router-dom';

// Top-level navigation between the two coequal products in this repo: Skitch
// (single-image) at '/' and Freeform (multi-image) at '/freeform'. NavLink sets
// aria-current="page" on the active tab automatically; the .active class drives
// the visual style.
export function TopNav() {
  return (
    <nav className="top-nav" aria-label="Primary">
      <div className="brand">
        <span className="brand-mark">↗</span>
        <span>Mini Skitch</span>
      </div>
      <div className="top-nav-tabs">
        <NavLink
          to="/"
          end
          className={({ isActive }) => (isActive ? 'top-nav-tab active' : 'top-nav-tab')}
        >
          Skitch
        </NavLink>
        <NavLink
          to="/freeform"
          className={({ isActive }) => (isActive ? 'top-nav-tab active' : 'top-nav-tab')}
        >
          Freeform
        </NavLink>
      </div>
    </nav>
  );
}
