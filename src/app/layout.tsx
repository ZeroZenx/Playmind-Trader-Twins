import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PlayMind Trader Twins",
  description: "Evidence-first policy testing on behavioral trader twins.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
