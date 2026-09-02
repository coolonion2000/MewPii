/** Inline SVG icons (lucide-style, 24x24 stroke). Single source of truth. */
import type { CSSProperties } from 'react';

interface IconProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
  strokeWidth?: number;
}

function base(props: IconProps, children: React.ReactNode, filled = false) {
  const { size = 15, className, style, strokeWidth = 1.9 } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
    >
      {children}
    </svg>
  );
}

export const IconPlus = (p: IconProps) => base(p, <path d="M12 5v14M5 12h14" />);
export const IconSearch = (p: IconProps) => base(p, <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>);
export const IconSettings = (p: IconProps) => base(p, <><path d="M4 8h10M18 8h2M4 16h2M10 16h10" /><circle cx="16" cy="8" r="2" /><circle cx="8" cy="16" r="2" /></>);
export const IconX = (p: IconProps) => base(p, <path d="M18 6 6 18M6 6l12 12" />);
export const IconCheck = (p: IconProps) => base(p, <path d="m5 12 4 4L19 6" />);
export const IconStar = (p: IconProps) => base(p, <path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" />);
export const IconStarFilled = (p: IconProps) => base(p, <path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" />, true);
export const IconArchive = (p: IconProps) => base(p, <><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" /><path d="M10 12h4" /></>);
export const IconUnarchive = (p: IconProps) => base(p, <><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" /><path d="m12 12v6M9 15l3-3 3 3" /></>);
export const IconPencil = (p: IconProps) => base(p, <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />);
export const IconFolder = (p: IconProps) => base(p, <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />);
export const IconChevronRight = (p: IconProps) => base(p, <path d="m9 6 6 6-6 6" />);
export const IconChevronLeft = (p: IconProps) => base(p, <path d="m15 6-6 6 6 6" />);
export const IconChevronDown = (p: IconProps) => base(p, <path d="m6 9 6 6 6-6" />);
export const IconRefresh = (p: IconProps) => base(p, <><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" /></>);
export const IconSun = (p: IconProps) => base(p, <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>);
export const IconMoon = (p: IconProps) => base(p, <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />);
export const IconArrowUp = (p: IconProps) => base(p, <g transform="translate(0 1.8)"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></g>);
export const IconStop = (p: IconProps) => base(p, <rect x="5.5" y="5.5" width="13" height="13" rx="2.5" />, true);
export const IconPaperclip = (p: IconProps) => base(p, <path d="m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />);
export const IconGitFork = (p: IconProps) => base(p, <><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" /><path d="M6 8.5v7M18 10.5c0 4-3.5 4.5-7 5" /></>);
export const IconEditBranch = (p: IconProps) => base(p, <><path d="M6 3v12" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="6" r="2.5" /><path d="M18 8.5c0 5-4 6.5-9.5 6.9" /></>);
export const IconCompress = (p: IconProps) => base(p, <><path d="M4 14h6v6" /><path d="M20 10h-6V4" /><path d="m14 10 7-7" /><path d="m3 21 7-7" /></>);
export const IconExport = (p: IconProps) => base(p, <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>);
export const IconTrash = (p: IconProps) => base(p, <><path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></>);

/* tool icons */
export const IconThink = (p: IconProps) =>
  base(p, <><circle cx="12" cy="12" r="2" /><path d="M12 2a15.3 15.3 0 0 1 0 20 10 10 0 0 1 0-20z" /><path d="M12 2a15.3 15.3 0 0 0 0 20 10 10 0 0 0 0-20z" transform="rotate(60 12 12)" /><path d="M12 2a15.3 15.3 0 0 0 0 20 10 10 0 0 0 0-20z" transform="rotate(120 12 12)" /></>);
export const IconTerminal = (p: IconProps) => base(p, <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3" /><path d="M12 15h5" /></>);
export const IconEye = (p: IconProps) => base(p, <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></>);
export const IconPenLine = (p: IconProps) => base(p, <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>);
export const IconFilePlus = (p: IconProps) => base(p, <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M12 18v-6" /><path d="M9 15h6" /></>);
export const IconFileText = (p: IconProps) => base(p, <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M16 13H8M16 17H8M10 9H8" /></>);
export const IconGrep = (p: IconProps) => base(p, <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /><path d="M8.5 11h5" /></>);
export const IconFind = (p: IconProps) => base(p, <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /><path d="M9.5 9.5 12.5 12.5" /></>);
export const IconLs = (p: IconProps) => base(p, <><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="3.5" cy="6" r="1" /><circle cx="3.5" cy="12" r="1" /><circle cx="3.5" cy="18" r="1" /></>);
export const IconSparkles = (p: IconProps) => base(p, <><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /><circle cx="12" cy="12" r="3" /></>);
export const IconRobot = (p: IconProps) => base(p, <><rect x="5" y="8" width="14" height="12" rx="2" /><path d="M12 8V4" /><circle cx="12" cy="3" r="1" /><circle cx="9.5" cy="13" r="1" /><circle cx="14.5" cy="13" r="1" /><path d="M9 17h6" /></>);
export const IconChat = (p: IconProps) => base(p, <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5c-1.5 0-3-.4-4.2-1.1L3 20l1.1-5.3A8.5 8.5 0 1 1 21 11.5z" />);
export const IconLogout = (p: IconProps) => base(p, <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></>);
export const IconWrench = (p: IconProps) => base(p, <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.1-2.1z" />);

export type ToolIconName = 'think' | 'bash' | 'read' | 'edit' | 'write' | 'grep' | 'find' | 'ls' | 'tool';

export function ToolIcon({ name, size = 14, className }: { name: ToolIconName; size?: number; className?: string }) {
  switch (name) {
    case 'think': return <IconThink size={size} className={className} />;
    case 'bash': return <IconTerminal size={size} className={className} />;
    case 'read': return <IconEye size={size} className={className} />;
    case 'edit': return <IconPenLine size={size} className={className} />;
    case 'write': return <IconFilePlus size={size} className={className} />;
    case 'grep': return <IconGrep size={size} className={className} />;
    case 'find': return <IconFind size={size} className={className} />;
    case 'ls': return <IconLs size={size} className={className} />;
    default: return <IconSparkles size={size} className={className} />;
  }
}

export const IconBot = (p: IconProps) => base(p, <><rect x="5" y="8" width="14" height="10" rx="2" /><path d="M12 8V4" /><circle cx="9" cy="13" r="1" fill="currentColor" stroke="none" /><circle cx="15" cy="13" r="1" fill="currentColor" stroke="none" /><path d="M2 13h3M19 13h3" /></>);
