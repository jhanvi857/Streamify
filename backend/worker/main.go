package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/hibiken/asynq"
	_ "github.com/lib/pq"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// Config holds environment configurations
type Config struct {
	DBConn        string
	RedisAddr     string
	MinIOEndpoint string
	MinIOKey     string
	MinIOSecret  string
	RawBucket    string
	HLSBucket    string
	TempDir      string
}

// TranscodeTaskPayload defines the schema for incoming tasks
type TranscodeTaskPayload struct {
	VideoID   string `json:"video_id"`
	InputPath string `json:"input_path"`
}

// Worker holds task dependencies
type Worker struct {
	DB          *sql.DB
	MinIOClient *minio.Client
	Cfg         Config
}

func main() {
	cfg := Config{
		DBConn:        getEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/streamify?sslmode=disable"),
		RedisAddr:     getEnv("REDIS_ADDR", "127.0.0.1:6379"),
		MinIOEndpoint: getEnv("MINIO_ENDPOINT", "127.0.0.1:9000"),
		MinIOKey:      getEnv("MINIO_ROOT_USER", "minioadmin"),
		MinIOSecret:   getEnv("MINIO_ROOT_PASSWORD", "minioadmin"),
		RawBucket:     getEnv("MINIO_RAW_BUCKET", "raw-uploads"),
		HLSBucket:     getEnv("MINIO_HLS_BUCKET", "hls-streams"),
		TempDir:       getEnv("TEMP_DIR", "./tmp_work"),
	}

	// 1. Initialize PostgreSQL
	db, err := sql.Open("postgres", cfg.DBConn)
	if err != nil {
		log.Fatalf("Failed to open DB: %v", err)
	}
	defer db.Close()

	// 2. Initialize MinIO Client
	minioClient, err := minio.New(cfg.MinIOEndpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.MinIOKey, cfg.MinIOSecret, ""),
		Secure: false,
	})
	if err != nil {
		log.Fatalf("Failed to init MinIO: %v", err)
	}

	ensureBucketsExist(minioClient, cfg.RawBucket, cfg.HLSBucket)

	worker := &Worker{
		DB:          db,
		MinIOClient: minioClient,
		Cfg:         cfg,
	}

	// 3. Ensure local temp directories exist
	if err := os.MkdirAll(cfg.TempDir, 0755); err != nil {
		log.Fatalf("Failed to create working directory: %v", err)
	}

	// 4. Initialize Asynq Server
	srv := asynq.NewServer(
		asynq.RedisClientOpt{Addr: cfg.RedisAddr},
		asynq.Config{
			Concurrency: 4, // Up to 4 parallel transcode threads
			Queues: map[string]int{
				"default": 10,
			},
		},
	)

	// Register handlers
	mux := asynq.NewServeMux()
	mux.HandleFunc("video:transcode", worker.HandleTranscodeTask)

	log.Printf("Asynq worker daemon listening for tasks...")
	if err := srv.Run(mux); err != nil {
		log.Fatalf("Asynq server error: %v", err)
	}
}

// HandleTranscodeTask processes video HLS segmentation via FFmpeg
func (w *Worker) HandleTranscodeTask(ctx context.Context, t *asynq.Task) error {
	var payload TranscodeTaskPayload
	if err := json.Unmarshal(t.Payload(), &payload); err != nil {
		return fmt.Errorf("failed to parse payload: %v", err)
	}

	log.Printf("Received transcoding request for video: %s", payload.VideoID)
	
	// Update Postgres job table to 'processing'
	_, _ = w.DB.Exec(
		"UPDATE transcode_jobs SET status='processing', progress=5, updated_at=NOW() WHERE video_id=$1", 
		payload.VideoID,
	)

	// Prepare directories
	localWorkDir := filepath.Join(w.Cfg.TempDir, payload.VideoID)
	_ = os.RemoveAll(localWorkDir)
	if err := os.MkdirAll(localWorkDir, 0755); err != nil {
		w.failJob(payload.VideoID, fmt.Sprintf("Failed to create workspace: %v", err))
		return err
	}
	defer os.RemoveAll(localWorkDir)

	// Parse Raw Object Name from input path (e.g. "raw-uploads/raw-xyz.mp4" -> "raw-xyz.mp4")
	parts := strings.Split(payload.InputPath, "/")
	rawObjectName := parts[len(parts)-1]
	localRawPath := filepath.Join(localWorkDir, "source.mp4")

	// 1. Download raw file from MinIO
	log.Printf("[%s] Downloading raw video from MinIO...", payload.VideoID)
	err := w.MinIOClient.FGetObject(ctx, w.Cfg.RawBucket, rawObjectName, localRawPath, minio.GetObjectOptions{})
	if err != nil {
		w.failJob(payload.VideoID, fmt.Sprintf("MinIO pull failed: %v", err))
		return err
	}

	w.updateJobProgress(payload.VideoID, 15)

	// 2. Transcode HLS Segments using FFmpeg CLI
	// Compiles multi-bitrate HLS streams: 1080p, 720p, and 360p variants
	log.Printf("[%s] Invoking FFmpeg transcode pipeline...", payload.VideoID)
	
	// Prepare output path
	hlsOutputDir := filepath.Join(localWorkDir, "hls")
	if err := os.MkdirAll(hlsOutputDir, 0755); err != nil {
		w.failJob(payload.VideoID, "HLS directory creation failed")
		return err
	}

	// Crafting optimized FFmpeg command mapping stream segments
	cmdArgs := []string{
		"-i", localRawPath,
		"-preset", "veryfast",
		"-g", "60", // GOP size of 60 (exactly 2s segments for 30fps inputs)
		"-sc_threshold", "0",
		
		// Map variant #1: 360p
		"-map", "0:v", "-map", "0:a",
		"-s:v:0", "640x360", "-c:v:0", "libx264", "-b:v:0", "800k", "-maxrate:v:0", "850k", "-bufsize:v:0", "1200k",
		
		// Map variant #2: 720p
		"-map", "0:v", "-map", "0:a",
		"-s:v:1", "1280x720", "-c:v:1", "libx264", "-b:v:1", "2500k", "-maxrate:v:1", "2700k", "-bufsize:v:1", "4000k",
		
		// Map variant #3: 1080p
		"-map", "0:v", "-map", "0:a",
		"-s:v:2", "1920x1080", "-c:v:2", "libx264", "-b:v:2", "4800k", "-maxrate:v:2", "5000k", "-bufsize:v:2", "8000k",
		
		// Audio streams settings
		"-c:a", "aac", "-b:a", "128k", "-ar", "48000",
		
		// HLS configuration
		"-f", "hls",
		"-hls_time", "2",
		"-hls_playlist_type", "vod",
		"-hls_segment_filename", filepath.Join(hlsOutputDir, "v%v/file_%03d.ts"),
		"-master_pl_name", "master.m3u8",
		"-var_stream_map", "v:0,a:0 v:1,a:1 v:2,a:2",
		filepath.Join(hlsOutputDir, "v%v/playlist.m3u8"),
	}

	// Check if FFmpeg is available on PATH
	if _, errLook := exec.LookPath("ffmpeg"); errLook != nil {
		log.Printf("[%s] FFmpeg not found on PATH. Falling back to direct MinIO video URL...", payload.VideoID)
		rawVideoUrl := fmt.Sprintf("http://%s/%s/%s", w.Cfg.MinIOEndpoint, w.Cfg.RawBucket, rawObjectName)
		
		_, _ = w.DB.Exec(
			"UPDATE videos SET minio_manifest_url=$1 WHERE id=$2", 
			rawVideoUrl, payload.VideoID,
		)
		w.updateJobProgress(payload.VideoID, 100)
		log.Printf("[%s] Transcoding fallback complete. Linked raw video URL: %s", payload.VideoID, rawVideoUrl)
		return nil
	}

	cmd := exec.CommandContext(ctx, "ffmpeg", cmdArgs...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("FFmpeg output details:\n%s", string(output))
		w.failJob(payload.VideoID, fmt.Sprintf("FFmpeg execution error: %v", err))
		return err
	}

	w.updateJobProgress(payload.VideoID, 70)

	// 3. Upload all generated HLS segments and manifests to MinIO
	log.Printf("[%s] Uploading HLS segments & playlists to MinIO output bucket...", payload.VideoID)
	err = filepath.WalkDir(hlsOutputDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}

		// Calculate relative path inside output bucket (e.g. "v0/playlist.m3u8", "master.m3u8")
		relPath, err := filepath.Rel(hlsOutputDir, path)
		if err != nil {
			return err
		}
		
		// Convert windows backslashes to s3-friendly slashes
		bucketKey := fmt.Sprintf("%s/%s", payload.VideoID, filepath.ToSlash(relPath))
		
		contentType := "application/octet-stream"
		if strings.HasSuffix(path, ".m3u8") {
			contentType = "application/x-mpegURL"
		} else if strings.HasSuffix(path, ".ts") {
			contentType = "video/MP2T"
		}

		_, err = w.MinIOClient.FPutObject(ctx, w.Cfg.HLSBucket, bucketKey, path, minio.PutObjectOptions{
			ContentType: contentType,
		})
		return err
	})

	if err != nil {
		w.failJob(payload.VideoID, fmt.Sprintf("MinIO push failed: %v", err))
		return err
	}

	w.updateJobProgress(payload.VideoID, 95)

	// 4. Update Database statuses to finished
	hlsUrl := fmt.Sprintf("http://%s/%s/%s/master.m3u8", w.Cfg.MinIOEndpoint, w.Cfg.HLSBucket, payload.VideoID)
	
	tx, err := w.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Update video source link
	_, err = tx.ExecContext(ctx, "UPDATE videos SET minio_manifest_url=$1 WHERE id=$2", hlsUrl, payload.VideoID)
	if err != nil {
		w.failJob(payload.VideoID, "Failed to update video record URL")
		return err
	}

	// Update transcode job completion
	_, err = tx.ExecContext(ctx, "UPDATE transcode_jobs SET status='completed', progress=100, updated_at=NOW() WHERE video_id=$1", payload.VideoID)
	if err != nil {
		w.failJob(payload.VideoID, "Failed to update job status")
		return err
	}

	if err := tx.Commit(); err != nil {
		return err
	}

	log.Printf("Video %s successfully transcoded and published to MinIO HLS catalog", payload.VideoID)
	return nil
}

func (w *Worker) updateJobProgress(videoID string, progress int) {
	_, _ = w.DB.Exec(
		"UPDATE transcode_jobs SET progress=$1, updated_at=NOW() WHERE video_id=$2", 
		progress, videoID,
	)
}

func (w *Worker) failJob(videoID string, reason string) {
	log.Printf("[%s] Job failed: %s", videoID, reason)
	_, _ = w.DB.Exec(
		"UPDATE transcode_jobs SET status='failed', error_message=$1, updated_at=NOW() WHERE video_id=$2", 
		reason, videoID,
	)
}

func getEnv(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok {
		return value
	}
	return fallback
}

func ensureBucketsExist(minioClient *minio.Client, buckets ...string) {
	ctx := context.Background()
	for _, bucket := range buckets {
		exists, err := minioClient.BucketExists(ctx, bucket)
		if err != nil {
			log.Printf("Error checking MinIO bucket %s: %v", bucket, err)
			continue
		}
		if !exists {
			err = minioClient.MakeBucket(ctx, bucket, minio.MakeBucketOptions{})
			if err != nil {
				log.Printf("Error creating MinIO bucket %s: %v", bucket, err)
			} else {
				log.Printf("Successfully created MinIO bucket: %s", bucket)
			}
		}
	}
}

