import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { getThemeInitScript } from "@/lib/theme";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "RAG Workspace",
  description: "Professional workspace for secure retrieval operations and evidence-grounded AI responses.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="antialiased">
        <script dangerouslySetInnerHTML={{ __html: getThemeInitScript() }} />
        {children}
      </body>
    </html>
  );
}
