package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/hibiken/asynq"
	_ "github.com/lib/pq"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// Config holds environment configurations
type Config struct {
	Port          string
	DBConn        string
	RedisAddr     string
	MinIOEndpoint string
	MinIOKey      string
	MinIOSecret   string
	RawBucket     string
	HLSBucket     string
}

// App holds application state
type App struct {
	DB          *sql.DB
	AsynqClient *asynq.Client
	MinIOClient *minio.Client
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
	rawEndpoint := getEnv("CLOUDWEAVE_ENDPOINT", getEnv("S3_ENDPOINT", getEnv("MINIO_ENDPOINT", "127.0.0.1:9000")))
	cfg := Config{
		Port:          getEnv("PORT", "8080"),
		DBConn:        getEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/streamify?sslmode=disable"),
		RedisAddr:     getEnv("REDIS_ADDR", "127.0.0.1:6379"),
		MinIOEndpoint: cleanEndpoint(rawEndpoint),
		MinIOKey:      getEnv("CLOUDWEAVE_API_KEY", getEnv("S3_ACCESS_KEY", getEnv("MINIO_ROOT_USER", "cw_key_streamify"))),
		MinIOSecret:   getEnv("CLOUDWEAVE_API_KEY", getEnv("S3_SECRET_KEY", getEnv("MINIO_ROOT_PASSWORD", "cw_key_streamify"))),
		RawBucket:     getEnv("MINIO_RAW_BUCKET", getEnv("S3_BUCKET", "raw-uploads")),
		HLSBucket:     getEnv("MINIO_HLS_BUCKET", "hls-streams"),
	}

	// 1. Initialize PostgreSQL
	db, err := sql.Open("postgres", cfg.DBConn)
	if err != nil {
		log.Fatalf("Failed to open DB: %v", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)

	// 2. Initialize MinIO Client
	minioClient, err := minio.New(cfg.MinIOEndpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.MinIOKey, cfg.MinIOSecret, ""),
		Secure: false,
	})
	if err != nil {
		log.Fatalf("Failed to init MinIO: %v", err)
	}

	// Ensure MinIO buckets exist
	ensureBucketsExist(minioClient, cfg.RawBucket, cfg.HLSBucket)

	// 3. Initialize Asynq client
	asynqClient := asynq.NewClient(asynq.RedisClientOpt{Addr: cfg.RedisAddr})
	defer asynqClient.Close()

	app := &App{
		DB:          db,
		MinIOClient: minioClient,
		AsynqClient: asynqClient,
		Cfg:         cfg,
	}

	// 4. Setup Router
	r := gin.Default()

	// CORS middleware
	r.Use(func(c *gin.Context) {
		c.Writer.Header().Set("Access-Control-Allow-Origin", "*")
		c.Writer.Header().Set("Access-Control-Allow-Credentials", "true")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, accept, origin, Cache-Control, X-Requested-With")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS, GET, PUT, DELETE")
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	})

	api := r.Group("/api")
	{
		api.POST("/videos/upload/init", app.handleInitUpload)
		api.POST("/videos/upload/direct", app.handleDirectUpload)
		api.POST("/videos/upload/complete", app.handleCompleteUpload)
		api.GET("/videos", app.handleListVideos)
		api.GET("/videos/:id", app.handleGetVideo)
		api.GET("/videos/:id/stream", app.handleStreamVideo)
		api.GET("/videos/:id/stream/*filepath", app.handleStreamVideo)
		api.GET("/videos/:id/status", app.handleGetVideoStatus)
		api.DELETE("/videos/:id", app.handleDeleteVideo)
	}

	log.Printf("Server listening on port %s", cfg.Port)
	if err := r.Run(":" + cfg.Port); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}

// handleInitUpload creates a PostgreSQL video entry and generates a MinIO presigned URL
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

	// Generate MinIO Presigned URL for direct client-to-MinIO uploads
	// This reduces backend memory/network pressure
	presignedURL, err := app.MinIOClient.PresignedPutObject(
		context.Background(),
		app.Cfg.RawBucket,
		objectName,
		time.Hour*2, // 2-hour upload lease
	)
	if err != nil {
		log.Printf("MinIO Presigned URL Error: %v", err)
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

// handleDirectUpload accepts a file stream from client and uploads directly to CloudWeave storage
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

	log.Printf("Streaming raw video %s (%d bytes) directly into CloudWeave storage...", objectName, fileHeader.Size)

	// Stream directly to CloudWeave native REST API (PUT /files/<bucket>/<key>)
	cloudweaveURL := fmt.Sprintf("http://%s/files/%s/%s", app.Cfg.MinIOEndpoint, app.Cfg.RawBucket, objectName)
	req, err := http.NewRequestWithContext(c.Request.Context(), "PUT", cloudweaveURL, fileStream)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to prepare CloudWeave request"})
		return
	}

	req.ContentLength = fileHeader.Size
	contentType := fileHeader.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "video/mp4"
	}
	req.Header.Set("Content-Type", contentType)

	if app.Cfg.MinIOKey != "" {
		req.Header.Set("Authorization", "Bearer "+app.Cfg.MinIOKey)
		req.Header.Set("X-API-Key", app.Cfg.MinIOKey)
	}

	client := &http.Client{Timeout: 30 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("CloudWeave Direct Stream Upload Error: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("CloudWeave upload failed: %v", err)})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		log.Printf("CloudWeave Upload Status Error (%d): %s", resp.StatusCode, string(respBody))
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("CloudWeave upload returned status %d", resp.StatusCode)})
		return
	}

	// Update PostgreSQL video record minio_manifest_url so it points directly to CloudWeave stream
	rawVideoUrl := fmt.Sprintf("http://%s/files/%s/%s", app.Cfg.MinIOEndpoint, app.Cfg.RawBucket, objectName)
	videoID := strings.TrimPrefix(objectName, "raw-")
	videoID = strings.TrimSuffix(videoID, ".mp4")
	_, _ = app.DB.Exec("UPDATE videos SET minio_manifest_url=$1 WHERE id=$2", rawVideoUrl, videoID)

	log.Printf("Successfully stored raw video %s in CloudWeave bucket %s", objectName, app.Cfg.RawBucket)
	c.JSON(http.StatusOK, gin.H{"message": "File uploaded successfully to CloudWeave"})
}

// handleStreamVideo proxies video media stream from CloudWeave to HTML5 video element with byte-range support
func (app *App) handleStreamVideo(c *gin.Context) {
	id := c.Param("id")
	subPath := c.Param("filepath")

	var manifestUrl sql.NullString
	err := app.DB.QueryRow("SELECT minio_manifest_url FROM videos WHERE id = $1", id).Scan(&manifestUrl)
	if err != nil || !manifestUrl.Valid || manifestUrl.String == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "Video stream not found"})
		return
	}

	targetUrl := manifestUrl.String
	// If stored URL is missing /files/ path for CloudWeave native HTTP server, fix path:
	if !strings.Contains(targetUrl, "/files/") {
		if strings.Contains(targetUrl, "9000/") {
			targetUrl = strings.Replace(targetUrl, "9000/", "9000/files/", 1)
		}
	}

	if subPath != "" {
		if idx := strings.LastIndex(targetUrl, "/"); idx != -1 {
			targetUrl = targetUrl[:idx] + subPath
		}
	}

	log.Printf("Proxying video stream for ID %s (subPath: %s) via CloudWeave URL: %s", id, subPath, targetUrl)

	req, err := http.NewRequestWithContext(c.Request.Context(), "GET", targetUrl, nil)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create stream request"})
		return
	}

	// Pass CloudWeave authentication headers
	if app.Cfg.MinIOKey != "" {
		req.Header.Set("X-API-Key", app.Cfg.MinIOKey)
		req.Header.Set("Authorization", "Bearer "+app.Cfg.MinIOKey)
	}

	// Forward Range header if requested by HTML5 video player
	if rangeHeader := c.GetHeader("Range"); rangeHeader != "" {
		req.Header.Set("Range", rangeHeader)
	}

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("CloudWeave HTTP Stream Fetch Error for %s: %v", targetUrl, err)
		c.JSON(http.StatusBadGateway, gin.H{"error": "CloudWeave stream unreachable"})
		return
	}
	defer resp.Body.Close()

	// Forward CloudWeave headers to browser
	for key, values := range resp.Header {
		for _, value := range values {
			c.Header(key, value)
		}
	}

	lowerUrl := strings.ToLower(targetUrl)
	if strings.HasSuffix(lowerUrl, ".mp4") {
		c.Header("Content-Type", "video/mp4")
	} else if strings.HasSuffix(lowerUrl, ".m3u8") {
		c.Header("Content-Type", "application/x-mpegURL")
	} else if strings.HasSuffix(lowerUrl, ".ts") {
		c.Header("Content-Type", "video/MP2T")
	}

	c.Header("Access-Control-Allow-Origin", "*")
	c.Status(resp.StatusCode)

	_, _ = io.Copy(c.Writer, resp.Body)
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
		MinioManifestURL string    `json:"minio_manifest_url"`
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
		MinioManifestURL string    `json:"minio_manifest_url"`
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
		v.MinioManifestURL = manifest.String
	}

	c.JSON(http.StatusOK, v)
}

// handleDeleteVideo deletes a video record from PostgreSQL and cleans up MinIO objects
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

	// 3. Background cleanup of all storage assets in MinIO (Raw uploads + HLS streams & playlists)
	go func(vid string) {
		ctx := context.Background()

		// A. Remove raw upload object from raw-uploads bucket
		rawObjectName := fmt.Sprintf("raw-%s.mp4", vid)
		err := app.MinIOClient.RemoveObject(ctx, app.Cfg.RawBucket, rawObjectName, minio.RemoveObjectOptions{})
		if err != nil {
			log.Printf("MinIO Raw Cleanup Warning for %s: %v", rawObjectName, err)
		} else {
			log.Printf("MinIO raw object %s cleaned up successfully", rawObjectName)
		}

		// B. Remove all HLS streams, master playlists, and TS segments under prefix vid/
		opts := minio.ListObjectsOptions{
			Prefix:    fmt.Sprintf("%s/", vid),
			Recursive: true,
		}
		for obj := range app.MinIOClient.ListObjects(ctx, app.Cfg.HLSBucket, opts) {
			if obj.Err != nil {
				log.Printf("MinIO List HLS Object Error for %s: %v", obj.Key, obj.Err)
				continue
			}
			err := app.MinIOClient.RemoveObject(ctx, app.Cfg.HLSBucket, obj.Key, minio.RemoveObjectOptions{})
			if err != nil {
				log.Printf("MinIO Remove HLS Object Warning for %s: %v", obj.Key, err)
			} else {
				log.Printf("MinIO HLS object %s cleaned up successfully", obj.Key)
			}
		}
	}(id)

	c.JSON(http.StatusOK, gin.H{
		"message": "Video permanently deleted from PostgreSQL database and MinIO object storage",
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
		resp["minio_manifest_url"] = manifestUrl.String
	}

	c.JSON(http.StatusOK, resp)
}

func ensureBucketsExist(minioClient *minio.Client, buckets ...string) {
	ctx := context.Background()
	for _, bucket := range buckets {
		exists, err := minioClient.BucketExists(ctx, bucket)
		if err != nil || !exists {
			err = minioClient.MakeBucket(ctx, bucket, minio.MakeBucketOptions{})
			if err != nil {
				log.Printf("Note: CloudWeave bucket %s initialization: %v", bucket, err)
			} else {
				log.Printf("Successfully initialized CloudWeave bucket: %s", bucket)
			}
		}
	}
}
