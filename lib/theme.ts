export const THEME_STORAGE_KEY = "rag.workspace.theme";
export const DEFAULT_THEME = "light" as const;

export type ThemeDefinition = {
  id: string;
  label: string;
  description: string;
  scheme: "light" | "dark";
  preview: [string, string, string];
};

export const THEMES = [
  {
    id: "light",
    label: "Light",
    description: "Bright neutral workspace with indigo accents.",
    scheme: "light",
    preview: ["#f8fafc", "#4f46e5", "#cbd5e1"],
  },
  {
    id: "dark",
    label: "Dark",
    description: "Charcoal workspace built for long sessions.",
    scheme: "dark",
    preview: ["#0f172a", "#60a5fa", "#334155"],
  },
  {
    id: "ocean",
    label: "Ocean",
    description: "Deep blue and teal palette with cool contrast.",
    scheme: "dark",
    preview: ["#082f49", "#14b8a6", "#38bdf8"],
  },
  {
    id: "forest",
    label: "Forest",
    description: "Mossy greens and warm bark tones.",
    scheme: "dark",
    preview: ["#17261d", "#22c55e", "#a3e635"],
  },
  {
    id: "sunset",
    label: "Sunset",
    description: "Warm clay and amber palette for a softer glow.",
    scheme: "light",
    preview: ["#fff7ed", "#ea580c", "#f59e0b"],
  },
] as const satisfies readonly ThemeDefinition[];

export type ThemeId = (typeof THEMES)[number]["id"];

export function isThemeId(value: string | null | undefined): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

export const THEME_SCHEMES: Record<ThemeId, "light" | "dark"> = Object.fromEntries(
  THEMES.map((theme) => [theme.id, theme.scheme]),
) as Record<ThemeId, "light" | "dark">;

export function getThemeInitScript(): string {
  return `
(() => {
  const storageKey = ${JSON.stringify(THEME_STORAGE_KEY)};
  const fallback = ${JSON.stringify(DEFAULT_THEME)};
  const schemes = ${JSON.stringify(THEME_SCHEMES)};
  const applyTheme = (theme) => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = schemes[theme] || "light";
  };

  try {
    const stored = window.localStorage.getItem(storageKey);
    applyTheme(stored && stored in schemes ? stored : fallback);
  } catch {
    applyTheme(fallback);
  }
})();
  `.trim();
}
