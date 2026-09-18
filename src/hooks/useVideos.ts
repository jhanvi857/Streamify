"use client";

import { useState, useEffect } from "react";
import { Video, defaultVideos } from "@/data/videos";
import { fetchVideosFromApi, deleteVideoFromApi, BackendVideo } from "@/lib/api";

const LOCAL_STORAGE_KEY = "streamify_videos";

export function useVideos() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    async function loadVideos() {
      // 1. Fetch real videos from Go Backend API
      const backendVideos = await fetchVideosFromApi();
      if (backendVideos && backendVideos.length > 0) {
        const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/api";
        const loaded: Video[] = backendVideos.map((bv: BackendVideo) => ({
          id: bv.id,
          title: bv.title,
          description: bv.description || "",
          tag: (bv.category as Video["tag"]) || "system design",
          author: bv.author_name || "Anonymous",
          views: `${bv.views_count || 0} views`,
          date: new Date(bv.created_at).toLocaleDateString(),
          duration: bv.duration || "00:00",
          visibility: bv.visibility || "public",
          minioManifestUrl: bv.minio_manifest_url
            ? `${apiBaseUrl}/videos/${bv.id}/stream`
            : undefined,
        }));

        setVideos(loaded);
        setIsLoaded(true);
        if (typeof window !== "undefined") {
          localStorage.removeItem(LOCAL_STORAGE_KEY);
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

      setVideos(currentList);
      setIsLoaded(true);
    }

    loadVideos();
  }, []);

  const addVideo = (newVideo: Video) => {
    const updated = [newVideo, ...videos];
    setVideos(updated);
    if (typeof window !== "undefined") {
      const customVideos = updated.filter(
        (v) => !defaultVideos.some((dv) => dv.id === v.id)
      );
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(customVideos));
    }
  };

  const deleteVideo = async (id: string) => {
    // 1. Remove from React state immediately for snappy UI
    setVideos((prev) => prev.filter((v) => v.id !== id));

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
    }
  };

  return {
    videos,
    isLoaded,
    addVideo,
    deleteVideo,
    resetVideos,
  };
}

