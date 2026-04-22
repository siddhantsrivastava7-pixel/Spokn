import type { SVGProps } from "react";

interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
  weight?: number;
}

const Icon = ({ children, size = 16, weight = 1.6, ...rest }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round" {...rest}>
    {children}
  </svg>
);

export const IMic = (p: IconProps) => <Icon {...p}><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /></Icon>;
export const IStop = (p: IconProps) => <Icon {...p}><rect x="6" y="6" width="12" height="12" rx="1.5" /></Icon>;
export const IUpload = (p: IconProps) => <Icon {...p}><path d="M12 15V3" /><path d="m7 8 5-5 5 5" /><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" /></Icon>;
export const ICode = (p: IconProps) => <Icon {...p}><path d="m16 18 6-6-6-6" /><path d="m8 6-6 6 6 6" /></Icon>;
export const ITerminal = (p: IconProps) => <Icon {...p}><path d="m4 17 6-6-6-6" /><path d="M12 19h8" /></Icon>;
export const ICopy = (p: IconProps) => <Icon {...p}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></Icon>;
export const IDownload = (p: IconProps) => <Icon {...p}><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></Icon>;
export const ISearch = (p: IconProps) => <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></Icon>;
export const IX = (p: IconProps) => <Icon {...p}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Icon>;
export const ICpu = (p: IconProps) => <Icon {...p}><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 2v2" /><path d="M15 2v2" /><path d="M9 20v2" /><path d="M15 20v2" /><path d="M2 9h2" /><path d="M2 15h2" /><path d="M20 9h2" /><path d="M20 15h2" /></Icon>;
export const ILayers = (p: IconProps) => <Icon {...p}><path d="m12 2 9 5-9 5-9-5 9-5z" /><path d="m3 17 9 5 9-5" /><path d="m3 12 9 5 9-5" /></Icon>;
export const ISpark = (p: IconProps) => <Icon {...p}><path d="M12 2v6" /><path d="M12 16v6" /><path d="M2 12h6" /><path d="M16 12h6" /><path d="m5 5 3 3" /><path d="m16 16 3 3" /><path d="m5 19 3-3" /><path d="m16 8 3-3" /></Icon>;
export const IRefresh = (p: IconProps) => <Icon {...p}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></Icon>;
export const IChevronDown = (p: IconProps) => <Icon {...p}><path d="m6 9 6 6 6-6" /></Icon>;
export const ISliders = (p: IconProps) => <Icon {...p}><path d="M4 21V14" /><path d="M4 10V3" /><path d="M12 21V12" /><path d="M12 8V3" /><path d="M20 21v-5" /><path d="M20 12V3" /><path d="M1 14h6" /><path d="M9 8h6" /><path d="M17 16h6" /></Icon>;
export const IPackage = (p: IconProps) => <Icon {...p}><path d="m16.5 9.4-9-5.19" /><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.29 7 12 12 20.71 7" /><line x1="12" y1="22" x2="12" y2="12" /></Icon>;
