"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function Nav() {
  const pathname = usePathname();

  return (
    <div className="fixed top-4 right-4 z-50 flex gap-2">
      <Link
        href="/"
        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
          pathname === "/"
            ? "bg-blue-600 text-white"
            : "bg-gray-800 text-gray-400 hover:text-white"
        }`}
      >
        Curator
      </Link>
      <Link
        href="/preview"
        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
          pathname === "/preview"
            ? "bg-blue-600 text-white"
            : "bg-gray-800 text-gray-400 hover:text-white"
        }`}
      >
        Preview
      </Link>
    </div>
  );
}
