// API Client for YTStream / Streamify Go Backend

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/api";

export interface BackendVideo {
  id: string;
  title: string;
  description: string;
  category: string;
  visibility: "public" | "private";
  author_id: string | null;
  author_name?: string;
  minio_manifest_url?: string;
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
 * Fetch public video list from backend API
 */
export async function fetchVideosFromApi(): Promise<BackendVideo[] | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/videos`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (error) {
    console.warn("Backend API unreachable, falling back to local data:", error);
    return null;
  }
}

/**
 * Fetch video details by ID from backend API
 */
export async function fetchVideoByIdFromApi(id: string): Promise<BackendVideo | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/videos/${id}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (error) {
    console.warn(`Backend API unreachable for video ${id}, falling back to local data:`, error);
    return null;
  }
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
 * Initialize video upload session in Go backend (creates PG entry & gets MinIO presigned URL)
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
 * Direct HTTP PUT upload of video binary file to MinIO S3 Presigned URL
 */
export async function uploadFileToMinIO(
  uploadUrl: string,
  file: File,
  onProgress?: (percent: number) => void
): Promise<boolean> {
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

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(true);
      } else {
        console.error("MinIO upload failed status:", xhr.status, xhr.responseText);
        resolve(false);
      }
    };

    xhr.onerror = (err) => {
      console.error("MinIO upload error:", err);
      resolve(false);
    };

    xhr.send(file);
  });
}

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
