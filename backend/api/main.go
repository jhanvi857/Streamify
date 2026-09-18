package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/hibiken/asynq"
	_ "github.com/lib/pq"
	s3 "github.com/minio/minio-go/v7"
	s3creds "github.com/minio/minio-go/v7/pkg/credentials"
)

// Config holds environment configurations
type Config struct {
	Port        string
	DBConn      string
	RedisAddr   string
	S3Endpoint  string
	S3AccessKey string
	S3SecretKey string
	S3Region    string
	S3UseSSL    bool
	RawBucket   string
	HLSBucket   string
}

// App holds application state
type App struct {
	DB          *sql.DB
	AsynqClient *asynq.Client
	S3Client    *s3.Client
	Cfg         Config
}

// VideoUploadRequest holds metadata for initializing an upload session
type VideoUploadRequest struct {
	Title       string `json:"title" binding:"required"`
	Description string `json:"description"`
	Category    string `json:"category" binding:"required"`
	Visibility  string `json:"visibility" binding:"required,oneof=public private"`
	Duration    string `json:"duration"`
	AuthorID    string `json:"author_id" binding:"required"`
}

// TranscodeTaskPayload defines the schema for Asynq job payloads
type TranscodeTaskPayload struct {
	VideoID   string `json:"video_id"`
	InputPath string `json:"input_path"`
}

func main() {
	loadEnv()

	rawEndpoint := getEnv("S3_ENDPOINT", getEnv("CLOUDWEAVE_ENDPOINT", "127.0.0.1:9000"))
	useSSL := getEnv("S3_USE_SSL", "false") == "true" || strings.HasPrefix(rawEndpoint, "https://")

	cfg := Config{
		Port:        getEnv("PORT", "8080"),
		DBConn:      getEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/streamify?sslmode=disable"),
		RedisAddr:   getEnv("REDIS_ADDR", "127.0.0.1:6379"),
		S3Endpoint:  cleanEndpoint(rawEndpoint),
		S3AccessKey: getEnv("S3_ACCESS_KEY", getEnv("CLOUDWEAVE_API_KEY", "master-secret-key")),
		S3SecretKey: getEnv("S3_SECRET_KEY", getEnv("CLOUDWEAVE_API_KEY", "master-secret-key")),
		S3Region:    getEnv("S3_REGION", "us-east-1"),
		S3UseSSL:    useSSL,
		RawBucket:   getEnv("S3_RAW_BUCKET", "raw-uploads"),
		HLSBucket:   getEnv("S3_HLS_BUCKET", "hls-streams"),
	}

	// 1. Initialize PostgreSQL
	db, err := sql.Open("postgres", cfg.DBConn)
	if err != nil {
		log.Fatalf("Failed to open DB: %v", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)

	// Verify database connection immediately
	if err := db.Ping(); err != nil {
		log.Printf("Warning: Database ping failed (%v). Check DATABASE_URL in .env", err)
	} else {
		var currentDB, version string
		_ = db.QueryRow("SELECT current_database(), version()").Scan(&currentDB, &version)
		isNeon := strings.Contains(strings.ToLower(version), "neon") || strings.Contains(cfg.DBConn, "neon.tech")
		if isNeon {
			log.Printf("Connected to Neon PostgreSQL (Cloud) successfully! Database: %s", currentDB)
		} else {
			log.Printf("Connected to PostgreSQL successfully! Database: %s", currentDB)
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

	// Ensure S3 buckets exist
	ensureBucketsExist(s3Client, cfg.RawBucket, cfg.HLSBucket)

	// 3. Initialize Asynq client
	asynqClient := asynq.NewClient(asynq.RedisClientOpt{Addr: cfg.RedisAddr})
	defer asynqClient.Close()

	app := &App{
		DB:          db,
		S3Client:    s3Client,
		AsynqClient: asynqClient,
		Cfg:         cfg,
	}

	// 4. Setup Router
	r := gin.Default()

	// CORS middleware
	r.Use(func(c *gin.Context) {
		c.Writer.Header().Set("Access-Control-Allow-Origin", "*")
		c.Writer.Header().Set("Access-Control-Allow-Credentials", "true")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, accept, origin, Cache-Control, X-Requested-With, Range")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS, GET, PUT, DELETE, HEAD")
		c.Writer.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Type")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}

		c.Next()
	})

	// Health check endpoint (verifies if PostgreSQL / Neon is working)
	healthHandler := func(c *gin.Context) {
		err := db.Ping()
		if err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"status":   "error",
				"database": "disconnected",
				"error":    err.Error(),
			})
			return
		}
		var currentDB, version string
		_ = db.QueryRow("SELECT current_database(), version()").Scan(&currentDB, &version)
		isNeon := strings.Contains(strings.ToLower(version), "neon") || strings.Contains(cfg.DBConn, "neon.tech")
		dbType := "PostgreSQL (Local)"
		if isNeon {
			dbType = "Neon PostgreSQL (Cloud)"
		}

		var tableCount int
		_ = db.QueryRow("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'").Scan(&tableCount)

		c.JSON(http.StatusOK, gin.H{
			"status":           "ok",
			"database":         "connected",
			"database_type":    dbType,
			"current_database": currentDB,
			"tables_count":     tableCount,
			"storage_endpoint": cfg.S3Endpoint,
		})
	}
	r.GET("/health", healthHandler)

	api := r.Group("/api")
	{
		api.GET("/health", healthHandler)
		api.POST("/videos/upload/init", app.handleInitUpload)
		api.POST("/videos/upload/direct", app.handleDirectUpload)
		api.POST("/videos/upload/complete", app.handleCompleteUpload)
		api.GET("/videos", app.handleListVideos)
		api.GET("/videos/:id", app.handleGetVideo)
		api.GET("/videos/:id/stream", app.handleStreamVideo)
		api.GET("/videos/:id/stream/*filepath", app.handleStreamVideo)
		api.HEAD("/videos/:id/stream", app.handleStreamVideo)
		api.HEAD("/videos/:id/stream/*filepath", app.handleStreamVideo)
		api.GET("/videos/:id/status", app.handleGetVideoStatus)
		api.DELETE("/videos/:id", app.handleDeleteVideo)
	}

	log.Printf("Server listening on port %s", cfg.Port)
	if err := r.Run(":" + cfg.Port); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}

// handleInitUpload creates a PostgreSQL video entry and generates an S3 presigned URL
func (app *App) handleInitUpload(c *gin.Context) {
	var req VideoUploadRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Generate non-guessable secure identifier (protects against IDOR)
	videoID := uuid.New().String()
	objectName := fmt.Sprintf("raw-%s.mp4", videoID)

	// Save video record to PostgreSQL with a 'pending' state
	query := `
		INSERT INTO videos (id, title, description, category, visibility, author_id, duration) 
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`
	_, err := app.DB.Exec(query, videoID, req.Title, req.Description, req.Category, req.Visibility, req.AuthorID, req.Duration)
	if err != nil {
		log.Printf("DB Write Error: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create database entry"})
		return
	}

	// Generate S3 Presigned URL for direct client-to-storage uploads
	// This reduces backend memory/network pressure
	presignedURL, err := app.S3Client.PresignedPutObject(
		context.Background(),
		app.Cfg.RawBucket,
		objectName,
		time.Hour*2, // 2-hour upload lease
	)
	if err != nil {
		log.Printf("S3 Presigned URL Error: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate object storage access token"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"video_id":    videoID,
		"upload_url":  presignedURL.String(),
		"object_name": objectName,
		"raw_bucket":  app.Cfg.RawBucket,
	})
}

// handleDirectUpload accepts a file stream from client and uploads directly to S3-compatible storage via SigV4
func (app *App) handleDirectUpload(c *gin.Context) {
	fileHeader, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Missing file form field"})
		return
	}
	objectName := c.PostForm("object_name")
	if objectName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Missing object_name form field"})
		return
	}

	fileStream, err := fileHeader.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to open uploaded file"})
		return
	}
	defer fileStream.Close()

	contentType := fileHeader.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "video/mp4"
	}

	log.Printf("Streaming raw video %s (%d bytes) to S3 bucket %s...", objectName, fileHeader.Size, app.Cfg.RawBucket)

	// Standard S3 PutObject with SigV4 (compatible with CloudWeave in dev, Neon / AWS S3 in prod)
	_, err = app.S3Client.PutObject(
		c.Request.Context(),
		app.Cfg.RawBucket,
		objectName,
		fileStream,
		fileHeader.Size,
		s3.PutObjectOptions{
			ContentType: contentType,
		},
	)
	if err != nil {
		log.Printf("S3 Direct Stream Upload Error: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("S3 upload failed: %v", err)})
		return
	}

	// Store canonical S3 path identifier in PostgreSQL
	videoID := strings.TrimPrefix(objectName, "raw-")
	videoID = strings.TrimSuffix(videoID, ".mp4")
	rawVideoUrl := fmt.Sprintf("raw/%s", objectName)
	_, _ = app.DB.Exec("UPDATE videos SET minio_manifest_url=$1 WHERE id=$2", rawVideoUrl, videoID)

	log.Printf("Successfully stored raw video %s in S3 bucket %s", objectName, app.Cfg.RawBucket)
	c.JSON(http.StatusOK, gin.H{"message": "File uploaded successfully to storage"})
}

// handleStreamVideo streams media objects from S3 to browser with byte-range seek support
func (app *App) handleStreamVideo(c *gin.Context) {
	id := c.Param("id")
	subPath := c.Param("filepath")

	var manifestUrl sql.NullString
	err := app.DB.QueryRow("SELECT minio_manifest_url FROM videos WHERE id = $1", id).Scan(&manifestUrl)
	if err != nil || !manifestUrl.Valid || manifestUrl.String == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "Video stream not found"})
		return
	}

	target := manifestUrl.String
	var bucket, objectKey string

	cleanSub := strings.TrimPrefix(subPath, "/")
	if strings.Contains(target, "master.m3u8") || cleanSub != "" {
		bucket = app.Cfg.HLSBucket
		if cleanSub == "" || cleanSub == "master.m3u8" {
			objectKey = fmt.Sprintf("%s/master.m3u8", id)
		} else {
			objectKey = fmt.Sprintf("%s/%s", id, cleanSub)
		}
	} else {
		bucket = app.Cfg.RawBucket
		objectKey = fmt.Sprintf("raw-%s.mp4", id)
	}

	opts := s3.GetObjectOptions{}
	obj, err := app.S3Client.GetObject(c.Request.Context(), bucket, objectKey, opts)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Failed to retrieve media object"})
		return
	}
	defer obj.Close()

	stat, err := obj.Stat()
	if err != nil {
		log.Printf("S3 GetObject Stat Error for %s/%s: %v", bucket, objectKey, err)
		c.JSON(http.StatusNotFound, gin.H{"error": "Stream object not found"})
		return
	}

	contentType := stat.ContentType
	lowerKey := strings.ToLower(objectKey)
	if strings.HasSuffix(lowerKey, ".m3u8") {
		contentType = "application/vnd.apple.mpegurl"
	} else if strings.HasSuffix(lowerKey, ".ts") {
		contentType = "video/MP2T"
	} else if strings.HasSuffix(lowerKey, ".mp4") {
		contentType = "video/mp4"
	}

	if contentType != "" {
		c.Header("Content-Type", contentType)
	}
	c.Header("Access-Control-Allow-Origin", "*")

	// Standard Go http.ServeContent handles Range headers (206 Partial Content),
	// Content-Range, Content-Length, HEAD requests, and browser seeking seamlessly.
	http.ServeContent(c.Writer, c.Request, objectKey, stat.LastModified, obj)
}

// handleCompleteUpload enqueues a transcode task in Redis (Asynq)
func (app *App) handleCompleteUpload(c *gin.Context) {
	var req struct {
		VideoID    string `json:"video_id" binding:"required"`
		ObjectName string `json:"object_name" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Verify that the video exists in PG and is in pending state
	var exists bool
	err := app.DB.QueryRow("SELECT EXISTS(SELECT 1 FROM videos WHERE id=$1)", req.VideoID).Scan(&exists)
	if err != nil || !exists {
		c.JSON(http.StatusNotFound, gin.H{"error": "Video record not found"})
		return
	}

	// Package task payload
	taskPayload := TranscodeTaskPayload{
		VideoID:   req.VideoID,
		InputPath: fmt.Sprintf("%s/%s", app.Cfg.RawBucket, req.ObjectName),
	}

	// Serialize payload to JSON
	// In Asynq, jobs are represented by tasks with a type name
	taskBytes, err := json.Marshal(taskPayload)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to serialize task payload"})
		return
	}

	task := asynq.NewTask("video:transcode", taskBytes)

	// Dispatch to Redis queue 'default'
	info, err := app.AsynqClient.Enqueue(task, asynq.MaxRetry(3), asynq.Timeout(time.Hour*1))
	if err != nil {
		log.Printf("Asynq Dispatch Error: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to enqueue transcoding job"})
		return
	}

	// Create a job tracking record in PostgreSQL
	jobQuery := `
		INSERT INTO transcode_jobs (video_id, asynq_task_id, status, progress) 
		VALUES ($1, $2, 'pending', 0)
	`
	_, err = app.DB.Exec(jobQuery, req.VideoID, info.ID)
	if err != nil {
		log.Printf("DB Job Tracking Write Error: %v", err)
		// Non-fatal, task is already in queue
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "Upload finalized. Transcoding job enqueued.",
		"task_id": info.ID,
		"queue":   info.Queue,
	})
}

// handleListVideos returns all public video metadata
func (app *App) handleListVideos(c *gin.Context) {
	rows, err := app.DB.Query(`
		SELECT v.id, v.title, v.description, v.category, v.visibility, COALESCE(u.name, 'Anonymous') AS author_name, v.minio_manifest_url, v.duration, v.views_count, v.created_at 
		FROM videos v
		LEFT JOIN "user" u ON v.author_id = u.id
		WHERE v.visibility = 'public' 
		ORDER BY v.created_at DESC
	`)
	if err != nil {
		log.Printf("DB handleListVideos Error: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}
	defer rows.Close()

	type VideoResponse struct {
		ID               string    `json:"id"`
		Title            string    `json:"title"`
		Description      string    `json:"description"`
		Category         string    `json:"category"`
		Visibility       string    `json:"visibility"`
		AuthorName       string    `json:"author_name"`
		ManifestURL      string    `json:"manifest_url"`
		MinioManifestURL string    `json:"minio_manifest_url,omitempty"`
		Duration         string    `json:"duration"`
		ViewsCount       int       `json:"views_count"`
		CreatedAt        time.Time `json:"created_at"`
	}

	videos := []VideoResponse{}
	for rows.Next() {
		var v VideoResponse
		var manifest sql.NullString
		err := rows.Scan(&v.ID, &v.Title, &v.Description, &v.Category, &v.Visibility, &v.AuthorName, &manifest, &v.Duration, &v.ViewsCount, &v.CreatedAt)
		if err != nil {
			log.Printf("Scan error: %v", err)
			continue
		}
		if manifest.Valid {
			v.ManifestURL = manifest.String
			v.MinioManifestURL = manifest.String
		}
		videos = append(videos, v)
	}

	c.JSON(http.StatusOK, videos)
}

// handleGetVideo gets metadata for a specific video id
func (app *App) handleGetVideo(c *gin.Context) {
	id := c.Param("id")

	var v struct {
		ID               string    `json:"id"`
		Title            string    `json:"title"`
		Description      string    `json:"description"`
		Category         string    `json:"category"`
		Visibility       string    `json:"visibility"`
		AuthorName       string    `json:"author_name"`
		ManifestURL      string    `json:"manifest_url"`
		MinioManifestURL string    `json:"minio_manifest_url,omitempty"`
		Duration         string    `json:"duration"`
		ViewsCount       int       `json:"views_count"`
		CreatedAt        time.Time `json:"created_at"`
	}

	var manifest sql.NullString
	query := `
		SELECT v.id, v.title, v.description, v.category, v.visibility, COALESCE(u.name, 'Anonymous') AS author_name, v.minio_manifest_url, v.duration, v.views_count, v.created_at 
		FROM videos v
		LEFT JOIN "user" u ON v.author_id = u.id
		WHERE v.id = $1
	`
	err := app.DB.QueryRow(query, id).Scan(&v.ID, &v.Title, &v.Description, &v.Category, &v.Visibility, &v.AuthorName, &manifest, &v.Duration, &v.ViewsCount, &v.CreatedAt)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "Video not found"})
		} else {
			log.Printf("DB handleGetVideo Error: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		}
		return
	}

	if manifest.Valid {
		v.ManifestURL = manifest.String
		v.MinioManifestURL = manifest.String
	}

	c.JSON(http.StatusOK, v)
}

// handleDeleteVideo deletes a video record from PostgreSQL and cleans up S3 storage objects
func (app *App) handleDeleteVideo(c *gin.Context) {
	id := c.Param("id")

	log.Printf("Received DELETE request for video ID: %s", id)

	// 1. Delete associated jobs from PostgreSQL transcode_jobs table
	_, errJob := app.DB.Exec("DELETE FROM transcode_jobs WHERE video_id = $1", id)
	if errJob != nil {
		log.Printf("DB Delete Transcode Job Warning: %v", errJob)
	}

	// 2. Delete main video row from PostgreSQL videos table
	res, err := app.DB.Exec("DELETE FROM videos WHERE id = $1", id)
	if err != nil {
		log.Printf("DB Delete Video Error: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete video from PostgreSQL database"})
		return
	}

	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		log.Printf("Delete target video %s not found in PostgreSQL database", id)
		c.JSON(http.StatusNotFound, gin.H{"error": "Video record not found in database"})
		return
	}

	log.Printf("Successfully deleted video %s from PostgreSQL database (rows affected: %d)", id, rowsAffected)

	// 3. Background cleanup of all storage assets in S3 (Raw uploads + HLS streams & playlists)
	go func(vid string) {
		ctx := context.Background()

		// A. Remove raw upload object from raw-uploads bucket
		rawObjectName := fmt.Sprintf("raw-%s.mp4", vid)
		err := app.S3Client.RemoveObject(ctx, app.Cfg.RawBucket, rawObjectName, s3.RemoveObjectOptions{})
		if err != nil {
			log.Printf("S3 Raw Cleanup Warning for %s: %v", rawObjectName, err)
		} else {
			log.Printf("S3 raw object %s cleaned up successfully", rawObjectName)
		}

		// B. Remove all HLS streams, master playlists, and TS segments under prefix vid/
		opts := s3.ListObjectsOptions{
			Prefix:    fmt.Sprintf("%s/", vid),
			Recursive: true,
		}
		for obj := range app.S3Client.ListObjects(ctx, app.Cfg.HLSBucket, opts) {
			if obj.Err != nil {
				log.Printf("S3 List HLS Object Error for %s: %v", obj.Key, obj.Err)
				continue
			}
			err := app.S3Client.RemoveObject(ctx, app.Cfg.HLSBucket, obj.Key, s3.RemoveObjectOptions{})
			if err != nil {
				log.Printf("S3 Remove HLS Object Warning for %s: %v", obj.Key, err)
			} else {
				log.Printf("S3 HLS object %s cleaned up successfully", obj.Key)
			}
		}
	}(id)

	c.JSON(http.StatusOK, gin.H{
		"message": "Video permanently deleted from PostgreSQL database and S3 storage",
		"id":      id,
	})
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

// handleGetVideoStatus checks transcode status and progress for a video
func (app *App) handleGetVideoStatus(c *gin.Context) {
	id := c.Param("id")

	var status string
	var progress int
	var errorMsg sql.NullString
	var manifestUrl sql.NullString

	query := `
		SELECT j.status, j.progress, j.error_message, v.minio_manifest_url
		FROM transcode_jobs j
		JOIN videos v ON j.video_id = v.id
		WHERE j.video_id = $1
		ORDER BY j.created_at DESC
		LIMIT 1
	`
	err := app.DB.QueryRow(query, id).Scan(&status, &progress, &errorMsg, &manifestUrl)
	if err != nil {
		if err == sql.ErrNoRows {
			var exists bool
			_ = app.DB.QueryRow("SELECT EXISTS(SELECT 1 FROM videos WHERE id=$1)", id).Scan(&exists)
			if exists {
				c.JSON(http.StatusOK, gin.H{
					"video_id": id,
					"status":   "pending",
					"progress": 0,
				})
				return
			}
			c.JSON(http.StatusNotFound, gin.H{"error": "Video status not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}

	resp := gin.H{
		"video_id": id,
		"status":   status,
		"progress": progress,
	}
	if errorMsg.Valid {
		resp["error_message"] = errorMsg.String
	}
	if manifestUrl.Valid {
		resp["manifest_url"] = manifestUrl.String
		resp["minio_manifest_url"] = manifestUrl.String
	}

	c.JSON(http.StatusOK, resp)
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
