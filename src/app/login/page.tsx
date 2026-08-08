"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { signIn, signUp } from "@/lib/auth-client";

export default function LoginPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<"signin" | "signup">("signin");
  
  // Form values
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  
  // Loading & error states
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMsg("");

    try {
      if (activeTab === "signin") {
        // Better Auth Sign In
        const { error } = await signIn.email({
          email,
          password,
          callbackURL: "/"
        });
        if (error) {
          setErrorMsg(error.message || "Failed to log in. Check your credentials.");
        } else {
          router.push("/");
          router.refresh();
        }
      } else {
        // Better Auth Sign Up
        const { error } = await signUp.email({
          email,
          password,
          name,
          callbackURL: "/"
        });
        if (error) {
          setErrorMsg(error.message || "Failed to create account. Try again.");
        } else {
          router.push("/");
          router.refresh();
        }
      }
    } catch (err: any) {
      setErrorMsg(err.message || "An unexpected error occurred.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-dark-base text-gray-100 flex flex-col items-center justify-center p-6 select-none">
      
      {/* Back to Home link */}
      <Link href="/" className="absolute top-6 left-6 text-xs text-gray-400 hover:text-white flex items-center gap-1">
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
        </svg>
        Back to Feed
      </Link>

      <div className="w-full max-w-md bg-dark-card border border-dark-border rounded-2xl p-6 sm:p-8 flex flex-col gap-6 shadow-2xl">
        
        {/* Brand header */}
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight text-white">
            stream<span className="text-brand-red font-extrabold ml-0.5">ify</span>
          </h1>
          <p className="text-[11px] text-gray-400 mt-1.5 font-medium">
            Learn video streaming system design with hands-on labs.
          </p>
        </div>

        {/* Auth Mode Tabs */}
        <div className="flex bg-black border border-dark-border p-1 rounded-lg">
          <button
            onClick={() => {
              setActiveTab("signin");
              setErrorMsg("");
            }}
            className={`flex-1 py-2 text-xs font-bold rounded-md transition-colors cursor-pointer ${
              activeTab === "signin"
                ? "bg-brand-red text-white"
                : "text-gray-400 hover:text-white"
            }`}
          >
            Sign In
          </button>
          <button
            onClick={() => {
              setActiveTab("signup");
              setErrorMsg("");
            }}
            className={`flex-1 py-2 text-xs font-bold rounded-md transition-colors cursor-pointer ${
              activeTab === "signup"
                ? "bg-brand-red text-white"
                : "text-gray-400 hover:text-white"
            }`}
          >
            Create Account
          </button>
        </div>

        {/* Error notification */}
        {errorMsg && (
          <div className="bg-red-950/20 border border-red-500/20 text-red-400 text-[11px] font-bold p-3 rounded-lg leading-normal flex items-start gap-2">
            <svg className="h-4 w-4 text-red-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Form elements */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          
          {/* Name Field (Only on Sign Up) */}
          {activeTab === "signup" && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-bold text-gray-300 uppercase tracking-wide">Display Name</label>
              <input
                type="text"
                required
                placeholder="e.g. John Doe"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="bg-black border border-dark-border text-white text-xs rounded-lg p-3 focus:outline-none focus:border-brand-red transition-colors placeholder:text-gray-600 font-semibold"
              />
            </div>
          )}

          {/* Email Field */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] font-bold text-gray-300 uppercase tracking-wide">Email Address</label>
            <input
              type="email"
              required
              placeholder="e.g. coder@systemdesign.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="bg-black border border-dark-border text-white text-xs rounded-lg p-3 focus:outline-none focus:border-brand-red transition-colors placeholder:text-gray-600 font-semibold"
            />
          </div>

          {/* Password Field */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] font-bold text-gray-300 uppercase tracking-wide">Password</label>
            <input
              type="password"
              required
              minLength={6}
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="bg-black border border-dark-border text-white text-xs rounded-lg p-3 focus:outline-none focus:border-brand-red transition-colors placeholder:text-gray-600 font-semibold"
            />
          </div>

          {/* Action button */}
          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-brand-red hover:bg-brand-red-hover disabled:bg-red-850/50 text-white font-bold py-3.5 rounded-lg text-xs tracking-wide cursor-pointer transition-colors shadow-lg shadow-brand-red/15 select-none mt-2 flex items-center justify-center gap-2"
          >
            {isLoading && (
              <div className="h-3.5 w-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            )}
            {activeTab === "signin" ? "Sign In to Streamify" : "Register Account"}
          </button>

        </form>

      </div>

    </div>
  );
}
