"use client";

import { useState, useEffect } from "react";
import { Video, defaultVideos } from "@/data/videos";

const LOCAL_STORAGE_KEY = "streamify_videos";

export function useVideos() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as Video[];
          // Merge default videos with stored videos, avoiding duplicates
          const merged = [...defaultVideos];
          parsed.forEach((customVideo) => {
            if (!merged.some((v) => v.id === customVideo.id)) {
              merged.push(customVideo);
            }
          });
          setVideos(merged);
        } catch (e) {
          console.error("Failed to parse stored videos", e);
          setVideos(defaultVideos);
        }
      } else {
        setVideos(defaultVideos);
      }
      setIsLoaded(true);
    }
  }, []);

  const addVideo = (newVideo: Video) => {
    const updated = [...videos, newVideo];
    setVideos(updated);
    if (typeof window !== "undefined") {
      // Only store custom uploaded videos in localStorage
      const customVideos = updated.filter(
        (v) => !defaultVideos.some((dv) => dv.id === v.id)
      );
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(customVideos));
    }
  };

  const resetVideos = () => {
    setVideos(defaultVideos);
    if (typeof window !== "undefined") {
      localStorage.removeItem(LOCAL_STORAGE_KEY);
    }
  };

  return {
    videos,
    isLoaded,
    addVideo,
    resetVideos,
  };
}
