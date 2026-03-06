import type { Metadata } from "next";
import "./globals.css";
import { env } from "@/lib/config/env";

export const metadata: Metadata = {
  title: "Enterprise Retrieval Command Center",
  description: "Professional workspace for secure retrieval operations and evidence-grounded AI responses.",
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
      <body className="text-slate-900 antialiased">{children}</body>
    </html>
  );
}
