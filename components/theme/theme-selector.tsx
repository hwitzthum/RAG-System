"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_THEME,
  THEME_SCHEMES,
  THEME_STORAGE_KEY,
  THEMES,
  isThemeId,
  type ThemeId,
} from "@/lib/theme";

const THEME_CHANGE_EVENT = "rag-theme-change";

function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = THEME_SCHEMES[theme];

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage failures and keep the in-memory theme applied.
  }

  window.dispatchEvent(new CustomEvent<ThemeId>(THEME_CHANGE_EVENT, { detail: theme }));
}

function readActiveTheme(): ThemeId {
  const documentTheme = document.documentElement.dataset.theme;
  if (isThemeId(documentTheme)) {
    return documentTheme;
  }

  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeId(stored)) {
      return stored;
    }
  } catch {
    return DEFAULT_THEME;
  }

  return DEFAULT_THEME;
}

type ThemeSelectorProps = {
  className?: string;
};

export function ThemeSelector({ className = "" }: ThemeSelectorProps) {
  const [theme, setTheme] = useState<ThemeId>(DEFAULT_THEME);

  useEffect(() => {
    const syncTheme = (): void => {
      setTheme(readActiveTheme());
    };

    syncTheme();

    const handleStorage = (event: StorageEvent): void => {
      if (event.key === THEME_STORAGE_KEY) {
        syncTheme();
      }
    };

    const handleThemeChange = (event: Event): void => {
      const customEvent = event as CustomEvent<ThemeId>;
      if (isThemeId(customEvent.detail)) {
        setTheme(customEvent.detail);
      }
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener(THEME_CHANGE_EVENT, handleThemeChange);

    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(THEME_CHANGE_EVENT, handleThemeChange);
    };
  }, []);

  const activeTheme = THEMES.find((candidate) => candidate.id === theme) ?? THEMES[0];

  return (
    <div className={`theme-selector ${className}`.trim()}>
      <span className="theme-selector__label">Theme</span>
      <div className="theme-selector__field">
        <div className="theme-selector__swatches" aria-hidden="true">
          {activeTheme.preview.map((color) => (
            <span
              key={color}
              className="theme-selector__swatch"
              style={{ background: color }}
            />
          ))}
        </div>
        <select
          aria-label="Select application theme"
          className="theme-selector__select"
          data-testid="theme-selector"
          value={theme}
          onChange={(event) => {
            const nextTheme = event.target.value;
            if (!isThemeId(nextTheme)) {
              return;
            }
            setTheme(nextTheme);
            applyTheme(nextTheme);
          }}
        >
          {THEMES.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
