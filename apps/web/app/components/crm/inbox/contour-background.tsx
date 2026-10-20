// Contour field from the rebattery-platform hero band (components/guides/guide-topographic-background).
const PATH = "M734.567 34.372c-28.692 61.724-23.266 100.422 16.275 116.094 59.313 23.508 200.347 32.911 259.299 83.906 58.95 50.994 238.697 11.572 269.438-75.95C1310.32 70.9 1365.669-64 1073.808-64c-194.576 0-307.654 32.79-339.24 98.372h-.001z";
const TRANSFORMS = [
  undefined,
  "translate(-1800, 60) scale(2.8, 2.8) skewX(30)", "translate(-1650, 55) scale(2.65, 2.65) skewX(27.5)",
  "translate(-1500, 50) scale(2.5, 2.5) skewX(25)", "translate(-1350, 45) scale(2.35, 2.35) skewX(22.5)",
  "translate(-1200, 40) scale(2.2, 2.2) skewX(20)", "translate(-1050, 35) scale(2.05, 2.05) skewX(17.5)",
  "translate(-900, 30) scale(1.9, 1.9) skewX(15)", "translate(-750, 25) scale(1.75, 1.75) skewX(12.5)",
  "translate(-600, 20) scale(1.6, 1.6) skewX(10)", "translate(-450, 15) scale(1.45, 1.45) skewX(7.5)",
  "translate(-300, 10) scale(1.3, 1.3) skewX(5)", "translate(-150, 5) scale(1.15, 1.15) skewX(2.5)",
];

export function ContourBackground({ className }: { className?: string }) {
  return <svg aria-hidden="true" className={className} preserveAspectRatio="none" viewBox="0 0 1920 1080">
    <g fill="none" stroke="var(--color-border-strong)" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1">
      {TRANSFORMS.map((transform) => <path key={transform ?? "base"} d={PATH} transform={transform} />)}
    </g>
  </svg>;
}
