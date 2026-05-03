import type { Metadata } from "next";
import { JetBrains_Mono, Orbitron, EB_Garamond } from "next/font/google";
import "./globals.css";
import SiteHeader from "./components/SiteHeader";
import SiteFooter from "./components/SiteFooter";

const mono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
});

const display = Orbitron({
  variable: "--font-orbitron",
  subsets: ["latin"],
});

const garamond = EB_Garamond({
  variable: "--font-garamond",
  subsets: ["latin"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "Cells Interlinked — field notes",
  description:
    "Field notes from a Voight-Kampff for language models. An interpretability research journal probing the hidden chain-of-thought of reasoning LLMs.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${mono.variable} ${display.variable} ${garamond.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <SiteHeader />
        <main className="flex-1 flex flex-col relative z-10">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
