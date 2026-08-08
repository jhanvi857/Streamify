"use client";

import Link from "next/link";
import { Video } from "@/data/videos";

interface VideoCardProps {
  video: Video;
  onDelete?: (id: string) => void;
}

export default function VideoCard({ video, onDelete }: VideoCardProps) {
  const handleDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirm(`Are you sure you want to delete "${video.title}"?`)) {
      onDelete?.(video.id);
    }
  };

  return (
    <div className="relative group flex flex-col bg-dark-card border border-dark-border/60 hover:border-brand-red/30 rounded-xl overflow-hidden transition-all duration-300 hover:shadow-xl hover:shadow-brand-red/5">
      <Link href={`/watch/${video.id}`} className="flex flex-col grow">
        {/* Thumbnail */}
        <div className="relative aspect-video w-full bg-neutral-900 flex items-center justify-center overflow-hidden">
          {/* Mock background pattern */}
          <div className="absolute inset-0 opacity-10 bg-radial-gradient from-brand-red to-transparent group-hover:scale-105 transition-transform duration-500" />
          
          {/* Play Button Icon */}
          <div className="relative z-10 flex h-12 w-12 items-center justify-center rounded-full bg-brand-red/10 border border-brand-red/35 group-hover:bg-brand-red group-hover:scale-110 transition-all duration-300">
            <svg
              className="h-5 w-5 text-brand-red group-hover:text-white transition-colors"
              fill="currentColor"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>

          {/* Delete button overlay */}
          {onDelete && (
            <button
              onClick={handleDelete}
              title="Delete Video"
              className="absolute top-2 right-2 z-20 h-7 w-7 rounded-full bg-black/70 hover:bg-red-600 text-gray-300 hover:text-white flex items-center justify-center transition-colors shadow"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          )}

          {/* Time Stamp */}
          <span className="absolute bottom-2 right-2 bg-black/80 px-2 py-0.5 rounded text-[10px] font-bold text-gray-200 tracking-wider">
            {video.duration}
          </span>
        </div>

        {/* Details */}
        <div className="p-4 flex flex-col justify-between grow">
          <div>
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-sm font-semibold text-gray-100 group-hover:text-white line-clamp-2 transition-colors duration-200 leading-tight">
                {video.title}
              </h3>
            </div>
            
            <div className="mt-2 flex items-center justify-between text-xs text-gray-400">
              <span className="font-medium truncate">{video.author}</span>
              {/* Category tag pill */}
              <span className="bg-brand-red/10 border border-brand-red/25 text-brand-red text-[10px] px-2 py-0.5 rounded font-semibold tracking-wide uppercase select-none">
                {video.tag}
              </span>
            </div>
          </div>

          <div className="mt-3 pt-3 border-t border-dark-border/40 flex items-center justify-between text-[11px] text-gray-500">
            <span>{video.views} · {video.date}</span>
            {video.visibility === "private" && (
              <span className="flex items-center gap-1 text-yellow-500/80 bg-yellow-500/5 px-2 py-0.5 rounded border border-yellow-500/20 text-[9px] font-bold">
                <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                PRIVATE
              </span>
            )}
          </div>
        </div>
      </Link>
    </div>
  );
}
