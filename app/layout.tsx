import type { Metadata } from "next";
import localFont from "next/font/local";
import { getThemeInitScript } from "@/lib/theme";
import "./globals.css";

// DM Sans carries all UI copy. Georgia — the display face — is a system serif
// and is declared as --font-serif in globals.css, so it needs no loader.
// Both families are self-hosted (latin subset, SIL OFL 1.1) so builds never
// depend on fonts.googleapis.com being reachable.
const dmSans = localFont({
  src: [
    { path: "./fonts/dm-sans-latin-300-normal.woff2", weight: "300", style: "normal" },
    { path: "./fonts/dm-sans-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/dm-sans-latin-500-normal.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-sans",
  display: "swap",
});

const jetbrainsMono = localFont({
  src: "./fonts/jetbrains-mono-latin-wght-normal.woff2",
  weight: "100 800",
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Rautaki · RAG Workspace",
  description:
    "Professional workspace for secure retrieval operations and evidence-grounded AI responses.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${dmSans.variable} ${jetbrainsMono.variable}`}
    >
      <body className="antialiased">
        <script dangerouslySetInnerHTML={{ __html: getThemeInitScript() }} />
        {children}
      </body>
    </html>
  );
}
