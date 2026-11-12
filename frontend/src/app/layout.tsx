import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "AgentDock | Developer control plane",
  description: "Observe and govern AI coding agents from one developer control plane.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
