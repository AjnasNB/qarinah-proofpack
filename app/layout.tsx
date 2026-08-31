import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  display: "swap"
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap"
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.PROOFPACK_PUBLIC_URL || "http://localhost:3000"),
  title: "Qarinah ProofPack | Verifiable research intelligence",
  description: "Evidence-backed, hash-verifiable fact checks and research synthesis for autonomous agents.",
  openGraph: {
    title: "Qarinah ProofPack",
    description: "Autonomous agents should act on evidence, not plausible prose.",
    type: "website"
  },
  robots: {
    index: true,
    follow: true
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="font-[family-name:var(--font-geist-sans)] antialiased">{children}</body>
    </html>
  );
}
