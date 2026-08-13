"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import Link from "next/link";
import { useVideos } from "@/hooks/useVideos";
import { Video } from "@/data/videos";
import { useSession } from "@/lib/auth-client";
import { initVideoUpload, uploadFileToMinIO, completeVideoUpload, fetchTranscodeStatus } from "@/lib/api";

export default function UploadPage() {
  const router = useRouter();
  const { addVideo } = useVideos();
  const { data: session, isPending } = useSession();

  // Route protection
  useEffect(() => {
    if (!isPending && !session) {
      router.push("/login");
    }
  }, [session, isPending, router]);

  // Form states
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<Video["tag"]>("system design");
  const [visibility, setVisibility] = useState<Video["visibility"]>("public");
  const [duration, setDuration] = useState("03:15"); // default mock length

  // File drag states
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Simulation states
  const [isSimulating, setIsSimulating] = useState(false);
  const [simStep, setSimStep] = useState<"upload" | "redis" | "ffmpeg" | "manifest" | "completed">("upload");
  const [uploadError, setUploadError] = useState<string | null>(null);
  
  // Pipeline details
  const [uploadProgress, setUploadProgress] = useState(0);
  const [redisLogs, setRedisLogs] = useState<string[]>([]);
  const [ffmpegLogs, setFfmpegLogs] = useState<string[]>([]);
  const [transcodeProgress, setTranscodeProgress] = useState({ p360: 0, p720: 0, p1080: 0 });
  const [generatedManifests, setGeneratedManifests] = useState<string[]>([]);
  
  // Complete video configuration
  const [finishedVideoId, setFinishedVideoId] = useState("");

  // Extract actual media duration from chosen video file
  const extractVideoDuration = (videoFile: File) => {
    try {
      const tempVideo = document.createElement("video");
      tempVideo.preload = "metadata";
      tempVideo.onloadedmetadata = () => {
        window.URL.revokeObjectURL(tempVideo.src);
        const totalSec = Math.floor(tempVideo.duration);
        if (isNaN(totalSec) || !isFinite(totalSec)) return;

        const hrs = Math.floor(totalSec / 3600);
        const mins = Math.floor((totalSec % 3600) / 60);
        const secs = totalSec % 60;

        let formatted = "";
        if (hrs > 0) {
          formatted = `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
        } else {
          formatted = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
        }
        setDuration(formatted);
      };
      tempVideo.src = URL.createObjectURL(videoFile);
    } catch (err) {
      console.warn("Could not calculate video duration:", err);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const selected = e.dataTransfer.files[0];
      setFile(selected);
      extractVideoDuration(selected);
      // Auto-set title if empty
      if (!title) {
        const nameWithoutExt = selected.name.replace(/\.[^/.]+$/, "");
        setTitle(nameWithoutExt);
      }
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selected = e.target.files[0];
      setFile(selected);
      extractVideoDuration(selected);
      if (!title) {
        const nameWithoutExt = selected.name.replace(/\.[^/.]+$/, "");
        setTitle(nameWithoutExt);
      }
    }
  };

  // Run the full ingestion/transcode pipeline (Real Go API + Worker polling, with simulator fallback)
  const startIngestionPipeline = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !file) return;

    setIsSimulating(true);
    setSimStep("upload");
    setUploadProgress(0);
    setUploadError(null);
    setRedisLogs([]);
    setFfmpegLogs([]);
    setTranscodeProgress({ p360: 0, p720: 0, p1080: 0 });
    setGeneratedManifests([]);

    const authorId = session?.user?.id || "anonymous-user";

    // Step 1: Initialize Upload in Go API & MinIO
    const initRes = await initVideoUpload({
      title,
      description,
      category,
      visibility,
      duration,
      author_id: authorId,
    });

    if (initRes && initRes.upload_url) {
      setFinishedVideoId(initRes.video_id);

      // Step 2: Upload File to MinIO S3 Presigned URL
      const uploadSuccess = await uploadFileToMinIO(
        initRes.upload_url,
        file,
        (percent) => setUploadProgress(percent)
      );

      if (!uploadSuccess) {
        setUploadError("MinIO Upload Failure: Could not upload file binary to Object Storage raw bucket.");
        return;
      }

      setUploadProgress(100);

      // Step 3: Complete upload and enqueue task in Redis / Asynq
      const completeRes = await completeVideoUpload({
        video_id: initRes.video_id,
        object_name: initRes.object_name,
      });

      if (!completeRes) {
        setUploadError("Backend API Error: Failed to finalize upload session or enqueue task in Redis.");
        return;
      }

      // Step 4: Start polling real Go Worker transcode job status
      startRealTranscodePolling(initRes.video_id);
      return;
    }

    // Fallback simulation loop if Go Backend API is offline
    setRedisLogs(["NOTICE: Backend API offline. Running local visual simulator..."]);
    const uploadInterval = setInterval(() => {
      setUploadProgress((prev) => {
        if (prev >= 100) {
          clearInterval(uploadInterval);
          triggerRedisStep();
          return 100;
        }
        return prev + 8;
      });
    }, 150);
  };

  // Real Transcode Status Poller
  const startRealTranscodePolling = (videoId: string) => {
    setSimStep("redis");
    setRedisLogs([
      "GO API SERVER: File upload finalized. Writing PostgreSQL row (status = 'pending')...",
      `ASYNQ CLIENT: Task 'video:transcode' enqueued to Redis queue 'default' [video_id: ${videoId}]`,
    ]);

    const pollInterval = setInterval(async () => {
      const statusRes = await fetchTranscodeStatus(videoId);
      if (!statusRes) return;

      if (statusRes.status === "failed") {
        clearInterval(pollInterval);
        setUploadError(`Transcoding Worker Failure: ${statusRes.error_message || "FFmpeg job failed in Go worker daemon."}`);
        return;
      }

      if (statusRes.status === "processing") {
        setSimStep("ffmpeg");
        const prog = statusRes.progress;
        setTranscodeProgress({
          p360: Math.min(prog * 1.2, 100),
          p720: Math.min(prog, 100),
          p1080: Math.min(prog * 0.8, 100),
        });

        setFfmpegLogs((prev) => {
          const logMsg = `GO WORKER: Transcoding active... PostgreSQL job progress: ${prog}%`;
          if (prev.includes(logMsg)) return prev;
          return [
            ...prev,
            logMsg,
          ];
        });
      }

      if (statusRes.status === "completed" || statusRes.progress >= 100) {
        clearInterval(pollInterval);
        setSimStep("manifest");
        setGeneratedManifests([
          "COMPILE: HLS master playlist and video segments built.",
          "COMPILE: Uploaded HLS playlists & TS chunks to MinIO destination bucket.",
          `HLS URL: ${statusRes.minio_manifest_url || "MinIO HLS Stream Ready"}`,
        ]);

        setTimeout(() => {
          setSimStep("completed");
        }, 1000);
      }
    }, 1500);
  };

  // Step 2 Fallback: Redis Message Enqueueing
  const triggerRedisStep = () => {
    setSimStep("redis");
    const logs = [
      "SYSTEM: Upload session complete. MinIO File HASH: sha256_f8a3d90214e",
      "GO API SERVER: Writing record to PostgreSQL database (status = 'pending')",
      "GO API SERVER: PostgreSQL row initialized. Preparing Asynq task payload...",
      "ASYNQ CLIENT: Enqueued task 'video:transcode' to Redis queue 'default'",
      "ASYNQ CLIENT: Redis task state: asynq:{default}:pending [task_id: " + Math.floor(Math.random() * 900 + 100) + "]",
      "ASYNQ WORKER: Pulled task 'video:transcode' from queue. Executing handler...",
      "GO WORKER: Launched FFmpeg processor. Updating PostgreSQL status to 'processing'...",
    ];

    let currentLogIndex = 0;
    const redisInterval = setInterval(() => {
      if (currentLogIndex < logs.length) {
        setRedisLogs((prev) => [...prev, logs[currentLogIndex]]);
        currentLogIndex++;
      } else {
        clearInterval(redisInterval);
        triggerFfmpegStep();
      }
    }, 300);
  };

  // Step 3 Fallback: FFmpeg Multi-Resolution Transcoding
  const triggerFfmpegStep = () => {
    setSimStep("ffmpeg");
    const logs = [
      "FFMPEG: Input #0, mov,mp4,m4a, from 'minio://raw-bucket/temp_file.mp4'",
      "FFMPEG:   Duration: 00:03:15.00, start: 0.000000, bitrate: 14210 kb/s",
      "FFMPEG:   Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv), 1920x1080",
      "FFMPEG:   Stream #0:1(und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo",
      "FFMPEG: Encoding quality CRF 22, Preset: veryfast, GOP size: 60 frames",
      "FFMPEG: [1080p variant] Scaling to 1920x1080, setting bitrate 4800k",
      "FFMPEG: [720p variant] Scaling to 1280x720, setting bitrate 2500k",
      "FFMPEG: [360p variant] Scaling to 640x360, setting bitrate 800k",
    ];

    setFfmpegLogs(logs);

    const transcodeInterval = setInterval(() => {
      setTranscodeProgress((prev) => {
        const next360 = Math.min(prev.p360 + 12, 100);
        const next720 = Math.min(prev.p720 + 8, 100);
        const next1080 = Math.min(prev.p1080 + 5, 100);

        // FFmpeg terminal simulation logs
        if (Math.random() > 0.4) {
          const randFrame = Math.floor(Math.random() * 200 + 400);
          const randFps = Math.floor(Math.random() * 20 + 45);
          const randTime = `00:01:${Math.floor(Math.random() * 40 + 10)}`;
          setFfmpegLogs((prevLogs) => [
            ...prevLogs,
            `FFMPEG: frame=${randFrame} fps=${randFps} q=24.0 size=~15.4MB time=${randTime} bitrate=3410kb/s speed=1.85x`,
          ]);
        }

        if (next360 === 100 && next720 === 100 && next1080 === 100) {
          clearInterval(transcodeInterval);
          triggerManifestStep();
        }

        return { p360: next360, p720: next720, p1080: next1080 };
      });
    }, 300);
  };

  // Step 4: Master Manifest compiles & segment files mapping (Duration: ~2s)
  const triggerManifestStep = () => {
    setSimStep("manifest");
    const manifests = [
      "COMPILE: Writing variant stream segment stream_360p_001.ts",
      "COMPILE: Writing variant stream segment stream_360p_002.ts",
      "COMPILE: Generated index manifest playlist_360p.m3u8",
      "COMPILE: Writing variant stream segment stream_720p_001.ts",
      "COMPILE: Writing variant stream segment stream_720p_002.ts",
      "COMPILE: Generated index manifest playlist_720p.m3u8",
      "COMPILE: Writing variant stream segment stream_1080p_001.ts",
      "COMPILE: Writing variant stream segment stream_1080p_002.ts",
      "COMPILE: Generated index manifest playlist_1080p.m3u8",
      "COMPILE: Writing master stream index master.m3u8",
      "COMPILE: HLS master compilation successful. MinIO destination layout compiled.",
    ];

    let currentIdx = 0;
    const manifestInterval = setInterval(() => {
      if (currentIdx < manifests.length) {
        setGeneratedManifests((prev) => [...prev, manifests[currentIdx]]);
        currentIdx++;
      } else {
        clearInterval(manifestInterval);
        triggerCompleteStep();
      }
    }, 200);
  };

  // Step 5: Complete & create database entries
  const triggerCompleteStep = () => {
    setSimStep("completed");

    // If real backend upload succeeded, finishedVideoId is already set to real UUID
    if (finishedVideoId) {
      return;
    }

    // Fallback ID generation for local simulation only
    const generatedId = visibility === "private"
      ? crypto.randomUUID()
      : `custom-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "video"}-${Math.floor(Math.random() * 800 + 100)}`;
    
    setFinishedVideoId(generatedId);

    // Build the fallback video metadata object
    const newVideo: Video = {
      id: generatedId,
      title: title,
      author: session?.user?.name ? `${session.user.name} (You)` : "JH (You)",
      views: "0 views",
      date: "Just now",
      duration: duration,
      tag: category,
      description: description || `Uploaded custom course video covering ${title}. Designed to explain components of distributed video engineering.`,
      visibility: visibility,
    };

    // Save to local storage only if offline/simulation fallback
    addVideo(newVideo);
  };

  const publishAndRedirect = () => {
    // Navigate user to the appropriate page
    if (visibility === "private") {
      router.push(`/watch/${finishedVideoId}`);
    } else {
      router.push("/");
    }
  };

  if (isPending) {
    return (
      <div className="min-h-screen bg-dark-base text-gray-100 flex flex-col items-center justify-center">
        <div className="h-8 w-8 border-4 border-brand-red border-t-transparent rounded-full animate-spin" />
        <span className="mt-4 text-xs font-semibold text-gray-400">Verifying session...</span>
      </div>
    );
  }

  if (!session) {
    return null;
  }

  return (
    <div className="min-h-screen bg-dark-base text-gray-100 flex flex-col pb-20">
      <Header />

      <main className="flex-1 max-w-4xl w-full mx-auto px-6 pt-6 flex flex-col gap-6">
        
        {/* Title Banner */}
        <section className="border-b border-dark-border pb-4">
          <span className="text-[10px] font-bold text-brand-red uppercase tracking-widest">
            Ingestion Center
          </span>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight leading-none mt-1">
            Video Ingestion Playground
          </h1>
          <p className="text-xs text-gray-400 mt-2 font-medium">
            Simulate a production-grade backend ingest pipeline: Chunked upload, Redis queue indexing, FFmpeg encoding, and HLS manifest generation.
          </p>
        </section>

        {!isSimulating ? (
          /* FORM VIEW */
          <form onSubmit={startIngestionPipeline} className="grid grid-cols-1 md:grid-cols-12 gap-8 bg-dark-card border border-dark-border/80 rounded-2xl p-6 sm:p-8">
            
            {/* Left Column (Inputs) */}
            <div className="md:col-span-7 flex flex-col gap-5">
              
              {/* Title */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-bold text-gray-300 uppercase tracking-wide">Video Title</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Scaling video delivery with Cloudflare Workers"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full bg-black border border-dark-border text-white text-xs rounded-lg p-3 focus:outline-none focus:border-brand-red transition-colors placeholder:text-gray-600 font-semibold"
                />
              </div>

              {/* Description */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-bold text-gray-300 uppercase tracking-wide">Description (Optional)</label>
                <textarea
                  rows={4}
                  placeholder="Provide an overview of the system architecture covered in this lesson..."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full bg-black border border-dark-border text-white text-xs rounded-lg p-3 focus:outline-none focus:border-brand-red transition-colors placeholder:text-gray-600 font-medium resize-none"
                />
              </div>

              {/* Selector row */}
              <div className="grid grid-cols-2 gap-4">
                {/* Category */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-gray-300 uppercase tracking-wide">Category</label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value as any)}
                    className="w-full bg-black border border-dark-border text-white text-xs rounded-lg p-3 focus:outline-none focus:border-brand-red transition-colors font-semibold outline-none cursor-pointer"
                  >
                    <option value="system design">System Design</option>
                    <option value="dev talks">Dev Talks</option>
                    <option value="tutorials">Tutorials</option>
                    <option value="demos">Demos</option>
                  </select>
                </div>

                {/* Duration */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-gray-300 uppercase tracking-wide">Duration</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. 05:40"
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                    className="w-full bg-black border border-dark-border text-white text-xs rounded-lg p-3 focus:outline-none focus:border-brand-red transition-colors font-semibold"
                  />
                </div>
              </div>

              {/* Visibility Settings */}
              <div className="flex flex-col gap-2 bg-black/40 border border-dark-border p-4 rounded-xl">
                <label className="text-xs font-bold text-gray-300 uppercase tracking-wide">Visibility Settings</label>
                
                <div className="grid grid-cols-2 gap-4 mt-1">
                  
                  {/* Public Option */}
                  <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer select-none transition-colors ${
                    visibility === "public"
                      ? "border-brand-red bg-brand-red/5"
                      : "border-dark-border hover:border-gray-700"
                  }`}>
                    <input
                      type="radio"
                      name="visibility"
                      value="public"
                      checked={visibility === "public"}
                      onChange={() => setVisibility("public")}
                      className="mt-0.5 accent-brand-red cursor-pointer"
                    />
                    <div className="flex flex-col">
                      <span className="text-xs font-bold text-gray-200">Public visibility</span>
                      <span className="text-[9.5px] text-gray-500 mt-0.5 leading-normal">
                        Show on the home feed and search lists.
                      </span>
                    </div>
                  </label>

                  {/* Private Option */}
                  <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer select-none transition-colors ${
                    visibility === "private"
                      ? "border-brand-red bg-brand-red/5"
                      : "border-dark-border hover:border-gray-700"
                  }`}>
                    <input
                      type="radio"
                      name="visibility"
                      value="private"
                      checked={visibility === "private"}
                      onChange={() => setVisibility("private")}
                      className="mt-0.5 accent-brand-red cursor-pointer"
                    />
                    <div className="flex flex-col">
                      <span className="text-xs font-bold text-gray-200">Private link</span>
                      <span className="text-[9.5px] text-gray-500 mt-0.5 leading-normal">
                        Hidden from feed. Accessible only via direct URL (unguessable ID).
                      </span>
                    </div>
                  </label>

                </div>
              </div>

            </div>

            {/* Right Column (Drag and Drop Mock File) */}
            <div className="md:col-span-5 flex flex-col justify-between gap-6">
              
              <div className="flex flex-col gap-1.5 flex-1">
                <label className="text-xs font-bold text-gray-300 uppercase tracking-wide">Media File</label>
                
                <div
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  className={`flex-1 border-2 border-dashed rounded-2xl flex flex-col items-center justify-center text-center p-6 transition-all cursor-pointer ${
                    file
                      ? "border-emerald-500 bg-emerald-500/5"
                      : isDragging
                      ? "border-brand-red bg-brand-red/5 scale-[0.98]"
                      : "border-dark-border hover:border-gray-600 bg-black/40"
                  }`}
                >
                  <input
                    type="file"
                    id="fileInput"
                    accept="video/*"
                    onChange={handleFileChange}
                    className="hidden"
                  />
                  
                  <label htmlFor="fileInput" className="cursor-pointer flex flex-col items-center gap-3 w-full h-full justify-center">
                    {file ? (
                      <>
                        <div className="p-3 bg-emerald-500/10 text-emerald-500 rounded-full">
                          <svg className="h-6 w-6 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        </div>
                        <div>
                          <p className="text-xs font-bold text-gray-200 truncate max-w-[180px]">{file.name}</p>
                          <p className="text-[10px] text-gray-500 mt-0.5">{(file.size / (1024 * 1024)).toFixed(1)} MB</p>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="p-3 bg-neutral-900 border border-dark-border text-gray-400 rounded-full group-hover:text-white transition-colors">
                          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                          </svg>
                        </div>
                        <div>
                          <p className="text-xs font-bold text-gray-300">Drag & drop raw video file</p>
                          <p className="text-[10px] text-gray-500 mt-0.5">or click to browse local folders</p>
                        </div>
                      </>
                    )}
                  </label>
                </div>
              </div>

              {/* Submit button */}
              <button
                type="submit"
                disabled={!file || !title}
                className="w-full bg-brand-red hover:bg-brand-red-hover disabled:bg-red-950/40 disabled:border disabled:border-brand-red/10 disabled:text-gray-500 text-white font-bold py-3.5 rounded-xl text-xs tracking-wide cursor-pointer transition-colors shadow-lg shadow-brand-red/15 select-none"
              >
                Start Ingestion Pipeline
              </button>

            </div>

          </form>
        ) : (
          /* PIPELINE SIMULATOR VIEW */
          <div className="bg-dark-card border border-dark-border rounded-2xl p-6 sm:p-8 flex flex-col gap-6">
            
            {/* Simulation Steps Ticker */}
            <div className="flex items-center justify-between border-b border-dark-border/80 pb-4">
              <h2 className="text-sm font-bold text-white uppercase tracking-wider">
                Ingestion Queue Status
              </h2>
              <div className="flex items-center gap-1.5">
                <span className={`h-2.5 w-2.5 rounded-full ${uploadError ? "bg-red-500" : simStep === "completed" ? "bg-emerald-500 animate-pulse" : "bg-brand-red animate-ping"}`} />
                <span className="text-[10px] font-bold font-mono text-gray-400 capitalize">
                  Status: {uploadError ? "Failed" : simStep === "completed" ? "Completed" : `${simStep} processing...`}
                </span>
              </div>
            </div>

            {uploadError && (
              <div className="bg-red-950/80 border border-red-500/50 rounded-xl p-4 flex flex-col gap-2 text-red-200 text-xs font-mono">
                <div className="flex items-center gap-2 text-red-400 font-bold">
                  <svg className="w-5 h-5 text-brand-red flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  BACKEND INGESTION ERROR DETECTED
                </div>
                <p className="leading-relaxed">{uploadError}</p>
                <button
                  onClick={() => { setIsSimulating(false); setUploadError(null); }}
                  className="mt-2 self-start px-3.5 py-1.5 bg-brand-red/40 hover:bg-brand-red/70 border border-brand-red/60 text-white text-xs font-semibold rounded-lg transition-colors cursor-pointer"
                >
                  ← Return to Upload Form
                </button>
              </div>
            )}

            {/* PIPELINE GRID STATUS */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              
              {/* Step 1: Chunk Ingest */}
              <div className={`p-4 border rounded-xl flex flex-col justify-between h-[130px] transition-colors ${
                simStep === "upload" 
                  ? "border-brand-red bg-brand-red/5"
                  : uploadProgress >= 100
                  ? "border-emerald-500/30 bg-emerald-500/5"
                  : "border-dark-border bg-neutral-900/20 opacity-40"
              }`}>
                <div>
                  <span className="text-[9px] font-bold text-gray-500 uppercase">Step 1</span>
                  <h3 className="text-xs font-bold text-gray-200 mt-0.5">MinIO Chunk Ingest</h3>
                </div>
                {simStep === "upload" ? (
                  <div className="flex flex-col gap-1.5">
                    <div className="w-full bg-dark-border h-1.5 rounded-full overflow-hidden">
                      <div className="bg-brand-red h-full rounded-full" style={{ width: `${uploadProgress}%` }} />
                    </div>
                    <span className="text-[9px] font-bold font-mono text-brand-red">{uploadProgress}% uploaded</span>
                  </div>
                ) : uploadProgress >= 100 ? (
                  <span className="text-[9.5px] font-bold text-emerald-500 flex items-center gap-1">✓ Complete</span>
                ) : (
                  <span className="text-[9px] text-gray-600">Pending</span>
                )}
              </div>

              {/* Step 2: Redis Enqueue */}
              <div className={`p-4 border rounded-xl flex flex-col justify-between h-[130px] transition-colors ${
                simStep === "redis" 
                  ? "border-orange-500 bg-orange-500/5"
                  : simStep !== "upload"
                  ? "border-emerald-500/30 bg-emerald-500/5"
                  : "border-dark-border bg-neutral-900/20 opacity-40"
              }`}>
                <div>
                  <span className="text-[9px] font-bold text-gray-500 uppercase">Step 2</span>
                  <h3 className="text-xs font-bold text-gray-200 mt-0.5">Redis (Asynq)</h3>
                </div>
                {simStep === "redis" ? (
                  <span className="text-[9.5px] font-bold text-orange-400 animate-pulse uppercase tracking-wider">Enqueueing job...</span>
                ) : simStep !== "upload" ? (
                  <span className="text-[9.5px] font-bold text-emerald-500 flex items-center gap-1">✓ Enqueued</span>
                ) : (
                  <span className="text-[9px] text-gray-600">Pending</span>
                )}
              </div>

              {/* Step 3: FFmpeg Encode */}
              <div className={`p-4 border rounded-xl flex flex-col justify-between h-[130px] transition-colors ${
                simStep === "ffmpeg" 
                  ? "border-purple-500 bg-purple-500/5"
                  : simStep === "manifest" || simStep === "completed"
                  ? "border-emerald-500/30 bg-emerald-500/5"
                  : "border-dark-border bg-neutral-900/20 opacity-40"
              }`}>
                <div>
                  <span className="text-[9px] font-bold text-gray-500 uppercase">Step 3</span>
                  <h3 className="text-xs font-bold text-gray-200 mt-0.5">FFmpeg Encode</h3>
                </div>
                {simStep === "ffmpeg" ? (
                  <div className="flex flex-col gap-1.5 text-[9px] font-mono text-purple-400">
                    <div className="flex justify-between font-bold">
                      <span>1080p master</span>
                      <span>{transcodeProgress.p1080}%</span>
                    </div>
                    <div className="w-full bg-dark-border h-1 rounded-full overflow-hidden">
                      <div className="bg-purple-500 h-full" style={{ width: `${transcodeProgress.p1080}%` }} />
                    </div>
                  </div>
                ) : simStep === "manifest" || simStep === "completed" ? (
                  <span className="text-[9.5px] font-bold text-emerald-500 flex items-center gap-1">✓ Transcoded</span>
                ) : (
                  <span className="text-[9px] text-gray-600">Pending</span>
                )}
              </div>

              {/* Step 4: Master Compiling */}
              <div className={`p-4 border rounded-xl flex flex-col justify-between h-[130px] transition-colors ${
                simStep === "manifest" 
                  ? "border-pink-500 bg-pink-500/5"
                  : simStep === "completed"
                  ? "border-emerald-500/30 bg-emerald-500/5"
                  : "border-dark-border bg-neutral-900/20 opacity-40"
              }`}>
                <div>
                  <span className="text-[9px] font-bold text-gray-500 uppercase">Step 4</span>
                  <h3 className="text-xs font-bold text-gray-200 mt-0.5">HLS Compilation</h3>
                </div>
                {simStep === "manifest" ? (
                  <span className="text-[9.5px] font-bold text-pink-400 animate-pulse uppercase tracking-wide">Compiling m3u8...</span>
                ) : simStep === "completed" ? (
                  <span className="text-[9.5px] font-bold text-emerald-500 flex items-center gap-1">✓ Packed & Signed</span>
                ) : (
                  <span className="text-[9px] text-gray-600">Pending</span>
                )}
              </div>

            </div>

            {/* LIVE CONSOLE LOG TERMINALS */}
            <div className="flex flex-col gap-2">
              <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest border-b border-dark-border/40 pb-1">
                Backend Pipeline Logging
              </span>

              {/* Terminal screen container */}
              <div className="border border-dark-border bg-black rounded-xl p-4 h-[200px] overflow-y-auto font-mono text-[9.5px] text-gray-400 leading-relaxed flex flex-col gap-1.5 scrollbar-none">
                
                {/* Upload logs */}
                {simStep === "upload" && (
                  <div className="flex flex-col gap-1">
                    <div>[API] Chunking file into 5 pieces of ~2.4MB each...</div>
                    {uploadProgress > 10 && <div>[API] Sending chunk #1: MD5 hash: 8ab2f3... ✓ Verified</div>}
                    {uploadProgress > 30 && <div>[API] Sending chunk #2: MD5 hash: f193d2... ✓ Verified</div>}
                    {uploadProgress > 50 && <div>[API] Sending chunk #3: MD5 hash: 01c23a... ✓ Verified</div>}
                    {uploadProgress > 70 && <div>[API] Sending chunk #4: MD5 hash: b8d3f1... ✓ Verified</div>}
                    {uploadProgress > 90 && <div>[API] Sending chunk #5: MD5 hash: e3c8a9... ✓ Verified</div>}
                    {uploadProgress >= 100 && <div className="text-emerald-400">[MinIO] Multipart session assembly initiated...</div>}
                  </div>
                )}

                {/* Redis logs */}
                {simStep === "redis" && (
                  <div className="flex flex-col gap-1 text-orange-400">
                    {redisLogs.map((logStr, i) => <div key={i}>{logStr}</div>)}
                  </div>
                )}

                {/* FFmpeg logs */}
                {simStep === "ffmpeg" && (
                  <div className="flex flex-col gap-1 text-purple-400/90">
                    {ffmpegLogs.map((logStr, i) => <div key={i}>{logStr}</div>)}
                  </div>
                )}

                {/* Manifest compiling logs */}
                {simStep === "manifest" && (
                  <div className="flex flex-col gap-1 text-pink-400">
                    {generatedManifests.map((logStr, i) => <div key={i}>{logStr}</div>)}
                  </div>
                )}

                {/* Completed logs */}
                {simStep === "completed" && (
                  <div className="flex flex-col gap-2">
                    <div className="text-emerald-400 font-bold">✓ PIPELINE INGESTION COMPLETED SUCCESSFULLY</div>
                    <div className="text-gray-400 leading-normal">
                      Master Playlist URI: <span className="text-white border-b border-dark-border pb-0.5">minio://streamify-storage/hls/${finishedVideoId}/master.m3u8</span>
                      <br />Visibility State: <span className="text-white uppercase font-bold">{visibility}</span>
                      <br />Direct Stream URL: <span className="text-white border-b border-dark-border pb-0.5">/watch/${finishedVideoId}</span>
                    </div>
                    <div className="text-yellow-500/90 font-bold mt-2">
                      [INFO] Video is signed and ready for play. Click button below to publish changes to catalog index.
                    </div>
                  </div>
                )}

              </div>
            </div>

            {/* Actions button at final state */}
            {simStep === "completed" && (
              <button
                onClick={publishAndRedirect}
                className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-3.5 rounded-xl text-xs tracking-wide cursor-pointer transition-colors shadow-lg shadow-emerald-500/10 text-center select-none"
              >
                {visibility === "private" ? "View Private Stream Player" : "Publish to Home Feed"}
              </button>
            )}

          </div>
        )}

      </main>
    </div>
  );
}
