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
  manifestUrl?: string;
  minioManifestUrl?: string;
  systemDesign?: SystemDesignContent;
}

export const defaultVideos: Video[] = [];
