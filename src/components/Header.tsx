"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

interface HeaderProps {
  onSearch?: (term: string) => void;
}

export default function Header({ onSearch }: HeaderProps) {
  const pathname = usePathname();
  const [searchTerm, setSearchTerm] = useState("");

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchTerm(value);
    if (onSearch) {
      onSearch(value);
    }
  };

  return (
    <header className="sticky top-0 z-40 w-full border-b border-dark-border bg-dark-base/95 backdrop-blur-md px-6 py-4 flex items-center justify-between">
      {/* Logo */}
      <div className="flex items-center gap-2">
        <Link href="/" className="text-xl font-bold tracking-tight text-white flex items-center">
          stream<span className="text-brand-red font-extrabold ml-0.5">ify</span>
        </Link>
      </div>

      {/* Navigation Links */}
      <nav className="hidden md:flex items-center gap-8 text-sm font-medium">
        <Link
          href="/"
          className={`transition-colors hover:text-white ${
            pathname === "/" ? "text-white border-b-2 border-brand-red pb-1" : "text-gray-400"
          }`}
        >
          feed
        </Link>
        <Link
          href="/?tab=trending"
          className={`transition-colors hover:text-white ${
            pathname === "/trending" ? "text-white border-b-2 border-brand-red pb-1" : "text-gray-400"
          }`}
        >
          trending
        </Link>
        <Link
          href="/?tab=my-uploads"
          className={`transition-colors hover:text-white ${
            pathname === "/my-uploads" ? "text-white border-b-2 border-brand-red pb-1" : "text-gray-400"
          }`}
        >
          my uploads
        </Link>
      </nav>

      {/* Search and Action Bar */}
      <div className="flex items-center gap-4">
        {/* Search Input */}
        <div className="relative max-w-xs sm:max-w-sm">
          <input
            type="text"
            placeholder="Search system design..."
            value={searchTerm}
            onChange={handleSearchChange}
            className="w-full bg-dark-card border border-dark-border text-white text-xs rounded-full px-4 py-2 pl-9 focus:outline-none focus:border-brand-red transition-all placeholder:text-gray-500"
          />
          <svg
            className="absolute left-3 top-2.5 h-3.5 w-3.5 text-gray-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>

        {/* Upload Button */}
        <Link
          href="/upload"
          className="flex items-center gap-1.5 border border-brand-red/40 hover:border-brand-red text-white text-xs font-semibold px-4 py-2 rounded-lg bg-transparent hover:bg-brand-red/10 transition-all duration-200"
        >
          <svg
            className="h-3.5 w-3.5 text-brand-red"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2.5}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
            />
          </svg>
          <span className="hidden sm:inline">upload</span>
        </Link>

        {/* Profile initials */}
        <div className="h-8 w-8 rounded-full border border-dark-border bg-dark-hover flex items-center justify-center text-xs font-bold text-gray-300 select-none">
          JH
        </div>
      </div>
    </header>
  );
}
