export interface SystemDesignContent {
  conceptTitle: string;
  architectureType: 'hls' | 'concurrency' | 'pubsub' | 'upload' | 'transcode' | 'pipeline';
  summary: string;
  diagramData: {
    nodes: Array<{ id: string; label: string; x: number; y: number; type: 'client' | 'gateway' | 'queue' | 'worker' | 'storage' | 'cache' | 'cdn' }>;
    connections: Array<{ from: string; to: string; label: string }>;
  };
  details: Array<{ title: string; text: string }>;
}

export interface Video {
  id: string; // Will use UUIDs for private videos, slugs for default ones
  title: string;
  author: string;
  views: string;
  date: string;
  duration: string;
  tag: 'system design' | 'dev talks' | 'tutorials' | 'demos' | 'design' | 'recently watched';
  description: string;
  progress?: number; // Watched percentage, e.g., 35
  visibility: 'public' | 'private';
  systemDesign?: SystemDesignContent;
}

export const defaultVideos: Video[] = [
  {
    id: "distributed-pipeline",
    title: "Building a distributed video pipeline from scratch",
    author: "Riya Desai",
    views: "14.2k views",
    date: "3 days ago",
    duration: "42:18",
    tag: "system design",
    progress: 35,
    visibility: "public",
    description: "Deep dive into designing and building a horizontally scalable video ingestion and processing pipeline. Learn about distributed queues, storage strategies, and CDN integration.",
    systemDesign: {
      conceptTitle: "End-to-End Video Ingestion & Delivery",
      architectureType: "pipeline",
      summary: "A production-grade video pipeline processes video uploads asynchronously, transcoding them into multiple formats and distributing them via Content Delivery Networks (CDNs) for buffering-free playback.",
      diagramData: {
        nodes: [
          { id: "client", label: "Client Browser", x: 10, y: 50, type: "client" },
          { id: "gateway", label: "API Gateway", x: 25, y: 50, type: "gateway" },
          { id: "s3_raw", label: "S3 Raw Storage", x: 40, y: 20, type: "storage" },
          { id: "redis", label: "Redis Queue", x: 45, y: 80, type: "queue" },
          { id: "workers", label: "FFmpeg Workers", x: 65, y: 50, type: "worker" },
          { id: "s3_hls", label: "S3 HLS Storage", x: 80, y: 20, type: "storage" },
          { id: "cdn", label: "Cloudflare CDN", x: 90, y: 50, type: "cdn" }
        ],
        connections: [
          { from: "client", to: "gateway", label: "1. Chunked Upload" },
          { from: "gateway", to: "s3_raw", label: "2. Save Raw" },
          { from: "gateway", to: "redis", label: "3. Enqueue Job" },
          { from: "redis", to: "workers", label: "4. Pull Job" },
          { from: "workers", to: "s3_raw", label: "5. Pull Raw Video" },
          { from: "workers", to: "s3_hls", label: "6. Push HLS Segments" },
          { from: "s3_hls", to: "cdn", label: "7. Cache Master Manifest" },
          { from: "cdn", to: "client", label: "8. Stream Segments" }
        ]
      },
      details: [
        {
          title: "Horizontal Scaling Bottlenecks",
          text: "Transcoding is CPU-heavy. Separating the API server from FFmpeg transcoders via a message queue (like BullMQ/Redis) allows worker scaling groups to scale based on CPU usage without impacting user upload request times."
        },
        {
          title: "Storage Layout Optimization",
          text: "Store raw uploads in a temporary lifecycle-managed bucket (e.g., deleted after 7 days). Store final HLS/DASH outputs in a regional S3 bucket fronted by a CDN with aggressive HTTP caching for `.m3u8` playlists (short TTL) and `.ts` video segments (long TTL)."
        }
      ]
    }
  },
  {
    id: "go-concurrency",
    title: "Go concurrency patterns you actually use",
    author: "Arjun K.",
    views: "9.1k views",
    date: "1 week ago",
    duration: "18:44",
    tag: "dev talks",
    visibility: "public",
    description: "Learn how to orchestrate parallel worker pools, handle cancellations using context, and design safe fan-out/fan-in pipelines in Go for high-throughput video frame processing.",
    systemDesign: {
      conceptTitle: "Goroutines, Channels & Worker Pools",
      architectureType: "concurrency",
      summary: "Go's lightweight concurrency model excels at parallel processing tasks. In video workflows, this is used to decode, analyze, and generate previews for multiple video segments simultaneously.",
      diagramData: {
        nodes: [
          { id: "manager", label: "Job Dispatcher", x: 15, y: 50, type: "gateway" },
          { id: "chan_job", label: "Jobs Channel", x: 40, y: 30, type: "queue" },
          { id: "chan_res", label: "Results Channel", x: 40, y: 70, type: "queue" },
          { id: "w1", label: "Goroutine Worker 1", x: 65, y: 20, type: "worker" },
          { id: "w2", label: "Goroutine Worker 2", x: 65, y: 50, type: "worker" },
          { id: "w3", label: "Goroutine Worker 3", x: 65, y: 80, type: "worker" },
          { id: "collector", label: "Results Aggregator", x: 90, y: 50, type: "client" }
        ],
        connections: [
          { from: "manager", to: "chan_job", label: "Write Task" },
          { from: "chan_job", to: "w1", label: "Read" },
          { from: "chan_job", to: "w2", label: "Read" },
          { from: "chan_job", to: "w3", label: "Read" },
          { from: "w1", to: "chan_res", label: "Write Result" },
          { from: "w2", to: "chan_res", label: "Write Result" },
          { from: "w3", to: "chan_res", label: "Write Result" },
          { from: "chan_res", to: "collector", label: "Read & Merge" }
        ]
      },
      details: [
        {
          title: "The Fan-Out, Fan-In Pattern",
          text: "Fan-out occurs when multiple goroutines read from the same jobs channel, distributing load. Fan-in happens when these workers write results to a single results channel, merged by a collector using sync.WaitGroup to close when complete."
        },
        {
          title: "Graceful Shutdown & Context",
          text: "Using `context.Context` is critical to prevent goroutine leaks. When a timeout occurs or the client disconnects, context cancellation propagates down, breaking worker loops and closing channels safely."
        }
      ]
    }
  },
  {
    id: "hls-deep-dive",
    title: "HLS deep dive: segments, manifests, ABR",
    author: "Meera V.",
    views: "5.6k views",
    date: "5 days ago",
    duration: "31:05",
    tag: "tutorials",
    visibility: "public",
    description: "Understand how HTTP Live Streaming (HLS) works under the hood. We decompose master playlists (.m3u8), stream playlists, and MPEG-TS media segments (.ts) for adaptive playback.",
    systemDesign: {
      conceptTitle: "Adaptive Bitrate (ABR) Streaming",
      architectureType: "hls",
      summary: "HLS splits videos into small chunks (2-6 seconds) and encodes them at different bitrates (e.g., 360p, 720p, 1080p). The client's player dynamically selects the best quality based on real-time network throughput.",
      diagramData: {
        nodes: [
          { id: "client", label: "Video Player", x: 10, y: 50, type: "client" },
          { id: "cdn", label: "Edge CDN", x: 35, y: 50, type: "cdn" },
          { id: "manifest", label: "Master Manifest (.m3u8)", x: 65, y: 20, type: "storage" },
          { id: "p1080", label: "1080p Segments (.ts)", x: 85, y: 20, type: "storage" },
          { id: "p720", label: "720p Segments (.ts)", x: 85, y: 50, type: "storage" },
          { id: "p360", label: "360p Segments (.ts)", x: 85, y: 80, type: "storage" }
        ],
        connections: [
          { from: "client", to: "cdn", label: "1. Request Stream" },
          { from: "cdn", to: "manifest", label: "2. Fetch Playlists" },
          { from: "client", to: "cdn", label: "3. Choose 1080p (Wifi)" },
          { from: "cdn", to: "p1080", label: "4. Get segment_001.ts" },
          { from: "client", to: "cdn", label: "5. Throttled! Switch 360p" },
          { from: "cdn", to: "p360", label: "6. Get segment_002.ts" }
        ]
      },
      details: [
        {
          title: "Master vs. Variant Playlists",
          text: "The master manifest directs the player to available variants (resolutions, codecs, bitrates). Each variant points to its own playlist listing short media chunks (e.g., `segment_001.ts`)."
        },
        {
          title: "How ABR Switching Algorithm Works",
          text: "The client-side player measures segment download times. If download time < segment duration, bandwidth is sufficient. If download time > segment duration, the buffer depletes, prompting a switch to a lower bitrate variant."
        }
      ]
    }
  },
  {
    id: "redis-pubsub",
    title: "Redis pub/sub for real-time job updates",
    author: "Preet S.",
    views: "3.2k views",
    date: "2 weeks ago",
    duration: "9:22",
    tag: "demos",
    visibility: "public",
    description: "A live coding session implementing a Redis pub/sub mechanism to send instant transcoding progress updates from backend FFmpeg workers to the web client via WebSockets.",
    systemDesign: {
      conceptTitle: "Publish-Subscribe & WebSockets",
      architectureType: "pubsub",
      summary: "Transcoding large videos takes time. Instead of polling the server, we use a WebSocket server backed by Redis Pub/Sub to broadcast real-time progress events from distributed workers directly to the client browser.",
      diagramData: {
        nodes: [
          { id: "client", label: "Client Browser", x: 10, y: 50, type: "client" },
          { id: "ws_server", label: "WebSocket Gateway", x: 35, y: 50, type: "gateway" },
          { id: "redis_pub", label: "Redis Pub/Sub Channel", x: 60, y: 50, type: "cache" },
          { id: "worker_1", label: "Transcoder Worker 1", x: 85, y: 30, type: "worker" },
          { id: "worker_2", label: "Transcoder Worker 2", x: 85, y: 70, type: "worker" }
        ],
        connections: [
          { from: "client", to: "ws_server", label: "1. WS Handshake" },
          { from: "ws_server", to: "redis_pub", label: "2. Subscribe 'job_updates'" },
          { from: "worker_1", to: "redis_pub", label: "3. Publish progress: 42%" },
          { from: "redis_pub", to: "ws_server", label: "4. Forward event" },
          { from: "ws_server", to: "client", label: "5. Push: Job 12 - 42%" }
        ]
      },
      details: [
        {
          title: "Why Redis Pub/Sub?",
          text: "When scaling WebSocket connections across multiple API servers, a client might be connected to Server A, while the worker reports to Server B. Redis Pub/Sub acts as a shared message broker, ensuring updates reach all server nodes."
        },
        {
          title: "Comparison: Polling vs. WebSockets vs. SSE",
          text: "Short polling wastes database reads. Long polling keeps connections occupied. Server-Sent Events (SSE) are unidirectional and excellent for progress bars, while WebSockets allow bi-directional, full-duplex communication."
        }
      ]
    }
  },
  {
    id: "upload-api",
    title: "Designing the upload API — chunking vs multipart",
    author: "Sanya R.",
    views: "7.8k views",
    date: "4 days ago",
    duration: "24:11",
    tag: "system design",
    visibility: "public",
    description: "Explore the architectural trade-offs of handling large video files. We compare multipart direct uploads, presigned URLs, and chunked resumable uploads with checksum verification.",
    systemDesign: {
      conceptTitle: "Reliable Large File Uploads",
      architectureType: "upload",
      summary: "Uploading gigabytes of video over unstable connections is highly error-prone. A robust architecture breaks files into small pieces, uploads them independently, and handles retries gracefully.",
      diagramData: {
        nodes: [
          { id: "client", label: "Uploader client", x: 10, y: 50, type: "client" },
          { id: "server", label: "Upload API Service", x: 40, y: 50, type: "gateway" },
          { id: "db", label: "Postgres Metadata", x: 65, y: 80, type: "storage" },
          { id: "s3", label: "S3 Multipart Storage", x: 80, y: 30, type: "storage" }
        ],
        connections: [
          { from: "client", to: "server", label: "1. Init Session (Get UUID)" },
          { from: "server", to: "db", label: "2. Save upload intent" },
          { from: "client", to: "server", label: "3. Upload Chunk #1 (with MD5)" },
          { from: "server", to: "s3", label: "4. Store Chunk #1" },
          { from: "client", to: "server", label: "5. Chunk #2 fails (Network Drop)" },
          { from: "client", to: "server", label: "6. Retry Chunk #2 only" },
          { from: "server", to: "s3", label: "7. Final Assembly Command" }
        ]
      },
      details: [
        {
          title: "Multipart vs. Custom Chunking",
          text: "AWS S3 Multipart Upload is highly optimized, allowing direct S3 uploads via Presigned URLs (bypassing the application server completely). Custom chunking on the server gives better control over resumes and custom storage arrays."
        },
        {
          title: "Checksum Verification (MD5)",
          text: "To ensure data integrity, the client calculates an MD5 hash of each chunk before sending. The server calculates it upon receipt and rejects mismatching chunks, preventing bit rot and network-corrupted uploads."
        }
      ]
    }
  },
  {
    id: "ffmpeg-flags",
    title: "ffmpeg transcoding flags that actually matter",
    author: "Dev T.",
    views: "2.9k views",
    date: "3 weeks ago",
    duration: "14:57",
    tag: "tutorials",
    visibility: "public",
    description: "Mastering FFmpeg flags for optimal H.264/AAC encoding. We explain bitrate control, preset speed/quality trade-offs, keyframe intervals, and scaling filter configurations.",
    systemDesign: {
      conceptTitle: "Video Transcoding and Codecs",
      architectureType: "transcode",
      summary: "Raw video uploads are too large and use uncompressed codecs. We run FFmpeg to transcode them into internet-friendly formats (H.264/H.265) and fragment them into HLS segments.",
      diagramData: {
        nodes: [
          { id: "raw", label: "raw_upload.mov", x: 10, y: 50, type: "storage" },
          { id: "ffmpeg", label: "FFmpeg Encoder Engine", x: 45, y: 50, type: "worker" },
          { id: "playlist", label: "master.m3u8 Index", x: 80, y: 20, type: "storage" },
          { id: "seg1", label: "seg_1080p_001.ts", x: 85, y: 50, type: "storage" },
          { id: "seg2", label: "seg_720p_001.ts", x: 85, y: 80, type: "storage" }
        ],
        connections: [
          { from: "raw", to: "ffmpeg", label: "Read source stream" },
          { from: "ffmpeg", to: "playlist", label: "Generate HLS manifests" },
          { from: "ffmpeg", to: "seg1", label: "Segment & transcode 1080p" },
          { from: "ffmpeg", to: "seg2", label: "Segment & transcode 720p" }
        ]
      },
      details: [
        {
          title: "Key Flags Explained",
          text: "`-preset veryfast` balances encode speed and compression ratio. `-g 60` sets the Keyframe (GOP) interval to 60 frames. At 30 FPS, this creates keyframes exactly every 2 seconds, which is crucial for aligned HLS segment boundaries."
        },
        {
          title: "CRF (Constant Rate Factor) vs. Two-Pass",
          text: "CRF (typically 18-23) allocates bits dynamically to maintain visual quality across scenes. For HLS streaming, we use Constrained VBR (setting `-crf` with `-maxrate` and `-bufsize`) to prevent network buffering spikes during action sequences."
        }
      ]
    }
  }
];
