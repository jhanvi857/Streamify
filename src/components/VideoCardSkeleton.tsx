"use client";

export default function VideoCardSkeleton() {
  return (
    <div className="flex flex-col bg-dark-card border border-dark-border/60 rounded-2xl overflow-hidden">
      {/* Thumbnail Viewport Skeleton */}
      <div className="relative aspect-video w-full bg-neutral-900 overflow-hidden flex flex-col justify-between p-4 animate-pulse">
        {/* Shimmer gradient line */}
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.03] to-transparent animate-pulse" />

        {/* Top Badges */}
        <div className="relative z-10 flex items-center justify-between">
          <div className="h-5 w-24 bg-neutral-800/80 rounded-md" />
          <div className="h-4 w-14 bg-neutral-800/60 rounded" />
        </div>

        {/* Center Play Button Placeholder */}
        <div className="relative z-10 self-center h-12 w-12 rounded-full bg-neutral-800/70 border border-neutral-700/40 flex items-center justify-center">
          <div className="h-4 w-4 bg-neutral-700/60 rounded-sm" />
        </div>

        {/* Bottom Title Bar on Thumbnail */}
        <div className="relative z-10">
          <div className="h-3.5 w-3/4 bg-neutral-800/70 rounded" />
        </div>
      </div>

      {/* Video Details Card Footer */}
      <div className="p-4 flex gap-3 items-start animate-pulse">
        {/* Creator Avatar Skeleton */}
        <div className="h-8 w-8 rounded-full bg-neutral-800 shrink-0 mt-0.5" />

        <div className="flex flex-col grow gap-2">
          {/* Title Lines */}
          <div className="h-3.5 w-5/6 bg-neutral-800 rounded" />
          <div className="h-3 w-1/2 bg-neutral-800/60 rounded" />

          {/* Author & Stats Line */}
          <div className="flex items-center gap-2 mt-1">
            <div className="h-2.5 w-16 bg-neutral-800/60 rounded" />
            <div className="h-1 w-1 rounded-full bg-neutral-700" />
            <div className="h-2.5 w-14 bg-neutral-800/40 rounded" />
            <div className="h-1 w-1 rounded-full bg-neutral-700" />
            <div className="h-2.5 w-12 bg-neutral-800/40 rounded" />
          </div>
        </div>
      </div>
    </div>
  );
}
