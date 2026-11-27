type BrandMarkProps = {
  size?: number;
};

/** Quiet Precision 3D faceted vector emblem (D13-A / TECH-11), crisp from 16 px to 48 px. */
export default function BrandMark({ size = 28 }: BrandMarkProps) {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect className="brand-depth" x="3" y="4" width="26" height="26" rx="7" />
        <rect className="brand-face" x="2" y="2" width="26" height="26" rx="7" />
        <path className="brand-glint" d="M5.5 7.5C5.5 5.84 6.84 4.5 8.5 4.5H23.5" strokeWidth="1.75" strokeLinecap="round" />
        <rect className="brand-glyph" x="7.5" y="8.5" width="15" height="3.2" rx="1.6" />
        <rect className="brand-glyph" x="13.4" y="11.7" width="3.2" height="11.3" rx="1.6" />
        <circle className="brand-glint-dot" cx="21.5" cy="21" r="2" />
      </svg>
    </span>
  );
}
