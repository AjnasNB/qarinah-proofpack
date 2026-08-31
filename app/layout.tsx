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
  title: "ProofGate | No proof. No action.",
  description: "A pre-action trust firewall that uses real Telegraph Miner signals, Qarinah evidence lineage, and Maqam policy to authorize, block, or escalate agent actions.",
  openGraph: {
    title: "ProofGate",
    description: "Make autonomous agents earn permission to act.",
    type: "website",
    images: [{
      url: "/images/proofpack-decision-gate.webp",
      width: 1536,
      height: 1024,
      alt: "ProofGate evidence authorization gate"
    }]
  },
  twitter: {
    card: "summary_large_image",
    title: "ProofGate",
    description: "No proof. No action.",
    images: ["/images/proofpack-decision-gate.webp"]
  },
  robots: {
    index: true,
    follow: true
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="font-[family-name:var(--font-geist-sans)] antialiased">{children}</body>
    </html>
  );
}
