"use client";

import { useState, useEffect } from "react";
import { Video, defaultVideos } from "@/data/videos";
import { fetchVideosFromApi, deleteVideoFromApi, BackendVideo } from "@/lib/api";

const LOCAL_STORAGE_KEY = "streamify_videos";
const CACHED_FEED_KEY = "streamify_cached_feed";

export function useVideos() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isServerWakingUp, setIsServerWakingUp] = useState(false);

  // Initialize cached videos from localStorage immediately if available (0ms cold start latency)
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        const cached = localStorage.getItem(CACHED_FEED_KEY);
        if (cached) {
          const parsed = JSON.parse(cached) as Video[];
          if (Array.isArray(parsed) && parsed.length > 0) {
            setVideos(parsed);
          }
        }
      } catch (e) {
        console.warn("Failed to load cached feed from localStorage", e);
      }
    }
  }, []);

  const loadVideos = async () => {
    // Flag cold start waking if request takes more than 1.5 seconds
    const coldStartTimer = setTimeout(() => {
      setIsServerWakingUp(true);
    }, 1500);

    try {
      // 1. Fetch real videos from Go Backend API with cold start retries
      const backendVideos = await fetchVideosFromApi(4, 2500, () => {
        setIsServerWakingUp(true);
      });

      clearTimeout(coldStartTimer);
      setIsServerWakingUp(false);

      if (backendVideos && backendVideos.length > 0) {
        const apiBaseUrl = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/api").replace(/\/+$/, "");
        const loaded: Video[] = backendVideos.map((bv: BackendVideo) => {
          const rawUrl = bv.manifest_url;
          const streamUrl = rawUrl
            ? `${apiBaseUrl}/videos/${bv.id}/stream${
                rawUrl.includes("master.m3u8") || rawUrl.startsWith("hls/")
                  ? "/master.m3u8"
                  : ""
              }`
            : undefined;

          return {
            id: bv.id,
            title: bv.title,
            description: bv.description || "",
            tag: (bv.category as Video["tag"]) || "system design",
            author: bv.author_name || "Anonymous",
            views: `${bv.views_count || 0} views`,
            date: new Date(bv.created_at).toLocaleDateString(),
            duration: bv.duration || "00:00",
            visibility: bv.visibility || "public",
            manifestUrl: streamUrl,
          };
        });

        setVideos(loaded);
        setIsLoaded(true);

        // Cache loaded videos in localStorage for instant rendering on future visits
        if (typeof window !== "undefined") {
          try {
            localStorage.setItem(CACHED_FEED_KEY, JSON.stringify(loaded));
          } catch (e) {
            console.warn("Failed to save feed cache", e);
          }
        }
        return;
      }

      // 2. Fallback to localStorage / defaultVideos if backend is empty/offline
      let currentList: Video[] = [...defaultVideos];
      if (typeof window !== "undefined") {
        const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
        if (stored) {
          try {
            const parsed = JSON.parse(stored) as Video[];
            parsed.forEach((customVideo) => {
              if (!currentList.some((v) => v.id === customVideo.id)) {
                currentList.push(customVideo);
              }
            });
          } catch (e) {
            console.error("Failed to parse stored videos", e);
          }
        }
      }

      setVideos((prev) => (prev.length > 0 ? prev : currentList));
      setIsLoaded(true);
    } catch (err) {
      clearTimeout(coldStartTimer);
      setIsServerWakingUp(false);
      setIsLoaded(true);
    }
  };

  useEffect(() => {
    loadVideos();
  }, []);

  const refreshVideos = async () => {
    setIsLoaded(false);
    await loadVideos();
  };

  const addVideo = (newVideo: Video) => {
    const updated = [newVideo, ...videos];
    setVideos(updated);
    if (typeof window !== "undefined") {
      const customVideos = updated.filter(
        (v) => !defaultVideos.some((dv) => dv.id === v.id)
      );
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(customVideos));
      localStorage.setItem(CACHED_FEED_KEY, JSON.stringify(updated));
    }
  };

  const deleteVideo = async (id: string) => {
    // 1. Remove from React state immediately for snappy UI
    setVideos((prev) => {
      const filtered = prev.filter((v) => v.id !== id);
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem(CACHED_FEED_KEY, JSON.stringify(filtered));
        } catch (e) {}
      }
      return filtered;
    });

    // 2. Call backend API delete endpoint
    await deleteVideoFromApi(id);

    // 3. Remove from localStorage if present
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (stored) {
        try {
          const parsed = (JSON.parse(stored) as Video[]).filter((v) => v.id !== id);
          localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(parsed));
        } catch (e) {
          console.error("Failed to update stored videos after delete", e);
        }
      }
    }
  };

  const resetVideos = () => {
    setVideos(defaultVideos);
    if (typeof window !== "undefined") {
      localStorage.removeItem(LOCAL_STORAGE_KEY);
      localStorage.removeItem(CACHED_FEED_KEY);
    }
  };

  return {
    videos,
    isLoaded,
    isServerWakingUp,
    refreshVideos,
    addVideo,
    deleteVideo,
    resetVideos,
  };
}

