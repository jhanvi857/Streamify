"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { useSession, signOut } from "@/lib/auth-client";

interface HeaderProps {
  onSearch?: (term: string) => void;
}

export default function Header({ onSearch }: HeaderProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [searchTerm, setSearchTerm] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);

  // Better Auth hooks
  const { data: session, isPending } = useSession();

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchTerm(value);
    if (onSearch) {
      onSearch(value);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    setShowDropdown(false);
    router.push("/");
    router.refresh();
  };

  // Helper to extract initials
  const getUserInitials = () => {
    if (!session?.user) return "G";
    const name = session.user.name || "";
    if (name) {
      const parts = name.split(" ");
      if (parts.length >= 2) {
        return (parts[0][0] + parts[1][0]).toUpperCase();
      }
      return name.slice(0, 2).toUpperCase();
    }
    return (session.user.email || "G").slice(0, 2).toUpperCase();
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

        {/* Profile Avatar / Login Button */}
        {isPending ? (
          // Loader skeleton
          <div className="h-8 w-8 rounded-full border border-dark-border bg-dark-hover animate-pulse" />
        ) : session ? (
          // Signed In user dropdown
          <div className="relative">
            <button
              onClick={() => setShowDropdown(!showDropdown)}
              className="h-8 w-8 rounded-full border border-brand-red/60 bg-brand-red/10 flex items-center justify-center text-xs font-bold text-brand-red select-none cursor-pointer hover:bg-brand-red/20 hover:scale-105 active:scale-95 transition-all"
            >
              {getUserInitials()}
            </button>

            {showDropdown && (
              <div className="absolute right-0 mt-2.5 w-48 rounded-xl bg-dark-card border border-dark-border p-2 shadow-2xl z-50 flex flex-col gap-1">
                <div className="px-3 py-2 border-b border-dark-border/40 text-left select-text">
                  <p className="text-xs font-bold text-white truncate">{session.user.name}</p>
                  <p className="text-[10px] text-gray-500 truncate mt-0.5">{session.user.email}</p>
                </div>

                <Link
                  href="/?tab=my-uploads"
                  onClick={() => setShowDropdown(false)}
                  className="flex items-center gap-2 px-3 py-2 text-[11px] text-gray-300 hover:text-white rounded-lg hover:bg-brand-red/5 transition-all text-left"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  My Uploads
                </Link>

                <button
                  onClick={handleSignOut}
                  className="flex items-center gap-2 px-3 py-2 text-[11px] text-red-400 hover:text-red-300 rounded-lg hover:bg-red-500/5 transition-all text-left cursor-pointer w-full"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                  </svg>
                  Sign Out
                </button>
              </div>
            )}
          </div>
        ) : (
          // Guest View -> show Sign In
          <Link
            href="/login"
            className="text-xs font-bold text-white bg-brand-red hover:bg-brand-red-hover px-4 py-2 rounded-lg shadow-lg shadow-brand-red/10 transition-colors"
          >
            Sign In
          </Link>
        )}
      </div>
    </header>
  );
}
