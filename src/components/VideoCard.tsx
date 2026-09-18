"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import { Video } from "@/data/videos";

interface VideoCardProps {
  video: Video;
  onDelete?: (id: string) => void;
}

// Category theme styling for YouTube-like posters
const categoryThemes: Record<
  string,
  {
    bgGradient: string;
    accentColor: string;
    badgeBg: string;
    badgeText: string;
    label: string;
  }
> = {
  demos: {
    bgGradient: "from-emerald-950 via-teal-950 to-neutral-950",
    accentColor: "text-emerald-400",
    badgeBg: "bg-emerald-500/15 border-emerald-500/30",
    badgeText: "text-emerald-400",
    label: "DEMO",
  },
  "system design": {
    bgGradient: "from-red-950 via-neutral-950 to-neutral-950",
    accentColor: "text-rose-400",
    badgeBg: "bg-red-500/15 border-red-500/30",
    badgeText: "text-rose-400",
    label: "SYSTEM ARCH",
  },
  tutorials: {
    bgGradient: "from-amber-950 via-orange-950 to-neutral-950",
    accentColor: "text-amber-400",
    badgeBg: "bg-amber-500/15 border-amber-500/30",
    badgeText: "text-amber-400",
    label: "TUTORIAL",
  },
  "dev talks": {
    bgGradient: "from-indigo-950 via-blue-950 to-neutral-950",
    accentColor: "text-blue-400",
    badgeBg: "bg-blue-500/15 border-blue-500/30",
    badgeText: "text-blue-400",
    label: "DEV TALK",
  },
  design: {
    bgGradient: "from-purple-950 via-fuchsia-950 to-neutral-950",
    accentColor: "text-purple-400",
    badgeBg: "bg-purple-500/15 border-purple-500/30",
    badgeText: "text-purple-400",
    label: "DESIGN",
  },
};

export default function VideoCard({ video, onDelete }: VideoCardProps) {
  const videoPreviewRef = useRef<HTMLVideoElement>(null);
  const [isVideoLoaded, setIsVideoLoaded] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  const theme =
    categoryThemes[video.tag] || {
      bgGradient: "from-neutral-900 via-neutral-950 to-black",
      accentColor: "text-brand-red",
      badgeBg: "bg-brand-red/15 border-brand-red/30",
      badgeText: "text-brand-red",
      icon: "▶",
      label: "STREAM",
    };

  const handleDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirm(`Are you sure you want to delete "${video.title}"?`)) {
      onDelete?.(video.id);
    }
  };

  const handleMouseEnter = () => {
    setIsHovered(true);
    if (videoPreviewRef.current && isVideoLoaded) {
      videoPreviewRef.current.play().catch(() => {});
    }
  };

  const handleMouseLeave = () => {
    setIsHovered(false);
    if (videoPreviewRef.current) {
      videoPreviewRef.current.pause();
      videoPreviewRef.current.currentTime = 0.5;
    }
  };

  const authorInitial = (video.author || "User").charAt(0).toUpperCase();

  return (
    <div
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className="relative group flex flex-col bg-dark-card border border-dark-border/60 hover:border-brand-red/40 rounded-2xl overflow-hidden transition-all duration-300 hover:shadow-2xl hover:shadow-brand-red/10 hover:-translate-y-0.5"
    >
      <Link href={`/watch/${video.id}`} className="flex flex-col grow">
        {/* Thumbnail Viewport */}
        <div className="relative aspect-video w-full bg-black overflow-hidden flex items-center justify-center">
          
          {/* 1. Real Video Snapshot & Silent Hover Preview */}
          {(video.manifestUrl || video.minioManifestUrl) && (
            <video
              ref={videoPreviewRef}
              src={`${video.manifestUrl || video.minioManifestUrl}#t=0.5`}
              preload="metadata"
              muted
              playsInline
              className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-500 z-10 ${
                isVideoLoaded ? "opacity-100" : "opacity-0"
              }`}
              onLoadedData={() => setIsVideoLoaded(true)}
            />
          )}

          {/* 2. YouTube-Style Themed Fallback Poster */}
          <div
            className={`absolute inset-0 bg-gradient-to-br ${theme.bgGradient} flex flex-col justify-between p-4 transition-transform duration-500 group-hover:scale-105`}
          >
            {/* Ambient Graphic Overlay Pattern */}
            <div className="absolute inset-0 opacity-20 bg-[radial-gradient(#ffffff_1px,transparent_1px)] [background-size:16px_16px] pointer-events-none" />
            <div className="absolute -top-10 -right-10 w-36 h-36 bg-white/5 rounded-full blur-2xl pointer-events-none" />

            {/* Top Bar: Topic Badge */}
            <div className="relative z-10 flex items-center justify-between">
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-mono font-bold tracking-wider uppercase border backdrop-blur-md ${theme.badgeBg} ${theme.badgeText} shadow-sm`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
                <span>{theme.label}</span>
              </span>

              {/* HD Indicator */}
              <span className="bg-black/60 backdrop-blur-md border border-white/10 text-white/90 text-[9px] font-mono font-bold px-1.5 py-0.5 rounded shadow">
                1080p HD
              </span>
            </div>

            {/* Center: YouTube Play Button Ring */}
            <div className="relative z-10 self-center flex items-center justify-center">
              <div className="h-12 w-12 rounded-full bg-black/60 backdrop-blur-md border border-white/20 flex items-center justify-center text-white group-hover:bg-brand-red group-hover:border-brand-red group-hover:scale-110 transition-all duration-300 shadow-xl">
                <svg className="h-5 w-5 translate-x-0.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
            </div>

            {/* Bottom Title Preview on Thumbnail */}
            <div className="relative z-10">
              <p className="text-xs font-semibold text-white/90 line-clamp-1 drop-shadow-md">
                {video.title}
              </p>
            </div>
          </div>

          {/* Delete Button Overlay */}
          {onDelete && (
            <button
              onClick={handleDelete}
              title="Delete Video"
              className="absolute top-2 right-2 z-20 h-7 w-7 rounded-full bg-black/80 hover:bg-brand-red text-gray-300 hover:text-white flex items-center justify-center transition-all opacity-0 group-hover:opacity-100 shadow-lg cursor-pointer"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          )}

          {/* Corner Duration Badge (Classic YouTube Pill) */}
          <span className="absolute bottom-2.5 right-2.5 z-20 bg-black/90 backdrop-blur-sm border border-white/10 px-2 py-0.5 rounded-md text-[11px] font-mono font-bold text-gray-100 shadow-md">
            {video.duration || "00:00"}
          </span>
        </div>

        {/* Video Card Metadata (Authentic YouTube Feed Layout) */}
        <div className="p-3.5 flex gap-3 grow">
          {/* Author Channel Avatar */}
          <div className="h-9 w-9 shrink-0 rounded-full bg-gradient-to-br from-brand-red to-orange-600 flex items-center justify-center font-bold text-white text-xs shadow-md">
            {authorInitial}
          </div>

          {/* Title and Metadata */}
          <div className="flex flex-col justify-between grow min-w-0">
            <div>
              <h3 className="text-sm font-semibold text-gray-100 group-hover:text-white line-clamp-2 leading-snug transition-colors duration-200">
                {video.title}
              </h3>

              <div className="mt-1 flex items-center gap-1.5 text-xs text-gray-400">
                <span className="truncate hover:text-gray-200 transition-colors">
                  {video.author || "Anonymous"}
                </span>
                <span>•</span>
                <span className="capitalize text-gray-500 font-medium">
                  {video.tag}
                </span>
              </div>
            </div>

            <div className="mt-2 flex items-center justify-between text-[11px] text-gray-500">
              <span>{video.views} • {video.date}</span>
              {video.visibility === "private" && (
                <span className="inline-flex items-center gap-1 text-yellow-400 bg-yellow-400/10 px-1.5 py-0.5 rounded text-[9px] font-bold border border-yellow-400/20 uppercase">
                  <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                  Private
                </span>
              )}
            </div>
          </div>
        </div>
      </Link>
    </div>
  );
}
