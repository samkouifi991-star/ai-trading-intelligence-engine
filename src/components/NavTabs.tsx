"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/day", label: "Day Trading" },
  { href: "/swing", label: "Swing Trading" },
  { href: "/status", label: "Live Data Status" },
];

export default function NavTabs() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 rounded-lg border border-border bg-panel2 p-1">
      {TABS.map((tab) => {
        const active = pathname?.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              active ? "bg-accent text-black" : "text-gray-300 hover:bg-panel"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
