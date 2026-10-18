import {
  Code2,
  ShieldCheck,
  PanelsTopLeft,
  PenTool,
  GraduationCap,
  Video,
  Store,
  Megaphone,
  BriefcaseBusiness,
  Rocket,
  Scale,
  Ellipsis,
  type LucideIcon,
} from "lucide-react";

export const occupations = [
  "developer",
  "independent",
  "infrastructure",
  "product",
  "design",
  "student",
  "finance",
  "creator",
  "operations",
  "marketing",
  "legal",
  "other",
] as const;

export type OccupationValue = (typeof occupations)[number];

/** Icons for the step-2 mode choice: coding / office. */
export const modeOptionIcons = {
  coding: Code2,
  office: PanelsTopLeft,
} as const;

const occupationIcons = [
  Code2,
  Rocket,
  ShieldCheck,
  PanelsTopLeft,
  PenTool,
  GraduationCap,
  BriefcaseBusiness,
  Video,
  Store,
  Megaphone,
  Scale,
  Ellipsis,
];

export function getOccupationIcon(index: number): LucideIcon {
  return occupationIcons[index] ?? Ellipsis;
}
