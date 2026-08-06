export const THEME_STORAGE_KEY = "rag.workspace.theme";
export const DEFAULT_THEME = "light" as const;

export type ThemeDefinition = {
  id: string;
  label: string;
  description: string;
  scheme: "light" | "dark";
  preview: [string, string, string];
};

/**
 * The two Rautaki surfaces. The brand is a single identity — these are the
 * light and dark renderings of it, not alternative palettes. Both are gold
 * accented; only the ground changes.
 *
 * The ids stay `light` / `dark` because they drive the `[data-theme=…]`
 * selectors in globals.css and the `color-scheme` declaration.
 */
export const THEMES = [
  {
    id: "light",
    label: "Cream",
    description: "Cream ground with ink type — the default Rautaki surface.",
    scheme: "light",
    preview: ["#f4f2ee", "#f5a623", "#e8e5df"],
  },
  {
    id: "dark",
    label: "Obsidian",
    description: "Obsidian ground built for long sessions.",
    scheme: "dark",
    preview: ["#0a0a0a", "#f5a623", "#1c1c1c"],
  },
] as const satisfies readonly ThemeDefinition[];

export type ThemeId = (typeof THEMES)[number]["id"];

export function isThemeId(value: string | null | undefined): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

export const THEME_SCHEMES: Record<ThemeId, "light" | "dark"> =
  Object.fromEntries(THEMES.map((theme) => [theme.id, theme.scheme])) as Record<
    ThemeId,
    "light" | "dark"
  >;

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
