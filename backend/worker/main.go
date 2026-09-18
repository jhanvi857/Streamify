package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/hibiken/asynq"
	_ "github.com/lib/pq"
	s3 "github.com/minio/minio-go/v7"
	s3creds "github.com/minio/minio-go/v7/pkg/credentials"
)

// Config holds environment configurations
type Config struct {
	DBConn      string
	RedisAddr   string
	S3Endpoint  string
	S3AccessKey string
	S3SecretKey string
	S3Region    string
	S3UseSSL    bool
	RawBucket   string
	HLSBucket   string
	TempDir     string
}

// TranscodeTaskPayload defines the schema for incoming tasks
type TranscodeTaskPayload struct {
	VideoID   string `json:"video_id"`
	InputPath string `json:"input_path"`
}

// Worker holds task dependencies
type Worker struct {
	DB       *sql.DB
	S3Client *s3.Client
	Cfg      Config
}

func main() {
	loadEnv()

	rawEndpoint := getValidEnv("S3_ENDPOINT", "AWS_ENDPOINT_URL_S3", "CLOUDWEAVE_ENDPOINT")
	if rawEndpoint == "" {
		rawEndpoint = "127.0.0.1:9000"
	}
	useSSL := getEnv("S3_USE_SSL", "false") == "true" || strings.HasPrefix(rawEndpoint, "https://") || strings.Contains(rawEndpoint, "neon.tech")

	cfg := Config{
		DBConn:      getEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/streamify?sslmode=disable"),
		RedisAddr:   getEnv("REDIS_ADDR", "127.0.0.1:6379"),
		S3Endpoint:  cleanEndpoint(rawEndpoint),
		S3AccessKey: getValidEnv("S3_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "CLOUDWEAVE_API_KEY", "master-secret-key"),
		S3SecretKey: getValidEnv("S3_SECRET_KEY", "AWS_SECRET_ACCESS_KEY", "CLOUDWEAVE_API_KEY", "master-secret-key"),
		S3Region:    getValidEnv("S3_REGION", "AWS_REGION", "us-east-1"),
		S3UseSSL:    useSSL,
		RawBucket:   getEnv("S3_RAW_BUCKET", "raw-uploads"),
		HLSBucket:   getEnv("S3_HLS_BUCKET", "hls-streams"),
		TempDir:     getEnv("TEMP_DIR", "./tmp_work"),
	}

	// 1. Initialize PostgreSQL
	db, err := sql.Open("postgres", cfg.DBConn)
	if err != nil {
		log.Fatalf("Failed to open DB: %v", err)
	}
	defer db.Close()

	if err := db.Ping(); err != nil {
		log.Printf("Warning: Worker database ping failed (%v). Check DATABASE_URL in .env", err)
	} else {
		var currentDB, version string
		_ = db.QueryRow("SELECT current_database(), version()").Scan(&currentDB, &version)
		isNeon := strings.Contains(strings.ToLower(version), "neon") || strings.Contains(cfg.DBConn, "neon.tech")
		if isNeon {
			log.Printf("Worker connected to Neon PostgreSQL (Cloud) successfully! Database: %s", currentDB)
		} else {
			log.Printf("Worker connected to PostgreSQL successfully! Database: %s", currentDB)
		}
	}

	// Auto-provision PostgreSQL schema if running against fresh DB (e.g. Neon in production)
	ensureDatabaseSchema(db)

	// 2. Initialize S3-Compatible Storage Client (CloudWeave for dev, Neon / AWS S3 for prod)
	s3Client, err := s3.New(cfg.S3Endpoint, &s3.Options{
		Creds:  s3creds.NewStaticV4(cfg.S3AccessKey, cfg.S3SecretKey, ""),
		Secure: cfg.S3UseSSL,
		Region: cfg.S3Region,
	})
	if err != nil {
		log.Fatalf("Failed to init S3 Client: %v", err)
	}

	ensureBucketsExist(s3Client, cfg.RawBucket, cfg.HLSBucket)

	worker := &Worker{
		DB:       db,
		S3Client: s3Client,
		Cfg:      cfg,
	}

	// 3. Ensure local temp directories exist
	if err := os.MkdirAll(cfg.TempDir, 0755); err != nil {
		log.Fatalf("Failed to create working directory: %v", err)
	}

	// 4. Initialize Asynq Server
	srv := asynq.NewServer(
		parseRedisOpt(cfg.RedisAddr),
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

	// 1. Download raw file from S3-compatible storage
	log.Printf("[%s] Downloading raw video from S3 bucket %s...", payload.VideoID, w.Cfg.RawBucket)
	obj, err := w.S3Client.GetObject(ctx, w.Cfg.RawBucket, rawObjectName, s3.GetObjectOptions{})
	if err != nil {
		w.failJob(payload.VideoID, fmt.Sprintf("S3 download failed: %v", err))
		return err
	}
	defer obj.Close()

	localFile, err := os.Create(localRawPath)
	if err != nil {
		w.failJob(payload.VideoID, fmt.Sprintf("Failed to create local destination file: %v", err))
		return err
	}

	_, err = io.Copy(localFile, obj)
	localFile.Close()
	if err != nil {
		w.failJob(payload.VideoID, fmt.Sprintf("Failed to stream video to disk: %v", err))
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
		log.Printf("[%s] FFmpeg not found on PATH. Falling back to direct video stream...", payload.VideoID)
		rawVideoUrl := fmt.Sprintf("raw/%s", rawObjectName)
		
		_, _ = w.DB.Exec(
			"UPDATE videos SET manifest_url=$1 WHERE id=$2", 
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

	// 3. Upload all generated HLS segments and manifests to S3 output bucket
	log.Printf("[%s] Uploading HLS segments & playlists to S3 bucket %s...", payload.VideoID, w.Cfg.HLSBucket)
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
			contentType = "application/vnd.apple.mpegurl"
		} else if strings.HasSuffix(path, ".ts") {
			contentType = "video/MP2T"
		}

		_, err = w.S3Client.FPutObject(ctx, w.Cfg.HLSBucket, bucketKey, path, s3.PutObjectOptions{
			ContentType: contentType,
		})
		return err
	})

	if err != nil {
		w.failJob(payload.VideoID, fmt.Sprintf("S3 HLS upload failed: %v", err))
		return err
	}

	w.updateJobProgress(payload.VideoID, 95)

	// 4. Update Database statuses to finished
	hlsUrl := fmt.Sprintf("hls/%s/master.m3u8", payload.VideoID)
	
	tx, err := w.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Update video source link
	_, err = tx.ExecContext(ctx, "UPDATE videos SET manifest_url=$1 WHERE id=$2", hlsUrl, payload.VideoID)
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

	log.Printf("Video %s successfully transcoded and published to S3 HLS catalog", payload.VideoID)
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

func cleanEndpoint(endpoint string) string {
	endpoint = strings.TrimPrefix(endpoint, "http://")
	endpoint = strings.TrimPrefix(endpoint, "https://")
	return strings.TrimSuffix(endpoint, "/")
}

func ensureBucketsExist(s3Client *s3.Client, buckets ...string) {
	ctx := context.Background()
	for _, bucket := range buckets {
		exists, err := s3Client.BucketExists(ctx, bucket)
		if err != nil || !exists {
			err = s3Client.MakeBucket(ctx, bucket, s3.MakeBucketOptions{})
			if err != nil {
				log.Printf("Note: S3 bucket %s initialization: %v", bucket, err)
			} else {
				log.Printf("Successfully initialized S3 bucket: %s", bucket)
			}
		}
	}
}

// ensureDatabaseSchema automatically verifies and synchronizes PostgreSQL tables & indexes
// on first boot against any PostgreSQL database (such as Neon in production or Docker in dev).
func ensureDatabaseSchema(db *sql.DB) {
	schemaPaths := []string{
		"./db/schema.sql",
		"../db/schema.sql",
		"backend/db/schema.sql",
		"./backend/db/schema.sql",
	}

	var content []byte
	var readErr error
	for _, path := range schemaPaths {
		content, readErr = os.ReadFile(path)
		if readErr == nil {
			break
		}
	}

	if readErr != nil || len(content) == 0 {
		log.Printf("Note: Could not locate schema.sql (%v), skipping DDL auto-sync", readErr)
		return
	}

	if _, err := db.Exec(string(content)); err != nil {
		log.Printf("Warning: Failed to execute schema.sql: %v", err)
	} else {
		log.Println("PostgreSQL schema successfully verified and synchronized")
	}
}

// loadEnv loads environment variables from .env or .env.development files
func loadEnv() {
	envFiles := []string{
		".env",
		".env.development",
		".env.local",
		"backend/.env",
		"backend/.env.development",
		"../.env",
		"../.env.development",
	}

	for _, file := range envFiles {
		data, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			parts := strings.SplitN(line, "=", 2)
			if len(parts) == 2 {
				k := strings.TrimSpace(parts[0])
				v := strings.Trim(strings.TrimSpace(parts[1]), `"'`)
				if _, exists := os.LookupEnv(k); !exists {
					os.Setenv(k, v)
				}
			}
		}
	}
}

// parseRedisOpt parses either host:port, redis://, rediss://, or "redis-cli ... -u <url>"
func parseRedisOpt(raw string) asynq.RedisConnOpt {
	raw = strings.TrimSpace(raw)
	raw = strings.Trim(raw, `"'`)
	hasTLS := strings.Contains(raw, "--tls") || strings.HasPrefix(raw, "rediss://")
	if idx := strings.Index(raw, "rediss://"); idx != -1 {
		raw = raw[idx:]
	} else if idx := strings.Index(raw, "redis://"); idx != -1 {
		raw = raw[idx:]
		if hasTLS {
			raw = "rediss://" + strings.TrimPrefix(raw, "redis://")
		}
	}
	if strings.HasPrefix(raw, "redis://") || strings.HasPrefix(raw, "rediss://") {
		opt, err := asynq.ParseRedisURI(raw)
		if err == nil {
			return opt
		}
	}
	return asynq.RedisClientOpt{Addr: raw}
}

// getValidEnv returns the first non-empty, non-placeholder environment variable value
func getValidEnv(keys ...string) string {
	for _, key := range keys {
		val := strings.TrimSpace(os.Getenv(key))
		val = strings.Trim(val, `"'`)
		if val != "" && !strings.HasPrefix(val, "<") && !strings.HasSuffix(val, ">") {
			return val
		}
	}
	return ""
}
