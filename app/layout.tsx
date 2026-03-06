import type { Metadata } from "next";
import "./globals.css";
import { env } from "@/lib/config/env";

export const metadata: Metadata = {
  title: "RAG System",
  description: "Production-ready multilingual RAG system scaffold.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Force startup-time validation in the Next.js runtime.
  void env;

  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
