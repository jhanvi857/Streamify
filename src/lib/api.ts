// API Client for YTStream / Streamify Go Backend

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/api").replace(/\/+$/, "");

export interface BackendVideo {
  id: string;
  title: string;
  description: string;
  category: string;
  visibility: "public" | "private";
  author_id: string | null;
  author_name?: string;
  manifest_url?: string;
  duration: string;
  views_count: number;
  created_at: string;
}

export interface InitUploadRequest {
  title: string;
  description: string;
  category: string;
  visibility: "public" | "private";
  duration: string;
  author_id: string;
}

export interface InitUploadResponse {
  video_id: string;
  upload_url: string;
  object_name: string;
  raw_bucket: string;
}

export interface CompleteUploadRequest {
  video_id: string;
  object_name: string;
}

export interface CompleteUploadResponse {
  message: string;
  task_id: string;
  queue: string;
}

/**
 * Fetch public video list from backend API with automatic retry for server cold starts
 */
export async function fetchVideosFromApi(
  retries = 3,
  delayMs = 2500,
  onRetry?: (attempt: number) => void
): Promise<BackendVideo[] | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${API_BASE_URL}/videos`, {
        cache: "no-store",
      });
      if (res.ok) {
        return await res.json();
      }
      // If server returned 502/503/504 (standard during Render cold start container boot)
      if (res.status >= 500 && attempt < retries) {
        onRetry?.(attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      return null;
    } catch (error) {
      if (attempt < retries) {
        onRetry?.(attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      console.warn("Backend API unreachable, falling back to local data:", error);
      return null;
    }
  }
  return null;
}

/**
 * Fetch video details by ID from backend API with automatic retry for server cold starts
 */
export async function fetchVideoByIdFromApi(
  id: string,
  retries = 3,
  delayMs = 2000
): Promise<BackendVideo | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${API_BASE_URL}/videos/${id}`, {
        cache: "no-store",
      });
      if (res.ok) {
        return await res.json();
      }
      if (res.status >= 500 && attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      return null;
    } catch (error) {
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      console.warn(`Backend API unreachable for video ${id}, falling back to local data:`, error);
      return null;
    }
  }
  return null;
}

/**
 * Delete a video by ID from backend API
 */
export async function deleteVideoFromApi(id: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/videos/${id}`, {
      method: "DELETE",
    });
    return res.ok;
  } catch (error) {
    console.warn(`Backend API failed to delete video ${id}:`, error);
    return false;
  }
}

/**
 * Initialize video upload session in Go backend (creates PG entry & gets S3 presigned URL)
 */
export async function initVideoUpload(payload: InitUploadRequest): Promise<InitUploadResponse | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/videos/upload/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `Upload init failed with status ${res.status}`);
    }
    return await res.json();
  } catch (error) {
    console.warn("Failed to initialize backend upload:", error);
    return null;
  }
}

/**
 * Direct HTTP PUT upload of video binary file to S3-compatible storage (CloudWeave in dev, Neon / AWS S3 in prod),
 * with stream proxy upload fallback via the Go backend.
 */
export async function uploadFileToStorage(
  uploadUrl: string,
  file: File,
  objectName?: string,
  onProgress?: (percent: number) => void
): Promise<boolean> {
  // 1. High-performance stream upload via Go Backend proxy
  if (objectName) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_BASE_URL}/videos/upload/direct`, true);

      const formData = new FormData();
      formData.append("file", file);
      formData.append("object_name", objectName);

      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            onProgress(percent);
          }
        };
      }

      xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
      xhr.onerror = () => resolve(false);
      xhr.send(formData);
    });
  }

  // 2. Direct S3 Presigned PUT fallback
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl, true);
    xhr.setRequestHeader("Content-Type", file.type || "video/mp4");

    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const percent = Math.round((e.loaded / e.total) * 100);
          onProgress(percent);
        }
      };
    }

    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = () => resolve(false);
    xhr.send(file);
  });
}

// Aliases for compatibility
export const uploadFileToCloudWeave = uploadFileToStorage;

/**
 * Complete video upload and trigger transcoding task in Redis / Asynq worker
 */
export async function completeVideoUpload(payload: CompleteUploadRequest): Promise<CompleteUploadResponse | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/videos/upload/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `Upload completion failed with status ${res.status}`);
    }
    return await res.json();
  } catch (error) {
    console.warn("Failed to complete backend upload task:", error);
    return null;
  }
}

export interface TranscodeStatusResponse {
  video_id: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  error_message?: string;
  manifest_url?: string;
}

/**
 * Fetch real-time transcoding job status from backend PostgreSQL worker pipeline
 */
export async function fetchTranscodeStatus(videoId: string): Promise<TranscodeStatusResponse | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/videos/${videoId}/status`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (error) {
    console.warn(`Failed to fetch transcode status for video ${videoId}:`, error);
    return null;
  }
}

