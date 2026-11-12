import type { SVGProps } from 'react';

type Props = SVGProps<SVGSVGElement> & { size?: number };

function SVG({ size = 18, children, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconOverview = (props: Props) => (
  <SVG {...props}>
    <rect x="3" y="3" width="7" height="7" rx="2" />
    <rect x="14" y="3" width="7" height="7" rx="2" />
    <rect x="3" y="14" width="7" height="7" rx="2" />
    <rect x="14" y="14" width="7" height="7" rx="2" />
  </SVG>
);

export const IconPorts = (props: Props) => (
  <SVG {...props}>
    <path d="M6 3v6" />
    <path d="M18 3v6" />
    <path d="M12 3v4" />
    <path d="M4 9h16v4a8 8 0 0 1-16 0V9Z" />
    <path d="M12 21v-2" />
  </SVG>
);

export const IconGlobe = (props: Props) => (
  <SVG {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3.6 9h16.8M3.6 15h16.8" />
    <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z" />
  </SVG>
);

export const IconServer = (props: Props) => (
  <SVG {...props}>
    <rect x="3" y="4" width="18" height="7" rx="2" />
    <rect x="3" y="13" width="18" height="7" rx="2" />
    <path d="M7 7.5h.01M7 16.5h.01" />
  </SVG>
);

export const IconMonitor = (props: Props) => (
  <SVG {...props}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8" />
    <path d="M12 16v4" />
  </SVG>
);

export const IconSettings = (props: Props) => (
  <SVG {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.36a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.64 15a1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.64 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.64a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.36 9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z" />
  </SVG>
);

export const IconPlus = (props: Props) => (
  <SVG {...props}>
    <path d="M12 5v14M5 12h14" />
  </SVG>
);

export const IconTrash = (props: Props) => (
  <SVG {...props}>
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
  </SVG>
);

export const IconEdit = (props: Props) => (
  <SVG {...props}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
  </SVG>
);

export const IconCopy = (props: Props) => (
  <SVG {...props}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </SVG>
);

export const IconCheck = (props: Props) => (
  <SVG {...props}>
    <path d="m4 12.5 5 5L20 6.5" />
  </SVG>
);

export const IconList = (props: Props) => (
  <SVG {...props}>
    <path d="M8 6h13M8 12h13M8 18h13" />
    <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" strokeWidth={2.6} />
  </SVG>
);

export const IconClose = (props: Props) => (
  <SVG {...props}>
    <path d="M18 6 6 18M6 6l12 12" />
  </SVG>
);

export const IconRefresh = (props: Props) => (
  <SVG {...props}>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </SVG>
);

export const IconShield = (props: Props) => (
  <SVG {...props}>
    <path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z" />
    <path d="m9 12 2 2 4-4" />
  </SVG>
);

export const IconSearch = (props: Props) => (
  <SVG {...props}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.2-3.2" />
  </SVG>
);

export const IconExternal = (props: Props) => (
  <SVG {...props}>
    <path d="M14 3h7v7" />
    <path d="M10 14 21 3" />
    <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
  </SVG>
);

export const IconChevron = (props: Props) => (
  <SVG {...props}>
    <path d="m9 6 6 6-6 6" />
  </SVG>
);

export const IconGrip = (props: Props) => (
  <SVG {...props}>
    <path
      d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"
      strokeWidth={2.6}
    />
  </SVG>
);

export const IconPower = (props: Props) => (
  <SVG {...props}>
    <path d="M12 3v9" />
    <path d="M6.4 6.4a8 8 0 1 0 11.2 0" />
  </SVG>
);

export const IconArrow = (props: Props) => (
  <SVG {...props}>
    <path d="M4 12h16M14 6l6 6-6 6" />
  </SVG>
);

export const IconClock = (props: Props) => (
  <SVG {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </SVG>
);

export const IconBolt = (props: Props) => (
  <SVG {...props}>
    <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
  </SVG>
);

export const IconLock = (props: Props) => (
  <SVG {...props}>
    <rect x="4" y="10" width="16" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </SVG>
);

export const IconKey = (props: Props) => (
  <SVG {...props}>
    <circle cx="8" cy="15" r="4" />
    <path d="m10.8 12.2 8.2-8.2M16 4l4 4M13.5 6.5l3 3" />
  </SVG>
);

export const IconTerminal = (props: Props) => (
  <SVG {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 9 3 3-3 3M13 15h4" />
  </SVG>
);

export const IconMoon = (props: Props) => (
  <SVG {...props}>
    <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
  </SVG>
);

export const IconSun = (props: Props) => (
  <SVG {...props}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </SVG>
);
