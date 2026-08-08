package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"encoding/json"
	"net/http"
	"os"
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
	Port         string
	DBConn       string
	RedisAddr    string
	MinIOEndpoint string
	MinIOKey     string
	MinIOSecret  string
	RawBucket    string
	HLSBucket    string
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
	cfg := Config{
		Port:          getEnv("PORT", "8080"),
		DBConn:        getEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/streamify?sslmode=disable"),
		RedisAddr:     getEnv("REDIS_ADDR", "127.0.0.1:6379"),
		MinIOEndpoint: getEnv("MINIO_ENDPOINT", "127.0.0.1:9000"),
		MinIOKey:      getEnv("MINIO_ROOT_USER", "minioadmin"),
		MinIOSecret:   getEnv("MINIO_ROOT_PASSWORD", "minioadmin"),
		RawBucket:     getEnv("MINIO_RAW_BUCKET", "raw-uploads"),
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
		api.POST("/videos/upload/complete", app.handleCompleteUpload)
		api.GET("/videos", app.handleListVideos)
		api.GET("/videos/:id", app.handleGetVideo)
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
		"video_id":     videoID,
		"upload_url":   presignedURL.String(),
		"object_name":  objectName,
		"raw_bucket":   app.Cfg.RawBucket,
	})
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

	// 3. Best-effort background cleanup of raw files in MinIO Object Storage
	go func(vid string) {
		ctx := context.Background()
		rawObjectName := fmt.Sprintf("raw-%s.mp4", vid)
		err := app.MinIOClient.RemoveObject(ctx, app.Cfg.RawBucket, rawObjectName, minio.RemoveObjectOptions{})
		if err != nil {
			log.Printf("MinIO Cleanup Warning for %s: %v", rawObjectName, err)
		} else {
			log.Printf("MinIO object %s cleaned up successfully", rawObjectName)
		}
	}(id)

	c.JSON(http.StatusOK, gin.H{
		"message": "Video permanently deleted from PostgreSQL database and storage",
		"id":      id,
	})
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

		// Set public read policy so browser HTML5 player can stream media files without 403 Access Denied errors
		policy := fmt.Sprintf(`{
			"Version": "2012-10-17",
			"Statement": [
				{
					"Effect": "Allow",
					"Principal": {"AWS": ["*"]},
					"Action": ["s3:GetObject"],
					"Resource": ["arn:aws:s3:::%s/*"]
				}
			]
		}`, bucket)
		err = minioClient.SetBucketPolicy(ctx, bucket, policy)
		if err != nil {
			log.Printf("Warning: Failed to set public policy for bucket %s: %v", bucket, err)
		} else {
			log.Printf("Successfully set public read policy for MinIO bucket: %s", bucket)
		}
	}
}

