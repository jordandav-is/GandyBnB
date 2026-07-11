import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const shared = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function ArrowRight(props: IconProps) {
  return <svg {...shared} {...props}><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
}
export function CalendarDays(props: IconProps) {
  return <svg {...shared} {...props}><path d="M6 2v4m12-4v4M3 9h18M5 4h14a2 2 0 0 1 2 2v15H3V6a2 2 0 0 1 2-2Z" /><path d="M7 13h2m3 0h2m3 0h1M7 17h2m3 0h2" /></svg>;
}
export function Check(props: IconProps) {
  return <svg {...shared} {...props}><path d="m5 12 4 4L19 6" /></svg>;
}
export function LogOut(props: IconProps) {
  return <svg {...shared} {...props}><path d="M10 4H4v16h6m5-4 4-4-4-4m4 4H9" /></svg>;
}
export function Radio(props: IconProps) {
  return <svg {...shared} {...props}><circle cx="12" cy="12" r="2" /><path d="M7.8 7.8a6 6 0 0 0 0 8.4m8.4 0a6 6 0 0 0 0-8.4M4.2 4.2a11 11 0 0 0 0 15.6m15.6 0a11 11 0 0 0 0-15.6" /></svg>;
}
export function Shell(props: IconProps) {
  return <svg {...shared} {...props}><path d="M4 18c0-7 3.6-13 8-13s8 6 8 13H4Z" /><path d="M12 5v13M7.5 7.5 10 18m6.5-10.5L14 18M4 18h16" /></svg>;
}
export function Sparkles(props: IconProps) {
  return <svg {...shared} {...props}><path d="m12 3 1.4 4.1L17 9l-3.6 1.9L12 15l-1.4-4.1L7 9l3.6-1.9L12 3ZM5 15l.8 2.2L8 18l-2.2.8L5 21l-.8-2.2L2 18l2.2-.8L5 15Zm14-2 .8 2.2 2.2.8-2.2.8L19 19l-.8-2.2L16 16l2.2-.8L19 13Z" /></svg>;
}
export function Umbrella(props: IconProps) {
  return <svg {...shared} {...props}><path d="M3 12a9 9 0 0 1 18 0c-3-2-6-2-9 0-3-2-6-2-9 0Zm9 0v7a2 2 0 0 0 4 0" /></svg>;
}
export function Users(props: IconProps) {
  return <svg {...shared} {...props}><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2m1-15a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2" /></svg>;
}
export function Waves(props: IconProps) {
  return <svg {...shared} {...props}><path d="M2 8c2.5 2 4.5 2 7 0s4.5-2 7 0 4.5 2 6 0M2 13c2.5 2 4.5 2 7 0s4.5-2 7 0 4.5 2 6 0M2 18c2.5 2 4.5 2 7 0s4.5-2 7 0 4.5 2 6 0" /></svg>;
}
export function X(props: IconProps) {
  return <svg {...shared} {...props}><path d="m6 6 12 12M18 6 6 18" /></svg>;
}
