"use client";

import { useState, useEffect, useRef } from "react";
import Header from "@/components/Header";
import CategoryFilter from "@/components/CategoryFilter";
import VideoCard from "@/components/VideoCard";
import Link from "next/link";
import { useVideos } from "@/hooks/useVideos";
import { Video } from "@/data/videos";

// Dynamic mock videos generated to feed the infinite scroll
const extraMockVideos = [
  {
    title: "How CDN Edge Caching scales to millions of users",
    author: "Alex Rivera",
    views: "18.5k views",
    date: "4 days ago",
    duration: "15:20",
    tag: "system design" as const,
    description: "Learn how CDN cache hit ratios, cache invalidation strategies (purge, ban), and DNS geo-routing work together to distribute high-definition video chunks worldwide.",
    visibility: "public" as const,
  },
  {
    title: "WebRTC vs HLS: when to choose real-time streaming",
    author: "Sarah Jenkins",
    views: "22.1k views",
    date: "1 week ago",
    duration: "22:15",
    tag: "dev talks" as const,
    description: "A comparison of sub-second latency WebRTC peer-to-peer protocols versus segmented HTTP-based streaming (HLS/DASH). Understand the trade-offs of scale vs. delay.",
    visibility: "public" as const,
  },
  {
    title: "Building a distributed job scheduler with Kafka and Go",
    author: "Arjun K.",
    views: "11.2k views",
    date: "6 days ago",
    duration: "34:50",
    tag: "system design" as const,
    description: "Deep dive into using Apache Kafka as an event backbone to schedule and scale high-throughput transcoding tasks across multiple containerized worker fleets.",
    visibility: "public" as const,
  },
  {
    title: "Object Storage deep dive: S3 lifecycle policies and pricing",
    author: "Elena Petrova",
    views: "5.4k views",
    date: "3 weeks ago",
    duration: "12:10",
    tag: "tutorials" as const,
    description: "How to minimize storage bills by automatically tiering raw source videos to Glacier Deep Archive, while keeping HLS files in S3 standard with CDN fronting.",
    visibility: "public" as const,
  },
  {
    title: "Designing the API Gateway for microservices",
    author: "Meera V.",
    views: "14.9k views",
    date: "10 days ago",
    duration: "28:30",
    tag: "design" as const,
    description: "Exploring rate-limiting, request routing, and payload chunk handling at the Gateway level to protect backend transcoding pools from overload.",
    visibility: "public" as const,
  }
];

export default function Home() {
  const { videos, isLoaded } = useVideos();
  const [activeTab, setActiveTab] = useState<"feed" | "trending" | "my-uploads">("feed");
  const [activeCategory, setActiveCategory] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  
  // Infinite scroll simulation state
  const [visibleVideos, setVisibleVideos] = useState<Video[]>([]);
  const [extraCount, setExtraCount] = useState(0);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  
  const loaderRef = useRef<HTMLDivElement>(null);

  // Initialize videos once loaded from hook
  useEffect(() => {
    if (isLoaded) {
      // Filter default public videos
      const publicVideos = videos.filter(
        (v) => v.visibility === "public" && v.id !== "distributed-pipeline"
      );
      setVisibleVideos(publicVideos);
    }
  }, [videos, isLoaded]);

  // Handle active navigation tabs (using hash/params mock)
  useEffect(() => {
    if (typeof window !== "undefined") {
      const handleUrlChange = () => {
        const params = new URLSearchParams(window.location.search);
        const tab = params.get("tab") as "feed" | "trending" | "my-uploads";
        if (tab && ["feed", "trending", "my-uploads"].includes(tab)) {
          setActiveTab(tab);
        } else {
          setActiveTab("feed");
        }
      };

      handleUrlChange();
      window.addEventListener("popstate", handleUrlChange);
      
      // Override standard navigation links in Header
      const interval = setInterval(() => {
        const params = new URLSearchParams(window.location.search);
        const tab = params.get("tab") as "feed" | "trending" | "my-uploads";
        const currentTab = tab || "feed";
        if (currentTab !== activeTab) {
          setActiveTab(currentTab);
        }
      }, 300);

      return () => {
        window.removeEventListener("popstate", handleUrlChange);
        clearInterval(interval);
      };
    }
  }, [activeTab]);

  // Infinite Scroll logic using Intersection Observer
  useEffect(() => {
    if (!hasMore || isLoadingMore || activeTab !== "feed" || activeCategory !== "all" || searchTerm) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMoreVideos();
        }
      },
      { threshold: 0.1 }
    );

    if (loaderRef.current) {
      observer.observe(loaderRef.current);
    }

    return () => observer.disconnect();
  }, [loaderRef, hasMore, isLoadingMore, activeTab, activeCategory, searchTerm, extraCount]);

  const loadMoreVideos = () => {
    if (extraCount >= extraMockVideos.length) {
      setHasMore(false);
      return;
    }
    
    setIsLoadingMore(true);
    
    // Simulate network delay
    setTimeout(() => {
      const nextIndex = extraCount;
      const extraTemplate = extraMockVideos[nextIndex];
      
      const newVideo: Video = {
        id: `extra-${nextIndex}`,
        title: extraTemplate.title,
        author: extraTemplate.author,
        views: extraTemplate.views,
        date: extraTemplate.date,
        duration: extraTemplate.duration,
        tag: extraTemplate.tag,
        description: extraTemplate.description,
        visibility: extraTemplate.visibility,
      };

      setVisibleVideos((prev) => [...prev, newVideo]);
      setExtraCount((prev) => prev + 1);
      setIsLoadingMore(false);
    }, 1200);
  };

  // Search filter
  const handleSearch = (term: string) => {
    setSearchTerm(term.toLowerCase());
  };

  // Filter and sort catalog
  const getFilteredVideos = () => {
    let list = [...videos];

    // 1. Tab filtering
    if (activeTab === "my-uploads") {
      // Find custom uploaded videos that don't belong to the initial pre-seed set
      const defaultIds = ["distributed-pipeline", "go-concurrency", "hls-deep-dive", "redis-pubsub", "upload-api", "ffmpeg-flags"];
      list = list.filter((v) => !defaultIds.includes(v.id));
    } else {
      // Feed & Trending only show Public videos (plus custom public uploads)
      list = list.filter((v) => v.visibility === "public");
    }

    // Include the extra scrolled videos if in main feed and no filters active
    if (activeTab === "feed" && activeCategory === "all" && !searchTerm) {
      // Add loaded scrolled ones that are not already in list
      const scrolled = visibleVideos.filter((vv) => vv.id.startsWith("extra-"));
      list = [...list, ...scrolled];
    }

    // 2. Category tag filtering
    if (activeCategory !== "all") {
      list = list.filter((v) => v.tag === activeCategory);
    }

    // 3. Search filtering
    if (searchTerm) {
      list = list.filter(
        (v) =>
          v.title.toLowerCase().includes(searchTerm) ||
          v.author.toLowerCase().includes(searchTerm) ||
          v.tag.toLowerCase().includes(searchTerm)
      );
    }

    // 4. Tab sorting
    if (activeTab === "trending") {
      // Sort by view count (converting e.g. "14.2k views" -> 14200)
      const parseViews = (viewsStr: string) => {
        const match = viewsStr.match(/([\d.]+)(k|m)?/i);
        if (!match) return 0;
        const num = parseFloat(match[1]);
        const multiplier = match[2]?.toLowerCase();
        if (multiplier === "k") return num * 1000;
        if (multiplier === "m") return num * 1000000;
        return num;
      };
      list.sort((a, b) => parseViews(b.views) - parseViews(a.views));
    }

    return list;
  };

  const filteredList = getFilteredVideos();
  // Filter out featured video from main grid if we are in general feed view
  const displayGridList = activeTab === "feed" && activeCategory === "all" && !searchTerm
    ? filteredList.filter((v) => v.id !== "distributed-pipeline")
    : filteredList;

  // Find featured video metadata
  const featuredVideo = videos.find((v) => v.id === "distributed-pipeline");

  return (
    <div className="min-h-screen bg-dark-base text-gray-100 flex flex-col selection:bg-brand-red selection:text-white pb-20">
      <Header onSearch={handleSearch} />

      <main className="flex-1 max-w-7xl w-full mx-auto px-6 pt-6 flex flex-col gap-6">
        
        {/* Creator Hero Banner */}
        {/* <section className="bg-dark-card border border-dark-border/60 rounded-2xl p-8 flex flex-col justify-center relative overflow-hidden select-none">
          <div className="absolute right-0 top-0 h-full w-1/3 bg-gradient-to-l from-brand-red/10 to-transparent pointer-events-none" />
          <span className="text-[10px] font-bold text-brand-red uppercase tracking-widest mb-1.5">
            For Creators
          </span>
          <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight leading-none">
            Upload. Transcode. Share.
          </h1>
          <p className="text-xs sm:text-sm text-gray-400 mt-2 font-medium max-w-md">
            Drop a video — it's live in seconds, at every quality.
          </p>
        </section> */}

        {/* Category Filter Pills */}
        <CategoryFilter
          activeCategory={activeCategory}
          onSelectCategory={setActiveCategory}
        />

        {/* Featured Video (Only shown in general Feed view without filters/search) */}
        {activeTab === "feed" && activeCategory === "all" && !searchTerm && featuredVideo && (
          <section className="flex flex-col gap-3">
            <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500">
              Featured
            </h2>
            
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 bg-dark-card border border-dark-border/60 rounded-2xl overflow-hidden hover:border-brand-red/30 transition-all duration-300">
              {/* Left Column: Big Mock Player */}
              <div className="lg:col-span-7 relative aspect-video bg-neutral-900 flex items-center justify-center group overflow-hidden">
                <div className="absolute inset-0 opacity-10 bg-radial-gradient from-brand-red to-transparent group-hover:scale-105 transition-transform duration-500" />
                <Link href={`/watch/${featuredVideo.id}`} className="absolute inset-0 z-0" />
                
                {/* Play circle */}
                <Link
                  href={`/watch/${featuredVideo.id}`}
                  className="z-10 h-16 w-16 rounded-full bg-brand-red/10 border border-brand-red/35 flex items-center justify-center group-hover:bg-brand-red group-hover:scale-110 transition-all duration-300 shadow-2xl"
                >
                  <svg
                    className="h-6 w-6 text-brand-red group-hover:text-white transition-colors"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </Link>

                {/* Duration */}
                <span className="absolute bottom-4 right-4 bg-black/85 px-2.5 py-1 rounded text-xs font-bold text-gray-200 tracking-wide">
                  {featuredVideo.duration}
                </span>
              </div>

              {/* Right Column: Metadata */}
              <div className="lg:col-span-5 p-6 sm:p-8 flex flex-col justify-between">
                <div className="flex flex-col gap-3">
                  <span className="self-start bg-brand-red/10 border border-brand-red/25 text-brand-red text-[10px] font-bold px-2.5 py-0.5 rounded tracking-wide uppercase select-none">
                    {featuredVideo.tag}
                  </span>
                  
                  <h3 className="text-xl sm:text-2xl font-bold text-white tracking-tight leading-tight hover:text-brand-red transition-colors">
                    <Link href={`/watch/${featuredVideo.id}`}>
                      {featuredVideo.title}
                    </Link>
                  </h3>
                  
                  <p className="text-xs text-gray-400 font-medium line-clamp-2">
                    {featuredVideo.description}
                  </p>
                  
                  <div className="text-xs text-gray-400 font-semibold mt-1">
                    <span>{featuredVideo.author}</span>
                    <span className="mx-2 text-gray-600">•</span>
                    <span>{featuredVideo.views}</span>
                    <span className="mx-2 text-gray-600">•</span>
                    <span>{featuredVideo.date}</span>
                  </div>
                </div>

                {/* Continue Watching / Progress */}
                <div className="mt-6 flex flex-col gap-4">
                  {featuredVideo.progress !== undefined && (
                    <div className="flex flex-col gap-1.5">
                      <div className="w-full bg-dark-border h-1.5 rounded-full overflow-hidden">
                        <div
                          className="bg-brand-red h-full rounded-full shadow-lg shadow-brand-red/35"
                          style={{ width: `${featuredVideo.progress}%` }}
                        />
                      </div>
                      <div className="text-[10px] font-bold text-gray-500 tracking-wide uppercase">
                        {featuredVideo.progress}% watched
                      </div>
                    </div>
                  )}

                  <Link
                    href={`/watch/${featuredVideo.id}`}
                    className="flex items-center justify-center gap-2 w-full sm:w-auto self-start bg-brand-red hover:bg-brand-red-hover text-white text-xs font-bold px-6 py-3 rounded-lg shadow-lg shadow-brand-red/20 transition-all duration-200 cursor-pointer"
                  >
                    <div className="h-5 w-5 bg-white text-brand-red rounded-full flex items-center justify-center">
                      <svg
                        className="h-3 w-3"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </div>
                    continue watching
                  </Link>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Video Grid Section */}
        <section className="flex flex-col gap-4 mt-2">
          <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500">
            {activeTab === "my-uploads"
              ? "My Uploads"
              : activeTab === "trending"
              ? "Trending Now"
              : "Trending Now"}
          </h2>

          {displayGridList.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 border border-dashed border-dark-border rounded-xl text-center px-4 bg-dark-card/30">
              <svg
                className="h-12 w-12 text-gray-600 mb-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
              <h3 className="text-sm font-semibold text-gray-300">No videos found</h3>
              <p className="text-xs text-gray-500 mt-1 max-w-xs">
                {activeTab === "my-uploads"
                  ? "You haven't uploaded any videos yet. Click the upload button to simulate a video streaming pipeline!"
                  : "No videos match your search query or category filters."}
              </p>
              {activeTab === "my-uploads" && (
                <Link
                  href="/upload"
                  className="mt-4 bg-brand-red hover:bg-brand-red-hover text-white text-xs font-bold px-4 py-2 rounded-lg transition-colors"
                >
                  Go to upload simulator
                </Link>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {displayGridList.map((video) => (
                <VideoCard key={video.id} video={video} />
              ))}
            </div>
          )}
        </section>

        {/* Loading Spinner for Infinite Scroll */}
        {activeTab === "feed" && activeCategory === "all" && !searchTerm && hasMore && (
          <div
            ref={loaderRef}
            className="w-full flex items-center justify-center py-8 text-gray-500 text-xs font-semibold"
          >
            {isLoadingMore ? (
              <div className="flex items-center gap-2">
                <div className="h-4 w-4 border-2 border-brand-red border-t-transparent rounded-full animate-spin" />
                <span>Loading more system design gems...</span>
              </div>
            ) : (
              <span className="opacity-0">Scroll for more</span>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
