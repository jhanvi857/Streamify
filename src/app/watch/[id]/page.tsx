"use client";

import { useParams, useRouter } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import Header from "@/components/Header";
import Link from "next/link";
import { useVideos } from "@/hooks/useVideos";
import { Video } from "@/data/videos";
import { fetchVideoByIdFromApi } from "@/lib/api";
import Hls from "hls.js";

export default function WatchPage() {
  const { id } = useParams();
  const router = useRouter();
  const { videos, isLoaded, deleteVideo } = useVideos();
  const [video, setVideo] = useState<Video | null>(null);
  const realVideoRef = useRef<HTMLVideoElement>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);

  // Video playback & Fullscreen states
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [realDuration, setRealDuration] = useState<number>(0);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverPercent, setHoverPercent] = useState<number>(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [playFeedback, setPlayFeedback] = useState<{ type: "play" | "pause" | "seek-back" | "seek-forward"; id: number } | null>(null);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);

  const triggerFeedback = (type: "play" | "pause" | "seek-back" | "seek-forward") => {
    setPlayFeedback({ type, id: Date.now() });
    setTimeout(() => {
      setPlayFeedback((prev) => (prev?.type === type ? null : prev));
    }, 650);
  };

  const handleMouseMove = () => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    if (isPlaying) {
      controlsTimeoutRef.current = setTimeout(() => {
        setShowControls(false);
      }, 2500);
    }
  };

  const handleMouseLeave = () => {
    if (isPlaying) {
      setShowControls(false);
    }
  };

  const toggleRealPlay = () => {
    if (realVideoRef.current) {
      if (isPlaying) {
        realVideoRef.current.pause();
        triggerFeedback("pause");
      } else {
        const playPromise = realVideoRef.current.play();
        if (playPromise !== undefined) {
          playPromise
            .then(() => triggerFeedback("play"))
            .catch((err) => {
              console.warn("Video playback pending or auto-play restricted:", err);
            });
        }
      }
    } else {
      setIsPlaying(!isPlaying);
      triggerFeedback(!isPlaying ? "play" : "pause");
    }
  };

  const toggleMute = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (realVideoRef.current) {
      const nextMuted = !isMuted;
      realVideoRef.current.muted = nextMuted;
      setIsMuted(nextMuted);
    }
  };

  const handleVolumeChange = (newVol: number) => {
    setVolume(newVol);
    if (realVideoRef.current) {
      realVideoRef.current.volume = newVol;
      realVideoRef.current.muted = newVol === 0;
      setIsMuted(newVol === 0);
    }
  };

  const seekRelative = (seconds: number) => {
    if (realVideoRef.current) {
      const duration = realVideoRef.current.duration || realDuration || 1;
      const target = Math.max(0, Math.min(duration, realVideoRef.current.currentTime + seconds));
      realVideoRef.current.currentTime = target;
      setCurrentTime(target);
      triggerFeedback(seconds > 0 ? "seek-forward" : "seek-back");
    }
  };

  const toggleFullscreen = () => {
    if (!playerContainerRef.current) return;

    if (!document.fullscreenElement) {
      if (playerContainerRef.current.requestFullscreen) {
        playerContainerRef.current.requestFullscreen();
      } else if ((playerContainerRef.current as any).webkitRequestFullscreen) {
        (playerContainerRef.current as any).webkitRequestFullscreen();
      } else if ((playerContainerRef.current as any).msRequestFullscreen) {
        (playerContainerRef.current as any).msRequestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      } else if ((document as any).webkitExitFullscreen) {
        (document as any).webkitExitFullscreen();
      } else if ((document as any).msExitFullscreen) {
        (document as any).msExitFullscreen();
      }
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === " " || e.key === "k" || e.key === "K") {
        e.preventDefault();
        toggleRealPlay();
      } else if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        toggleMute();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seekRelative(-5);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seekRelative(5);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPlaying, isMuted, realDuration]);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [qualityMode, setQualityMode] = useState<"Auto" | "1080p" | "720p" | "360p">("Auto");
  const [isBuffering, setIsBuffering] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  // HLS/ABR telemetry simulation state
  const [bandwidthMbps, setBandwidthMbps] = useState(15.0); // Default Wifi
  const [bufferSeconds, setBufferSeconds] = useState(8.0);
  const [activeQuality, setActiveQuality] = useState<"1080p" | "720p" | "360p">("1080p");
  const [currentSegment, setCurrentSegment] = useState(1);
  const [latencyMs, setLatencyMs] = useState(120);
  const [statsForNerds, setStatsForNerds] = useState(false);

  // Go Concurrency playground states
  const [goWorkers, setGoWorkers] = useState(3);
  const [goSpeed, setGoSpeed] = useState(1); // multiplier
  const [activeGoJobs, setActiveGoJobs] = useState<Array<{ id: number; workerId: number; progress: number }>>([]);
  const [completedGoJobsCount, setCompletedGoJobsCount] = useState(0);
  const [goChannelQueue, setGoChannelQueue] = useState<number[]>([]);

  // Redis Pub/Sub playground states
  const [pubSubLogs, setPubSubLogs] = useState<string[]>([]);
  const [isPubSubTranscoding, setIsPubSubTranscoding] = useState(false);
  const [pubSubProgress, setPubSubProgress] = useState(0);

  // Chunked Upload playground states
  const [uploadProgress, setUploadProgress] = useState<number[]>([]);
  const [uploadStatus, setUploadStatus] = useState<"idle" | "uploading" | "assembling" | "completed">("idle");
  const [failedChunks, setFailedChunks] = useState<number[]>([]);

  // SVG Animation Flow ticker
  const [animationTick, setAnimationTick] = useState(0);

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const animationRef = useRef<number | null>(null);
  const goJobIdCounter = useRef(1);

  // Load video from Backend API or DB / LocalStorage
  useEffect(() => {
    async function loadVideoDetails() {
      if (!id) return;
      const targetId = Array.isArray(id) ? id[0] : id;

      // 1. Check local/hook videos list first
      const found = videos.find((v) => v.id === targetId);
      if (found) {
        setVideo(found);
        return;
      }

      // 2. Fetch from Go Backend API
      const backendVid = await fetchVideoByIdFromApi(targetId);
      if (backendVid) {
        const streamRaw = backendVid.manifest_url;
        const streamFull = streamRaw
          ? `${(process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/api").replace(/\/+$/, "")}/videos/${backendVid.id}/stream${
              streamRaw.includes("master.m3u8") || streamRaw.startsWith("hls/")
                ? "/master.m3u8"
                : ""
            }`
          : undefined;

        setVideo({
          id: backendVid.id,
          title: backendVid.title,
          description: backendVid.description || "",
          tag: (backendVid.category as Video["tag"]) || "system design",
          author: backendVid.author_id || "Anonymous",
          views: `${backendVid.views_count || 0} views`,
          date: new Date(backendVid.created_at).toLocaleDateString(),
          duration: backendVid.duration || "00:00",
          visibility: backendVid.visibility || "public",
          manifestUrl: streamFull,
        });
      } else if (isLoaded) {
        setVideo(null);
      }
    }

    loadVideoDetails();
  }, [id, videos, isLoaded]);

  // HLS & MP4 video player initialization effect
  const activeStreamUrl = video?.manifestUrl;
  useEffect(() => {
    if (!activeStreamUrl || !realVideoRef.current) return;
    const videoEl = realVideoRef.current;
    const manifestUrl = activeStreamUrl;

    let hls: Hls | null = null;
    if (Hls.isSupported() && manifestUrl.includes(".m3u8")) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
      });
      hls.loadSource(manifestUrl);
      hls.attachMedia(videoEl);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          videoEl.src = manifestUrl;
        }
      });
    } else {
      videoEl.src = manifestUrl;
    }

    return () => {
      if (hls) {
        hls.destroy();
      }
    };
  }, [activeStreamUrl]);

  // SVG flow ticker
  useEffect(() => {
    if (isPlaying && !isBuffering) {
      const tick = () => {
        setAnimationTick((prev) => (prev + 1) % 100);
        animationRef.current = requestAnimationFrame(tick);
      };
      animationRef.current = requestAnimationFrame(tick);
    } else {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    }
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [isPlaying, isBuffering]);

  // Video Streaming & ABR Simulation loop
  useEffect(() => {
    if (!isPlaying) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }

    timerRef.current = setInterval(() => {
      // 1. Quality decision logic (Adaptive Bitrate)
      let resolvedQuality: "1080p" | "720p" | "360p" = "1080p";
      if (qualityMode === "Auto") {
        if (bandwidthMbps > 8.0) resolvedQuality = "1080p";
        else if (bandwidthMbps > 3.0) resolvedQuality = "720p";
        else resolvedQuality = "360p";
      } else {
        resolvedQuality = qualityMode;
      }
      setActiveQuality(resolvedQuality);

      // Segment sizes in MB based on resolution (approx 3 seconds of video)
      const segmentSizes = { "1080p": 2.5, "720p": 1.2, "360p": 0.4 };
      const segmentSize = segmentSizes[resolvedQuality];

      // Time to download segment (seconds) = Size (Mb) / Bandwidth (Mbps)
      const downloadTime = (segmentSize * 8) / bandwidthMbps;
      
      // Update latency and metadata
      const jitter = Math.random() * 20 - 10;
      const baseLatencies = { "1080p": 150, "720p": 100, "360p": 60 };
      setLatencyMs(Math.round(baseLatencies[resolvedQuality] + jitter + downloadTime * 20));

      // 2. Buffer management & buffering simulation
      if (isBuffering) {
        // If buffering, download speed fills the buffer
        const newBuffer = bufferSeconds + (3 / downloadTime) * 0.4;
        setBufferSeconds(Math.min(newBuffer, 15.0));

        if (newBuffer >= 5.0) {
          setIsBuffering(false);
        }
      } else {
        // Normal playback consumes buffer
        const consumed = 1 * playbackSpeed;
        // Download feeds buffer
        const added = (3 / Math.max(downloadTime, 0.1)) * 0.3;
        const netBuffer = bufferSeconds - consumed + added;

        if (netBuffer <= 0.5) {
          setBufferSeconds(0);
          setIsBuffering(true);
        } else {
          setBufferSeconds(Math.min(netBuffer, 20.0));
        }

        // Increment video playback time
        setCurrentTime((prev) => {
          const videoDurationSec = parseDuration(video?.duration || "10:00");
          if (prev >= videoDurationSec) {
            setIsPlaying(false);
            return 0;
          }
          return prev + 1 * playbackSpeed;
        });

        // Advance Segment ID every ~3 seconds
        setCurrentSegment((prev) => {
          if (Math.floor(currentTime) % 3 === 0 && currentTime > 0) {
            return prev + 1;
          }
          return prev;
        });
      }
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isPlaying, isBuffering, bandwidthMbps, qualityMode, bufferSeconds, playbackSpeed, currentTime, video]);

  // Go Concurrency Simulation engine
  useEffect(() => {
    if (video?.id !== "go-concurrency") return;

    // Dispatcher ticker
    const dispatchInterval = setInterval(() => {
      if (goChannelQueue.length < 8) {
        // Queue job ID
        setGoChannelQueue((prev) => [...prev, goJobIdCounter.current++]);
      }
    }, 2500 / goSpeed);

    // Worker processing loop
    const workerInterval = setInterval(() => {
      // For each available slot, if a worker is free, take a job
      setActiveGoJobs((prevActive) => {
        let updated = [...prevActive];

        // 1. Progress active jobs
        updated = updated.map((job) => ({
          ...job,
          progress: job.progress + 15 * goSpeed,
        }));

        // 2. Identify completed jobs and increment counter
        const completedJobs = updated.filter((j) => j.progress >= 100);
        if (completedJobs.length > 0) {
          setCompletedGoJobsCount((prev) => prev + completedJobs.length);
        }

        // Filter out completed jobs
        updated = updated.filter((j) => j.progress < 100);

        // 3. Assign new jobs if we have space (workers limit)
        const freeWorkerSlots = goWorkers - updated.length;
        if (freeWorkerSlots > 0 && goChannelQueue.length > 0) {
          setGoChannelQueue((prevQueue) => {
            const queueCopy = [...prevQueue];
            const jobsToTake = queueCopy.splice(0, Math.min(freeWorkerSlots, queueCopy.length));
            
            // Find active worker IDs
            const busyWorkers = updated.map((j) => j.workerId);
            let workerIndex = 1;

            jobsToTake.forEach((jobId) => {
              // Find first free worker ID
              while (busyWorkers.includes(workerIndex)) {
                workerIndex++;
              }
              updated.push({
                id: jobId,
                workerId: workerIndex,
                progress: 0,
              });
              busyWorkers.push(workerIndex);
            });

            return queueCopy;
          });
        }

        return updated;
      });
    }, 800);

    return () => {
      clearInterval(dispatchInterval);
      clearInterval(workerInterval);
    };
  }, [video, goChannelQueue, goWorkers, goSpeed]);

  // Helper to parse duration (e.g. "18:44" -> 1124 seconds)
  const parseDuration = (dur: string) => {
    const parts = dur.split(":").map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 600;
  };

  // Helper to format duration text (e.g. 75 -> "01:15")
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const copyWatchLink = () => {
    if (typeof window !== "undefined") {
      navigator.clipboard.writeText(window.location.href);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    }
  };

  // Redis PubSub Action simulation
  const startRedisTranscodeSimulation = () => {
    if (isPubSubTranscoding) return;
    setIsPubSubTranscoding(true);
    setPubSubProgress(0);
    setPubSubLogs([]);

    const log = (msg: string) => {
      setPubSubLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
    };

    log("Client click: 'Trigger Transcode' on video ID 841");
    log("WS: Gateway forwarding request to API Server");
    log("API: Enqueued task 'transcode_841' to Redis client (DB 0)");
    
    let progress = 0;
    const interval = setInterval(() => {
      progress += 10;
      setPubSubProgress(progress);
      
      if (progress === 10) {
        log("REDIS: Published event 'job_created' to channel 'video_jobs'");
        log("WORKER: Received 'job_created' via Redis subscription");
        log("WORKER: Launching FFmpeg encoder thread...");
      } else if (progress === 30) {
        log("FFMPEG: [360p variant] Transcoding keyframes...");
        log("REDIS: Published progress update 'transcoding_360p' [30% complete]");
        log("WS SERVER: Received Redis update, pushed frame to client UI");
      } else if (progress === 60) {
        log("FFMPEG: [720p variant] Rendering frame array...");
        log("REDIS: Published progress update 'transcoding_720p' [60% complete]");
        log("WS SERVER: Pushed event 'job_progress_60' to client socket");
      } else if (progress === 90) {
        log("FFMPEG: [1080p master] Compiling segment indexes...");
        log("REDIS: Published progress update 'transcoding_1080p' [90% complete]");
      } else if (progress >= 100) {
        log("FFMPEG: Transcoding completed. Final HLS manifest master.m3u8 written.");
        log("REDIS: Published event 'job_completed' to channel 'video_jobs'");
        log("API: Updated database state to 'READY'");
        log("WS SERVER: Push finish signal. Rendering player...");
        clearInterval(interval);
        setIsPubSubTranscoding(false);
      }
    }, 900);
  };

  // Chunked Upload Action simulation
  const startChunkedUploadSimulation = () => {
    setUploadStatus("uploading");
    setFailedChunks([]);
    setUploadProgress([0, 0, 0, 0, 0]);

    // Animate chunk uploading
    let chunkIndex = 0;
    
    const uploadNextChunk = (index: number) => {
      let chunkPct = 0;
      // 20% probability of chunk failure on chunk 3 to demonstrate system fault-tolerance
      const shouldFail = index === 2 && !failedChunks.includes(2);

      const chunkInterval = setInterval(() => {
        chunkPct += 20;
        setUploadProgress((prev) => {
          const updated = [...prev];
          updated[index] = Math.min(chunkPct, 100);
          return updated;
        });

        if (shouldFail && chunkPct === 60) {
          clearInterval(chunkInterval);
          setFailedChunks((prev) => [...prev, index]);
          setUploadProgress((prev) => {
            const updated = [...prev];
            updated[index] = -1; // -1 represents failed state
            return updated;
          });
          // Log/wait retry
          setTimeout(() => {
            // Simulate auto-retry of only that chunk
            setUploadProgress((prev) => {
              const updated = [...prev];
              updated[index] = 0;
              return updated;
            });
            uploadNextChunk(index);
          }, 1500);
        } else if (chunkPct >= 100) {
          clearInterval(chunkInterval);
          
          if (index < 4) {
            uploadNextChunk(index + 1);
          } else {
            // Assembling files
            setUploadStatus("assembling");
            setTimeout(() => {
              setUploadStatus("completed");
            }, 2000);
          }
        }
      }, 150);
    };

    uploadNextChunk(0);
  };

  if (!isLoaded) {
    return (
      <div className="min-h-screen bg-dark-base text-gray-100 flex flex-col items-center justify-center">
        <div className="h-8 w-8 border-4 border-brand-red border-t-transparent rounded-full animate-spin" />
        <span className="mt-4 text-xs font-semibold text-gray-400">Loading lesson workspace...</span>
      </div>
    );
  }

  if (video === null) {
    return (
      <div className="min-h-screen bg-dark-base text-gray-100 flex flex-col">
        <Header />
        <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
          <h2 className="text-xl font-bold text-white">Video Not Found</h2>
          <p className="text-xs text-gray-400 mt-2 max-w-sm">
            This video may have been deleted, or is a private video using an invalid link slug.
          </p>
          <Link
            href="/"
            className="mt-6 bg-brand-red hover:bg-brand-red-hover text-white text-xs font-bold px-6 py-2 rounded-lg transition-colors"
          >
            Back to feed
          </Link>
        </div>
      </div>
    );
  }

  const parsedDuration = parseDuration(video.duration);
  const videoDurationSec = realDuration > 0 ? realDuration : (parsedDuration > 0 ? parsedDuration : 1);
  const percentage = Math.min(100, Math.max(0, (currentTime / videoDurationSec) * 100));

  return (
    <div className="min-h-screen bg-dark-base text-gray-100 flex flex-col pb-20">
      <Header />

      <main className="flex-1 max-w-7xl w-full mx-auto px-6 pt-6 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        
        {/* LEFT COLUMN: Player & Metadata (7 cols) */}
        <section className="lg:col-span-7 flex flex-col gap-4">
          
          {/* Mock Video Player container */}
          <div
            ref={playerContainerRef}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            onClick={toggleRealPlay}
            className="relative aspect-video w-full bg-black rounded-2xl overflow-hidden border border-dark-border group select-none cursor-pointer"
          >
            {/* Player Canvas Display */}
            <div className="absolute inset-0 flex items-center justify-center bg-neutral-950">
              {video.manifestUrl ? (
                <video
                  key={video.manifestUrl}
                  ref={realVideoRef}
                  src={video.manifestUrl}
                  playsInline
                  className="w-full h-full object-contain pointer-events-none transition-all duration-300"
                  style={{
                    filter:
                      activeQuality === "360p"
                        ? "contrast(0.9) brightness(0.95) blur(0.6px)"
                        : activeQuality === "720p"
                        ? "contrast(0.98) blur(0.2px)"
                        : "none",
                  }}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onError={() => {
                    // Suppress false-alarm warning if video is HLS (.m3u8) processed by hls.js
                    if (video.manifestUrl?.includes(".m3u8")) return;
                    console.warn("Video stream pending or format restricted");
                  }}
                  onLoadedMetadata={(e) => {
                    if (e.currentTarget.duration && !isNaN(e.currentTarget.duration)) {
                      setRealDuration(e.currentTarget.duration);
                    }
                  }}
                  onTimeUpdate={() => {
                    if (realVideoRef.current) {
                      setCurrentTime(realVideoRef.current.currentTime);
                    }
                  }}
                />
              ) : (
                <>
                  {/* Buffer overlay */}
                  {isBuffering && (
                    <div className="absolute inset-0 bg-black/60 z-20 flex flex-col items-center justify-center gap-3">
                      <div className="h-10 w-10 border-4 border-brand-red border-t-transparent rounded-full animate-spin" />
                      <span className="text-xs text-gray-200 font-bold uppercase tracking-wider animate-pulse-slow">
                        Buffering Segment {currentSegment}...
                      </span>
                    </div>
                  )}

                  {/* Play symbol indicator */}
                  {!isPlaying && !isBuffering && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleRealPlay();
                      }}
                      className="z-10 h-16 w-16 rounded-full bg-brand-red hover:bg-brand-red-hover text-white flex items-center justify-center shadow-lg transition-transform hover:scale-110 active:scale-95 duration-200 cursor-pointer"
                    >
                      <svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </button>
                  )}

                  {/* Simulated visual video stream frame content */}
                  {isPlaying && !isBuffering && (
                    <div className="flex flex-col items-center text-center p-6 gap-2 select-none pointer-events-none">
                      <div
                        className="h-14 w-14 rounded-full border-2 border-dashed border-brand-red/40 flex items-center justify-center animate-spin"
                        style={{ animationDuration: "12s" }}
                      >
                        <svg className="h-6 w-6 text-brand-red" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      </div>
                      <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest mt-2">
                        Streaming Media variant: <span className="text-brand-red font-bold">{activeQuality}</span>
                      </span>
                      <span className="text-xs font-semibold text-gray-300">
                        Segment #{currentSegment} playing...
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Centered YouTube Play/Pause/Seek Ripple Pop Feedback */}
            {playFeedback && (
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center z-30">
                <div className="h-20 w-20 rounded-full bg-black/75 backdrop-blur-md border border-white/20 flex items-center justify-center text-white shadow-2xl transition-all scale-100 animate-in fade-in zoom-in-75 duration-200">
                  {playFeedback.type === "play" && (
                    <svg className="h-10 w-10 translate-x-0.5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                  {playFeedback.type === "pause" && (
                    <svg className="h-10 w-10" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                    </svg>
                  )}
                  {playFeedback.type === "seek-back" && (
                    <div className="flex flex-col items-center">
                      <svg className="h-7 w-7" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z" />
                      </svg>
                      <span className="text-[9px] font-mono font-bold mt-0.5">-5s</span>
                    </div>
                  )}
                  {playFeedback.type === "seek-forward" && (
                    <div className="flex flex-col items-center">
                      <svg className="h-7 w-7" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z" />
                      </svg>
                      <span className="text-[9px] font-mono font-bold mt-0.5">+5s</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Centered Big Play Button When Paused */}
            {!isPlaying && !isBuffering && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
                <div className="h-18 w-18 rounded-full bg-black/60 backdrop-blur-md border border-white/20 flex items-center justify-center text-white shadow-2xl transition-all group-hover:scale-110 group-hover:bg-brand-red group-hover:border-brand-red duration-200">
                  <svg className="h-8 w-8 translate-x-0.5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
              </div>
            )}

            {/* Nerds overlay stats dashboard */}
            {statsForNerds && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute top-4 left-4 z-30 bg-black/85 border border-dark-border rounded-xl p-3 font-mono text-[9px] text-emerald-400/90 leading-relaxed max-w-[280px]"
              >
                <div className="flex justify-between border-b border-dark-border/40 pb-1 mb-1 font-bold text-gray-300 text-[10px]">
                  <span>Telemetry Stats</span>
                  <button onClick={() => setStatsForNerds(false)} className="text-gray-500 hover:text-white cursor-pointer p-0.5">
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <div>Connection Speed: <span className="text-white">{bandwidthMbps.toFixed(1)} Mbps</span></div>
                <div>Selected Quality: <span className="text-white">{qualityMode} ({activeQuality})</span></div>
                <div>Download Latency: <span className="text-white">{latencyMs} ms</span></div>
                <div>Buffer Health: <span className="text-white">{bufferSeconds.toFixed(1)}s</span></div>
                <div>Active Segment: <span className="text-white">stream_{activeQuality}_00{currentSegment}.ts</span></div>
                <div>Segment File Size: <span className="text-white">{(activeQuality === "1080p" ? 2.5 : activeQuality === "720p" ? 1.2 : 0.4).toFixed(1)} MB</span></div>
                <div>Dropped Frames: <span className="text-white">0 / {currentSegment * 90}</span></div>
              </div>
            )}

            {/* Sleek YouTube Custom Control Bar (Auto-hides on inactivity when playing) */}
            <div
              onClick={(e) => e.stopPropagation()}
              className={`absolute bottom-0 inset-x-0 z-20 bg-gradient-to-t from-black/95 via-black/80 to-transparent px-4 pb-3 pt-8 flex flex-col gap-2 transition-all duration-300 ${
                showControls || !isPlaying
                  ? "opacity-100 pointer-events-auto translate-y-0"
                  : "opacity-0 pointer-events-none translate-y-2"
              }`}
            >
              {/* YouTube Interactive Timeline Scrubber */}
              <div
                className="relative w-full h-4 cursor-pointer flex items-center group/scrubber"
                onMouseMove={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                  setHoverPercent(pct * 100);
                  setHoverTime(pct * videoDurationSec);
                }}
                onMouseLeave={() => setHoverTime(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                  const targetTime = pct * videoDurationSec;
                  if (realVideoRef.current && realVideoRef.current.duration) {
                    realVideoRef.current.currentTime = targetTime;
                  }
                  setCurrentTime(targetTime);
                }}
              >
                {/* Hover Time Tooltip Preview */}
                {hoverTime !== null && (
                  <div
                    className="absolute -top-7 transform -translate-x-1/2 bg-black/90 text-white text-[10px] font-mono px-2 py-0.5 rounded border border-gray-700 pointer-events-none shadow z-30"
                    style={{ left: `${hoverPercent}%` }}
                  >
                    {formatTime(hoverTime)}
                  </div>
                )}

                {/* Track background */}
                <div className="w-full bg-gray-600/60 h-1 group-hover/scrubber:h-2 rounded-full transition-all duration-150 relative overflow-hidden">
                  {/* YouTube Bright Red Progress Line */}
                  <div
                    className="bg-brand-red h-full rounded-full transition-all duration-75 shadow-sm"
                    style={{ width: `${percentage}%` }}
                  />
                </div>

                {/* YouTube Red Scrubber Thumb Handle */}
                <div
                  className="absolute h-3 w-3 bg-brand-red border-2 border-white rounded-full shadow-md transform -translate-x-1/2 scale-0 group-hover/scrubber:scale-100 transition-transform duration-150 pointer-events-none"
                  style={{ left: `${percentage}%` }}
                />
              </div>

              {/* Control buttons */}
              <div className="flex items-center justify-between text-white text-xs mt-1">
                <div className="flex items-center gap-3">
                  {/* Play/Pause Button */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleRealPlay();
                    }}
                    title={isPlaying ? "Pause (k/space)" : "Play (k/space)"}
                    className="hover:text-brand-red transition-colors p-1 cursor-pointer"
                  >
                    {isPlaying ? (
                      <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                      </svg>
                    ) : (
                      <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    )}
                  </button>

                  {/* Volume Control with Interactive Slider */}
                  <div className="flex items-center group/vol gap-1">
                    <button
                      onClick={toggleMute}
                      title={isMuted ? "Unmute (m)" : "Mute (m)"}
                      className="text-gray-300 hover:text-white p-1 transition-colors cursor-pointer"
                    >
                      {isMuted || volume === 0 ? (
                        <svg className="h-4 w-4 text-brand-red" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                        </svg>
                      ) : (
                        <svg className="h-4 w-4 text-gray-300 hover:text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                        </svg>
                      )}
                    </button>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={isMuted ? 0 : volume}
                      onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                      className="w-0 group-hover/vol:w-16 transition-all duration-200 accent-brand-red h-1 bg-gray-600 rounded-lg cursor-pointer"
                    />
                  </div>

                  {/* Timestamp */}
                  <span className="font-mono text-[10px] text-gray-300 select-none">
                    {formatTime(currentTime)} / {realDuration > 0 ? formatTime(realDuration) : video.duration}
                  </span>
                </div>

                <div className="flex items-center gap-3">
                  {/* Active quality badge */}
                  <span className="bg-brand-red/10 border border-brand-red/30 text-brand-red text-[9px] font-mono font-bold px-1.5 py-0.5 rounded uppercase">
                    {activeQuality}
                  </span>

                  {/* Stats for nerds toggle */}
                  <button
                    onClick={() => setStatsForNerds(!statsForNerds)}
                    className={`px-2 py-0.5 text-[9px] border rounded font-mono font-bold cursor-pointer transition-colors ${
                      statsForNerds
                        ? "border-brand-red bg-brand-red text-white"
                        : "border-gray-600 text-gray-400 hover:text-white"
                    }`}
                  >
                    nerd stats
                  </button>

                  {/* Quality selector dropdown */}
                  <select
                    value={qualityMode}
                    onChange={(e) => {
                      const mode = e.target.value as any;
                      setQualityMode(mode);
                      if (mode === "Auto") {
                        setActiveQuality("1080p");
                      } else {
                        setActiveQuality(mode);
                      }
                    }}
                    className="bg-transparent border border-gray-700 text-white text-[10px] rounded px-1.5 py-0.5 outline-none cursor-pointer hover:border-gray-500"
                  >
                    <option value="Auto" className="bg-dark-card text-white">Auto ({activeQuality})</option>
                    <option value="1080p" className="bg-dark-card text-white">1080p (Full HD)</option>
                    <option value="720p" className="bg-dark-card text-white">720p (HD)</option>
                    <option value="360p" className="bg-dark-card text-white">360p (SD)</option>
                  </select>

                  {/* Fullscreen Button */}
                  <button
                    onClick={toggleFullscreen}
                    title={isFullscreen ? "Exit full screen (f)" : "Full screen (f)"}
                    className="p-1 text-gray-300 hover:text-brand-red transition-colors cursor-pointer"
                  >
                    {isFullscreen ? (
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    ) : (
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Details below video */}
          <div className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <span className="bg-brand-red/10 border border-brand-red/25 text-brand-red text-[10px] font-bold px-2 py-0.5 rounded tracking-wide uppercase select-none">
                  {video.tag}
                </span>
                <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight mt-2 leading-snug">
                  {video.title}
                </h1>
              </div>
            </div>

            <div className="flex items-center justify-between border-b border-dark-border pb-4 text-xs text-gray-400 font-medium">
              <div>
                <span className="font-semibold text-gray-200">{video.author}</span>
                <span className="mx-2 text-gray-600">•</span>
                <span>{video.views}</span>
                <span className="mx-2 text-gray-600">•</span>
                <span>{video.date}</span>
              </div>
              <button
                onClick={async () => {
                  if (confirm(`Are you sure you want to delete "${video.title}"?`)) {
                    await deleteVideo(video.id);
                    router.push("/");
                  }
                }}
                className="flex items-center gap-1.5 bg-red-600/10 hover:bg-red-600 text-red-500 hover:text-white border border-red-500/20 px-3 py-1.5 rounded-lg font-semibold transition-all cursor-pointer select-none"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Delete Video
              </button>
            </div>

            {/* Unlisted Link Sharing section */}
            {video.visibility === "private" && (
              <div className="bg-yellow-500/5 border border-yellow-500/20 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-yellow-500/10 text-yellow-500 mt-0.5">
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-yellow-500 uppercase tracking-wide">
                      Private Video Sharing Active
                    </h4>
                    <p className="text-[11px] text-gray-400 mt-0.5 max-w-md">
                      This is an unlisted video. It does not appear in the home feed. You can share the link below to allow friends or peers to watch it.
                    </p>
                  </div>
                </div>

                <button
                  onClick={copyWatchLink}
                  className="flex items-center justify-center gap-1.5 self-start sm:self-auto border border-yellow-500/40 text-yellow-500 hover:bg-yellow-500/10 text-xs font-bold px-4 py-2.5 rounded-lg transition-all cursor-pointer select-none"
                >
                  {copiedLink ? (
                    <>
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                      Copied!
                    </>
                  ) : (
                    <>
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 10.742l-1.954 1.954a2.5 2.5 0 003.536 3.536l3.536-3.536a2.5 2.5 0 00-3.536-3.536M15.316 13.258l1.954-1.954a2.5 2.5 0 00-3.536-3.536l-3.536 3.536a2.5 2.5 0 003.536 3.536" />
                      </svg>
                      Copy Link
                    </>
                  )}
                </button>
              </div>
            )}

            {/* Description block */}
            <div className="bg-dark-card border border-dark-border rounded-xl p-4 text-xs text-gray-400 leading-relaxed font-medium">
              <p>{video.description}</p>
            </div>
          </div>
        </section>

        {/* RIGHT COLUMN: System Design Explorer (5 cols) */}
        <section className="lg:col-span-5 flex flex-col gap-6 sticky top-24">
          
          {video.systemDesign ? (
            <div className="bg-dark-card border border-dark-border rounded-2xl p-6 flex flex-col gap-6">
              <div>
                <span className="text-[10px] font-bold text-brand-red uppercase tracking-widest">
                  System Design Workspace
                </span>
                <h2 className="text-lg font-bold text-white mt-0.5 tracking-tight">
                  {video.systemDesign.conceptTitle}
                </h2>
                <p className="text-[11px] text-gray-400 mt-1.5 font-medium leading-relaxed">
                  {video.systemDesign.summary}
                </p>
              </div>

              {/* Dynamic Animated SVG Diagram */}
              <div className="border border-dark-border/80 rounded-xl p-4 bg-black/60 relative overflow-hidden h-[220px]">
                <div className="absolute top-2 left-2 bg-brand-red/10 border border-brand-red/20 text-brand-red text-[8px] font-bold px-1.5 py-0.5 rounded tracking-wide uppercase select-none z-10">
                  Data Flow Diagram
                </div>
                
                <svg className="w-full h-full" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                  {/* Define connection lines & animate particles */}
                  {video.systemDesign.diagramData.connections.map((c, i) => {
                    const fromNode = video.systemDesign?.diagramData.nodes.find((n) => n.id === c.from);
                    const toNode = video.systemDesign?.diagramData.nodes.find((n) => n.id === c.to);
                    if (!fromNode || !toNode) return null;

                    // ABR / HLS Dynamic flow throttling visualization
                    const isThrottledPath = video.systemDesign?.conceptTitle.includes("Adaptive Bitrate") && 
                      ((activeQuality === "1080p" && (c.to === "p720" || c.to === "p360" || c.from === "p720" || c.from === "p360")) ||
                       (activeQuality === "360p" && (c.to === "p1080" || c.to === "p720" || c.from === "p1080" || c.from === "p720")));

                    return (
                      <g key={i}>
                        {/* Static connection path line */}
                        <path
                          d={`M ${fromNode.x} ${fromNode.y} L ${toNode.x} ${toNode.y}`}
                          stroke={isThrottledPath ? "#333333" : "#262626"}
                          strokeWidth="1.2"
                          fill="none"
                        />
                        {/* Glowing dynamic moving packet */}
                        {isPlaying && !isBuffering && !isThrottledPath && (
                          <circle r="1.5" fill="#c1121f" className="shadow-sm shadow-brand-red/50">
                            <animateMotion
                              path={`M ${fromNode.x} ${fromNode.y} L ${toNode.x} ${toNode.y}`}
                              dur={`${3 - i * 0.25}s`}
                              repeatCount="indefinite"
                            />
                          </circle>
                        )}
                      </g>
                    );
                  })}

                  {/* Render nodes */}
                  {video.systemDesign.diagramData.nodes.map((node) => {
                    // Check if node is inactive in ABR mode
                    const isNodeInactive = video.systemDesign?.conceptTitle.includes("Adaptive Bitrate") &&
                      ((activeQuality === "1080p" && (node.id === "p720" || node.id === "p360")) ||
                       (activeQuality === "360p" && (node.id === "p1080" || node.id === "p720")));

                    let fill = "#1c1c1c";
                    let border = "#3a3a3a";
                    if (node.id === "client" || node.id === "raw") {
                      fill = "#c1121f20";
                      border = "#c1121f";
                    } else if (node.id === "cdn" || node.id === "gateway" || node.id === "ws_server" || node.id === "manager") {
                      fill = "#0ea5e920";
                      border = "#0ea5e980";
                    } else if (node.id === "redis" || node.id === "redis_pub" || node.id.includes("chan")) {
                      fill = "#ea580c20";
                      border = "#ea580c80";
                    } else if (node.id === "workers" || node.id === "ffmpeg" || node.id.startsWith("w")) {
                      fill = "#a855f720";
                      border = "#a855f780";
                    }

                    return (
                      <g key={node.id} opacity={isNodeInactive ? 0.25 : 1}>
                        <circle
                          cx={node.x}
                          cy={node.y}
                          r="5.5"
                          fill={fill}
                          stroke={border}
                          strokeWidth="1.2"
                        />
                        <text
                          x={node.x}
                          y={node.y + 11}
                          textAnchor="middle"
                          fill="#a3a3a3"
                          fontSize="3.2"
                          fontWeight="bold"
                          className="select-none font-sans"
                        >
                          {node.label}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>

              {/* INTERACTIVE PLAYGROUND MODULE */}
              <div className="border border-dark-border/80 rounded-xl p-4 bg-black/40 flex flex-col gap-4">
                <div className="bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-[8px] font-bold px-1.5 py-0.5 rounded tracking-wide uppercase select-none self-start">
                  Interactive Simulator
                </div>

                {/* PLAYGROUND: ABR / HLS Throttler */}
                {video.systemDesign.architectureType === "hls" && (
                  <div className="flex flex-col gap-3">
                    <div className="flex justify-between text-xs font-semibold">
                      <span className="text-gray-300">Bandwidth Throttler</span>
                      <span className="text-brand-red font-mono font-bold">
                        {bandwidthMbps >= 15 ? "Wifi (15.0 Mbps)" : bandwidthMbps >= 6 ? "4G LTE (8.0 Mbps)" : bandwidthMbps >= 2 ? "3G (3.0 Mbps)" : "2G (0.8 Mbps)"}
                      </span>
                    </div>

                    <input
                      type="range"
                      min="0.8"
                      max="15.0"
                      step="0.1"
                      value={bandwidthMbps}
                      onChange={(e) => setBandwidthMbps(parseFloat(e.target.value))}
                      className="w-full accent-brand-red h-1 rounded-full cursor-pointer bg-dark-border"
                    />
                    <p className="text-[10px] text-gray-500 leading-normal font-medium">
                      Adjust the network throttle. Slow speeds will cause the HLS buffer to drain, forcing the player to download lower bitrate segments (360p) to recover.
                    </p>
                  </div>
                )}

                {/* PLAYGROUND: Go Concurrency Worker Pool */}
                {video.systemDesign.architectureType === "concurrency" && (
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between text-xs font-semibold">
                      <span className="text-gray-300">Worker Pool Size</span>
                      <span className="text-brand-red font-mono font-bold">{goWorkers} Workers</span>
                    </div>

                    <div className="flex gap-2">
                      {[1, 2, 3, 5].map((w) => (
                        <button
                          key={w}
                          onClick={() => setGoWorkers(w)}
                          className={`flex-1 py-1 rounded text-xs font-bold font-mono transition-colors cursor-pointer ${
                            goWorkers === w
                              ? "bg-brand-red text-white"
                              : "bg-dark-border text-gray-400 hover:text-white"
                          }`}
                        >
                          {w} G
                        </button>
                      ))}
                    </div>

                    <div className="flex items-center justify-between text-xs font-semibold">
                      <span className="text-gray-300">Simulation Speed</span>
                      <span className="text-brand-red font-mono font-bold">{goSpeed}x</span>
                    </div>

                    <div className="flex gap-2">
                      {[1, 2, 4].map((s) => (
                        <button
                          key={s}
                          onClick={() => setGoSpeed(s)}
                          className={`flex-1 py-1 rounded text-xs font-bold font-mono transition-colors cursor-pointer ${
                            goSpeed === s
                              ? "bg-brand-red text-white"
                              : "bg-dark-border text-gray-400 hover:text-white"
                          }`}
                        >
                          {s}x
                        </button>
                      ))}
                    </div>

                    {/* Channel / Job Queue representation */}
                    <div className="border border-dark-border bg-black/80 rounded-lg p-3 flex flex-col gap-2 font-mono text-[10px]">
                      <div className="flex justify-between text-[9px] text-gray-500 font-bold border-b border-dark-border/40 pb-1">
                        <span>Jobs Queue (Channel)</span>
                        <span>{goChannelQueue.length} Pending</span>
                      </div>
                      <div className="flex items-center gap-1.5 h-6 overflow-hidden">
                        {goChannelQueue.length === 0 ? (
                          <span className="text-gray-600 text-[9px]">channel empty...</span>
                        ) : (
                          goChannelQueue.map((jobId) => (
                            <span key={jobId} className="bg-amber-500/10 border border-amber-500/35 text-amber-500 px-1.5 py-0.5 rounded font-bold animate-pulse">
                              #{jobId}
                            </span>
                          ))
                        )}
                      </div>

                      <div className="flex justify-between text-[9px] text-gray-500 font-bold border-b border-dark-border/40 pt-2 pb-1">
                        <span>Active Goroutines</span>
                        <span>Completed: {completedGoJobsCount}</span>
                      </div>
                      <div className="flex flex-col gap-2 pt-1">
                        {Array.from({ length: goWorkers }).map((_, index) => {
                          const wId = index + 1;
                          const activeJob = activeGoJobs.find((j) => j.workerId === wId);
                          return (
                            <div key={wId} className="flex items-center justify-between">
                              <span className="text-gray-400 font-bold">Worker {wId}</span>
                              {activeJob ? (
                                <div className="flex items-center gap-2 w-2/3">
                                  <div className="w-full bg-dark-border h-1.5 rounded-full overflow-hidden">
                                    <div className="bg-purple-500 h-full rounded-full transition-all duration-300" style={{ width: `${activeJob.progress}%` }} />
                                  </div>
                                  <span className="text-purple-400 font-bold text-[9px]">{Math.floor(activeJob.progress)}%</span>
                                </div>
                              ) : (
                                <span className="text-gray-600 font-semibold text-[9px] uppercase tracking-wider">idle</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}

                {/* PLAYGROUND: Redis Pub/Sub Terminal updates */}
                {video.systemDesign.architectureType === "pubsub" && (
                  <div className="flex flex-col gap-3">
                    <button
                      onClick={startRedisTranscodeSimulation}
                      disabled={isPubSubTranscoding}
                      className="w-full bg-orange-600 hover:bg-orange-700 disabled:bg-orange-800 disabled:opacity-50 text-white font-bold py-2 rounded-lg text-xs cursor-pointer select-none text-center"
                    >
                      {isPubSubTranscoding ? `Simulating Transcode [${pubSubProgress}%]` : "Simulate Transcode Job"}
                    </button>

                    {/* Mini Console Log */}
                    <div className="border border-dark-border bg-black rounded-lg p-3 h-[120px] overflow-y-auto font-mono text-[9px] text-gray-400 leading-normal flex flex-col gap-1.5 scrollbar-none">
                      {pubSubLogs.length === 0 ? (
                        <span className="text-gray-600 select-none">Click button above to trigger transcoding job and watch Redis events...</span>
                      ) : (
                        pubSubLogs.map((logStr, i) => (
                          <div key={i} className={logStr.includes("REDIS") ? "text-orange-400" : logStr.includes("WS") ? "text-sky-400" : logStr.includes("FFMPEG") ? "text-purple-400" : "text-gray-300"}>
                            {logStr}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}

                {/* PLAYGROUND: Chunked Upload splits */}
                {video.systemDesign.architectureType === "upload" && (
                  <div className="flex flex-col gap-3">
                    <button
                      onClick={startChunkedUploadSimulation}
                      disabled={uploadStatus === "uploading" || uploadStatus === "assembling"}
                      className="w-full bg-brand-red hover:bg-brand-red-hover disabled:bg-red-800 text-white font-bold py-2 rounded-lg text-xs cursor-pointer select-none text-center"
                    >
                      {uploadStatus === "uploading"
                        ? "Uploading chunks..."
                        : uploadStatus === "assembling"
                        ? "Assembling parts on storage..."
                        : "Trigger Resumable Chunked Upload"}
                    </button>

                    <div className="border border-dark-border bg-black/50 rounded-lg p-3 flex flex-col gap-2 font-mono text-[10px]">
                      <div className="flex justify-between text-[9px] text-gray-500 font-bold border-b border-dark-border/40 pb-1">
                        <span>Chunk Status (5MB slices)</span>
                        <span className="capitalize">{uploadStatus}</span>
                      </div>
                      
                      <div className="grid grid-cols-5 gap-2 pt-1">
                        {uploadProgress.map((prog, i) => {
                          const isFailed = prog === -1;
                          return (
                            <div key={i} className="flex flex-col items-center gap-1.5">
                              <span className="text-[9px] text-gray-500 font-bold"># {i + 1}</span>
                              <div className={`h-8 w-8 rounded-lg flex items-center justify-center border text-[9px] font-bold ${
                                isFailed 
                                  ? "border-red-500 bg-red-500/10 text-red-500 animate-pulse"
                                  : prog >= 100
                                  ? "border-emerald-500 bg-emerald-500/10 text-emerald-500"
                                  : prog > 0
                                  ? "border-indigo-500 bg-indigo-500/10 text-indigo-400"
                                  : "border-dark-border bg-neutral-900 text-gray-600"
                              }`}>
                                {isFailed ? "FAIL" : `${prog}%`}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {failedChunks.length > 0 && (
                        <div className="text-[9px] text-red-400 font-bold bg-red-950/20 border border-red-950/30 p-2 rounded mt-1 leading-normal">
                          [WARN] Chunk #3 failed MD5 validation (Network corruption). Re-requesting chunk #3 only without restarting full upload.
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* PLAYGROUND: Transcoding flags */}
                {video.systemDesign.architectureType === "transcode" && (
                  <div className="flex flex-col gap-2 font-mono text-[10px]">
                    <span className="text-[9px] text-gray-500 font-bold border-b border-dark-border/40 pb-1">FFmpeg Command Playground</span>
                    <div className="bg-black border border-dark-border p-3 rounded-lg leading-relaxed text-gray-300 font-bold font-mono">
                      <span className="text-red-400">ffmpeg</span> -i raw_upload.mp4 \
                      <br />  -preset <span className="text-blue-400">veryfast</span> \
                      <br />  -g <span className="text-purple-400">60</span> \
                      <br />  -filter_complex <span className="text-yellow-400">"[0:v]split=3[v1,v2,v3];[v1]scale=1920:1080[v1out];[v2]scale=1280:720[v2out];[v3]scale=640:360[v3out]"</span> \
                      <br />  -hls_time <span className="text-emerald-400">2</span> -hls_playlist_type vod \
                      <br />  -master_pl_name <span className="text-pink-400">master.m3u8</span>
                    </div>
                    <p className="text-[9.5px] text-gray-500 leading-normal pt-1 font-medium font-sans">
                      Notice the <span className="text-purple-400 font-bold">-g 60</span> keyframe flag. Group of Pictures (GOP) alignment ensures keyframes sync perfectly with HLS <span className="text-emerald-400 font-bold">-hls_time 2</span> (2s segments) for smooth adaptive resolution switching.
                    </p>
                  </div>
                )}
              </div>

              {/* TECHNICAL DETAIL CARDS */}
              <div className="flex flex-col gap-4">
                <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest border-b border-dark-border/40 pb-1">
                  Architectural Notes
                </span>
                
                {video.systemDesign.details.map((detail, idx) => (
                  <div key={idx} className="flex flex-col gap-1.5">
                    <h4 className="text-xs font-bold text-gray-200">
                      {detail.title}
                    </h4>
                    <p className="text-[11px] text-gray-400 leading-relaxed font-medium">
                      {detail.text}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="bg-dark-card border border-dark-border rounded-2xl p-6 text-center text-gray-500 flex flex-col items-center justify-center py-12">
              <svg className="h-10 w-10 text-gray-600 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
              <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">No System Design Notes</h3>
              <p className="text-[10px] text-gray-500 mt-1 max-w-[200px] mx-auto leading-normal">
                This is a custom uploaded video. System design play panels are only pre-seeded for core platform courses.
              </p>
            </div>
          )}

        </section>

      </main>
    </div>
  );
}
