import { Circle, type FabricObject, type Group } from 'fabric';

export function hexToLowAlpha(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getKind(object: FabricObject): string | undefined {
  return (object as FabricObject & { data?: { kind?: string } }).data?.kind;
}

export function recolorAnnotation(object: FabricObject, color: string): void {
  const kind = getKind(object);
  switch (kind) {
    case 'arrow':
    case 'text':
      object.set({ fill: color });
      break;
    case 'rectangle':
      object.set({ stroke: color });
      break;
    case 'callout': {
      const group = object as Group;
      const circle = group.getObjects().find((child) => child instanceof Circle);
      if (circle) {
        circle.set({ fill: color });
        group.dirty = true;
      }
      break;
    }
    case 'blur-preview':
      object.set({ stroke: color, fill: hexToLowAlpha(color, 0.08) });
      break;
    default:
      break;
  }
  object.setCoords();
}
