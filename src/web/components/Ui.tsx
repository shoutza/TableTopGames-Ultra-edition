import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return reduced;
}

export type IconName =
  | 'dice'
  | 'grid'
  | 'arrow'
  | 'back'
  | 'play'
  | 'pause'
  | 'step'
  | 'save'
  | 'star'
  | 'sparkles'
  | 'clock'
  | 'check'
  | 'sliders'
  | 'activity'
  | 'users'
  | 'search'
  | 'flag'
  | 'chevron';

const paths: Record<IconName, ReactNode> = {
  dice: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <path d="M8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01" strokeWidth="3" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" />
    </>
  ),
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  back: <path d="M20 12H4m6-6-6 6 6 6" />,
  play: <path d="m8 4 13 8-13 8Z" />,
  pause: (
    <>
      <path d="M8 5v14M16 5v14" strokeWidth="4" />
    </>
  ),
  step: (
    <>
      <path d="m5 5 11 7-11 7Z" />
      <path d="M20 5v14" />
    </>
  ),
  save: (
    <>
      <path d="M5 3h12l4 4v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <path d="M7 3v6h10V3M7 21v-8h10v8" />
    </>
  ),
  star: <path d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1 6.2-5.6-3-5.6 3 1-6.2-4.5-4.4 6.3-.9Z" />,
  sparkles: (
    <>
      <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" />
      <path d="m20 2 .5 1.5L22 4l-1.5.5L20 6l-.5-1.5L18 4l1.5-.5Z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  sliders: (
    <>
      <path d="M5 3v5m0 4v9M12 3v9m0 4v5M19 3v2m0 4v12" />
      <path d="M2 8h6m1 8h6m1-11h6" />
    </>
  ),
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v2" />
    </>
  ),
  search: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="m15 15 6 6" />
    </>
  ),
  flag: (
    <>
      <path d="M5 21V3m0 0h14l-3 5 3 5H5" />
    </>
  ),
  chevron: <path d="m9 5 7 7-7 7" />,
};

export function Icon({ name, size = 20, className = '' }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

// Starter pieces have crisp vector symbols, while custom scenarios keep their own icons.
const pieceSymbols: Record<string, ReactNode> = {
  '🏴‍☠️': (
    <>
      <path d="m5 18 14 4M19 18 5 22" />
      <path d="M6 10a6 6 0 0 1 12 0v4l-3 2v3H9v-3l-3-2Z" />
      <circle cx="9" cy="11" r="1" />
      <circle cx="15" cy="11" r="1" />
      <path d="m11 15 1-2 1 2M12 16v3" />
    </>
  ),
  '📚': (
    <>
      <path d="M3 5c3-1 6-1 9 1 3-2 6-2 9-1v14c-3-1-6-1-9 1-3-2-6-2-9-1Z" />
      <path d="M12 6v14M6 9h3m6 0h3M6 13h3m6 0h3" />
    </>
  ),
  '🐸': (
    <>
      <path d="M4 10V7a3 3 0 0 1 6 0h4a3 3 0 0 1 6 0v3c2 2 2 7-1 9-3 2-11 2-14 0-3-2-3-7-1-9Z" />
      <path d="M7 7h.01M17 7h.01" strokeWidth="3" />
      <path d="M8 14c2 3 6 3 8 0" />
    </>
  ),
  '🗡️': (
    <>
      <path d="m8 16 9-13 4 4-13 9ZM5 13l6 6M7 17l-4 4m-1-1 2 2" />
    </>
  ),
  '🟢': (
    <>
      <path d="M3 18c0-4 2-6 4-9 2-5 6-5 8-1 2 3 6 5 6 10 0 3-18 3-18 0Z" />
      <path d="M8 13h.01M16 13h.01" strokeWidth="2.5" />
      <path d="M10 17h4" />
    </>
  ),
  '👹': (
    <>
      <path d="m7 6-4-3v9m14-6 4-3v9M5 10c0-7 14-7 14 0v5c0 8-14 8-14 0Z" />
      <path d="m7 10 3 2m7-2-3 2m-6 5 2-2 2 2 2-2 2 2" />
    </>
  ),
  '🏪': (
    <>
      <path d="M4 9h16v12H4ZM3 9l2-6h14l2 6M8 3v6m8-6V3M9 21v-7h6v7" />
      <path d="M3 9c0 3 4 3 4 0 0 3 5 3 5 0 0 3 5 3 5 0 0 3 4 3 4 0" />
    </>
  ),
  '🌟': paths.star,
};
export function PieceSymbol({ icon, size = 22 }: { icon: string; size?: number }) {
  const symbol = pieceSymbols[icon];
  return symbol ? (
    <svg
      className="piece-symbol"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {symbol}
    </svg>
  ) : (
    <span aria-hidden="true">{icon}</span>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand${compact ? ' compact' : ''}`}>
      <span className="brand-mark">
        <Icon name="dice" size={25} />
      </span>
      {!compact && (
        <span>
          tabletop<span className="brand-edition">ULTRA EDITION</span>
        </span>
      )}
    </div>
  );
}

export function Rail({
  items,
}: {
  items: Array<{
    icon: IconName;
    label: string;
    active: boolean;
    onClick: () => void;
  }>;
}) {
  return (
    <aside className="rail">
      <Brand compact />
      <nav aria-label="Main navigation">
        {items.map((item) => (
          <button
            key={item.label}
            className={`rail-button${item.active ? ' active' : ''}`}
            aria-current={item.active ? 'page' : undefined}
            onClick={item.onClick}
            title={item.label}
          >
            <Icon name={item.icon} size={21} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="rail-footer">
        <span className="gm-avatar">GM</span>
        <span>Your table</span>
      </div>
    </aside>
  );
}

export function EmptyState({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={26} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

export function playerStyle(color: string): CSSProperties {
  return { '--player-color': color } as CSSProperties;
}

/** Lightweight, local SVG artwork: no network assets or image-loading delay. */
export function TabletopArt() {
  const tiles = [
    { x: 90, y: 220, color: '#f1bc58', icon: 'star' },
    { x: 170, y: 125, color: '#84b7bd', icon: 'dice' },
    { x: 285, y: 85, color: '#b9a4d0', icon: 'sparkles' },
    { x: 405, y: 135, color: '#e58a72', icon: 'flag' },
    { x: 440, y: 255, color: '#9ab99c', icon: 'star' },
    { x: 310, y: 295, color: '#f1bc58', icon: 'dice' },
    { x: 195, y: 320, color: '#84b7bd', icon: 'sparkles' },
  ];
  return (
    <svg
      className="tabletop-art"
      viewBox="0 0 540 410"
      role="img"
      aria-label="A colorful tabletop adventure with connected game tiles and a floating die"
    >
      <ellipse cx="275" cy="250" rx="235" ry="126" fill="#ffffff" opacity=".025" />
      <ellipse
        cx="270"
        cy="232"
        rx="204"
        ry="139"
        fill="none"
        stroke="#fff"
        strokeOpacity=".07"
        strokeDasharray="3 9"
      />
      <path
        d="M90 220 170 125 285 85 405 135 440 255 310 295 195 320Z"
        fill="none"
        stroke="#637772"
        strokeWidth="3"
        strokeDasharray="6 8"
      />
      {tiles.map((tile, i) => (
        <g key={i} transform={`translate(${tile.x} ${tile.y}) rotate(-16)`}>
          <rect x="-30" y="-20" width="60" height="60" rx="16" fill="#000" opacity=".17" />
          <rect x="-30" y="-30" width="60" height="60" rx="16" fill={tile.color} />
          <rect x="-24" y="-24" width="48" height="48" rx="12" fill="none" stroke="#fff" strokeOpacity=".3" />
          <g transform="translate(-12 -12)" color="#253735">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {paths[tile.icon as IconName]}
            </svg>
          </g>
        </g>
      ))}
      <g className="art-die">
        <g transform="translate(266 193) rotate(13)">
          <rect x="-41" y="-30" width="82" height="82" rx="23" fill="#0b1919" opacity=".25" />
          <rect x="-41" y="-41" width="82" height="82" rx="23" fill="#fff3dc" />
          <rect x="-34" y="-34" width="68" height="68" rx="18" fill="none" stroke="#eadcc1" strokeWidth="2" />
          {[
            [-19, -19],
            [19, -19],
            [0, 0],
            [-19, 19],
            [19, 19],
          ].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="5.5" fill="#df805f" />
          ))}
        </g>
      </g>
      <g fill="#f1bc58" className="art-sparkles">
        <path d="m82 96 3 8 8 3-8 3-3 8-3-8-8-3 8-3Z" />
        <path d="m467 71 2 6 6 2-6 2-2 6-2-6-6-2 6-2Z" />
        <circle cx="390" cy="340" r="3" />
        <circle cx="117" cy="310" r="2" />
      </g>
    </svg>
  );
}
