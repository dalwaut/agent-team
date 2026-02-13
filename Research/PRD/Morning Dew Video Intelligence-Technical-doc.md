Technical Architecture Spec
Project: Morning Dew Video Intelligence Engine (MDVIE)

Version: 1.0 (v1 build spec)
Scope: Internal tool first; modular to productize later

1) System Overview

MDVIE is a pipeline + UI that turns an organized project folder (e.g., 50 clips) into:

Full-text searchable transcripts with timestamps

Semantic search across the whole project

Topic/narrative clusters (problem→solution arcs)

Suggested episode “cuts” (ordered timecoded selects)

Optional rough-cut assembly using proxies (fast) and/or EDL/XML export

Key design choice: compute-heavy steps are asynchronous and can run on cloud infrastructure, while user editing/review stays lightweight.

2) High-Level Architecture
Components

Ingestion Service

Registers clips, computes hashes, extracts metadata

Media Processing Workers

Proxy generation (CFR/SDR), audio extraction, waveform, loudness stats

Transcription Service

Cloud STT or local Whisper runner (pluggable)

Indexing Service

Chunking, embeddings, vector upserts, keyword indexing

Narrative Intelligence Service

Clustering, scoring, arc proposals, hook detection

Assembly Service (optional v1, recommended)

Generates “selects reel” with proxies, trims silence, normalizes audio

Web App (UI)

Project dashboard, search, clusters, episode builder

Storage Layer

Object storage for media + proxies; DB for metadata; vector DB for embeddings

Orchestrator / Queue

Job queue, retries, progress tracking

Data Flows

Folder → Ingestion → (Proxies + Audio) → Transcribe → Chunk/Embed → Cluster/Arcs → Episode Draft → Rough Cut/Export

3) Deployment Model
Recommended (fastest + cheapest to operate)

Frontend: Next.js (or similar) on Vercel/Cloudflare Pages

Backend API: FastAPI / Node on a small VPS or serverless (depending on your preference)

Workers: Containerized workers on VPS/Docker, or managed (e.g., ECS/Cloud Run)

Storage: S3-compatible object storage (S3, Backblaze B2, Cloudflare R2, MinIO)

DB: Postgres (Supabase or self-host)

Vector: pgvector (inside Postgres) for v1; Pinecone/Qdrant optional later

Queue: Redis + BullMQ/Celery/RQ, or Supabase queues if you prefer simplicity

Why this works without a “supercomputer”

The user machine only uploads and reviews.

Transcription + embedding + clustering run on workers/cloud.

4) Storage & Data Model
4.1 Object Storage Layout

Bucket: mdvie-media

projects/{project_id}/originals/{clip_id}.{ext}

projects/{project_id}/proxies/{clip_id}_proxy.mp4

projects/{project_id}/audio/{clip_id}.wav

projects/{project_id}/exports/{episode_id}/selects_proxy.mp4

projects/{project_id}/exports/{episode_id}/final_edit_package.zip (optional)

4.2 Postgres Schema (Core Tables)
projects

id (uuid pk)

name

created_at

status (enum: created, processing, ready, error)

source_path (logical label only; do not store local FS paths if you can avoid it)

settings_json (proxy preset, transcription provider, chunk sizes)

clips

id (uuid pk)

project_id (fk)

filename

original_uri

proxy_uri

audio_uri

sha256

duration_ms

width, height

fps_num, fps_den

is_vfr (bool)

color_space (e.g., bt709, bt2020, hdr flags)

created_time (if extracted)

device_make, device_model (if available)

ingested_at

transcripts

id (uuid pk)

clip_id (fk)

provider (whisper_api/local/other)

language

text (full)

words_json (word-level timestamps)

segments_json (sentence/segment timestamps)

confidence_avg

created_at

chunks

id (uuid pk)

project_id (fk)

clip_id (fk)

start_ms, end_ms

text

speaker (optional v2)

embedding (vector or external id)

keywords_tsv (Postgres tsvector)

energy_score (optional)

created_at

clusters

id (uuid pk)

project_id (fk)

label

summary

chunk_ids (array or join table cluster_members)

score

created_at

episode_drafts

id (uuid pk)

project_id (fk)

title_suggestion

hook_segment (clip_id + start/end)

outline_json (ordered segments with timecodes)

runtime_estimate_ms

status (draft, approved, exported)

created_at

episodes

id (uuid pk)

project_id (fk)

draft_id (fk)

segments_json (final ordered list)

export_proxy_uri

export_xml_uri (optional)

export_notes

created_at

jobs

id (uuid pk)

project_id (fk)

type (ingest, proxy, transcribe, embed, cluster, assemble)

status (queued, running, success, error)

progress (0–100)

error_message

created_at, updated_at

5) Processing Pipeline Details
5.1 Ingestion

Input: folder selection or multi-file upload
Outputs: clips rows + objects in storage

Tasks:

Extract metadata via ffprobe

Hash (sha256) to dedupe

Create job chain: proxy → audio → transcription → chunk/embed → cluster → arc proposals

Idempotency:

If sha256 exists in project, skip re-upload and reuse artifacts.

5.2 Proxy Generation

Goal: make the timeline smooth and consistent.

Defaults:

Proxy resolution: 1080p (or 720p for weak machines)

CFR: 30fps

SDR: bt709

Audio: AAC 160kbps stereo

Keyframes: 2 seconds (helps seeking)

Also compute:

Loudness stats (LUFS), peak, RMS

Silence regions (for auto-trim)

5.3 Audio Extraction

WAV 16k/24k mono for transcription efficiency

Store per clip

5.4 Transcription

Pluggable interface:

TranscriptionProvider.transcribe(audio_uri) -> words_json + segments_json + text

Provider options:

Cloud Whisper-style API (recommended)

Local Whisper (fallback)

Must store word-level timestamps for exact cutting.

5.5 Chunking + Indexing

Chunk strategies (v1):

Sentence-based segments from transcript provider

Merge into ~15–45s chunks for embeddings

Store:

chunks.text

start_ms/end_ms

keywords_tsv for keyword search

vector embedding

Hybrid search:

Full-text search (Postgres tsvector) + semantic (vector)

Combined scoring in API (weighted)

5.6 Clustering + Narrative Arc Proposal

Inputs: chunk embeddings + timestamps + loudness/energy heuristics

Outputs:

6–15 clusters per project (topic buckets)

3–5 episode draft arcs per project:

Hook candidate

Core steps

Problem moment(s)

Resolution

“Tease next”

Scoring heuristics (v1):

High density of action/problem verbs (“broke”, “failed”, “stuck”, “fixed”)

Emotional/attention words (“can’t believe”, “finally”, “we messed up”)

Energy: louder/less silence

Repetition penalty (similar chunks down-weighted)

6) Assembly & Export
6.1 Selects Reel (v1 recommended)

Build a single MP4 using proxies

Cuts by timecode segments (clip_id + in/out)

Optional:

Silence trim (threshold + min duration)

Normalize audio to target LUFS

Simple crossfade

This yields a watchable rough cut fast.

6.2 Edit Package Export (v1.5+)

Export:

EDL or FCPXML for NLE relink

JSON “source mapping” to originals

Provide a relink guide for Premiere/Resolve

Relink mechanism:

Keep stable clip IDs + original filenames

Store timecode in milliseconds (convert to frames at export time)

7) API Design (Backend)

Base: /api/v1

Projects

POST /projects create project

GET /projects list

GET /projects/{id} details + status + progress

DELETE /projects/{id} (admin only)

Clips

POST /projects/{id}/clips register upload complete

GET /projects/{id}/clips list with metadata

Search

GET /projects/{id}/search?q=...&mode=hybrid

returns ranked chunks with timestamps + preview text

Clusters & Arcs

GET /projects/{id}/clusters

GET /projects/{id}/drafts (episode draft proposals)

POST /projects/{id}/drafts/{draft_id}/approve

Episodes

POST /projects/{id}/episodes create from selected segments

POST /episodes/{episode_id}/export (selects reel, xml, etc.)

GET /episodes/{episode_id}

Jobs

GET /projects/{id}/jobs

POST /projects/{id}/jobs/retry

8) UI Architecture

Pages:

Projects

status, processing progress, “ready” indicator

Project Detail

clip list, transcript health, job timeline

Search

query box, results list with “Add to Episode”

Clusters

cluster cards, summaries, “Build episode from cluster”

Episode Builder

ordered segment list

drag reorder

trim in/out by seconds

runtime estimate

Export

selects reel download

export package download

notes for final polish

UX principle: you should be able to create an episode without ever scrubbing raw footage.

9) Security & Privacy

Auth: JWT/session via Supabase Auth or your auth provider

Row-level security (if Supabase): projects are private to owner

Object storage:

private buckets

signed URLs for upload/download

Secrets:

transcription API keys in server env only

Data retention:

ability to purge originals while keeping transcripts/embeddings (optional)

10) Observability & Reliability

Metrics:

job durations per stage (proxy/transcribe/embed/cluster/assemble)

transcription failure rate

average cost per hour of footage (if using paid API)

Logging:

structured logs per job with project_id, clip_id

store last error + stack trace (server-side)

Retries:

exponential backoff

dead-letter queue for repeated failures

idempotent job handlers (check artifacts exist before recompute)

11) Scaling Strategy

v1 scale target: 1 user, projects up to 6 hours total footage.

Bottlenecks:

Proxy generation CPU time

Transcription throughput/cost

Scaling levers:

Parallelize per clip for proxy/audio/transcribe

Batch embeddings by chunk

Cache transcripts/embeddings by sha256 to avoid reprocessing

12) Technology Choices (Recommended Defaults)

Backend: FastAPI (Python) or Node (Nest/Express)

Workers: Python + FFmpeg + Redis queue

DB: Postgres + pgvector

Storage: S3-compatible

Transcription: Cloud Whisper-style API (default), local fallback

Embeddings: OpenAI embeddings (or equivalent), stored in pgvector

UI: Next.js + Tailwind

13) Definition of Done (v1)

A project with ~50 clips (mixed 1080p/4K) can be processed end-to-end such that:

All clips have proxies + audio extracted

Transcripts are searchable (keyword + semantic)

3–5 episode drafts are generated automatically with timecoded selects

User can approve a draft and export a selects reel (proxy MP4)

System shows job progress + recoverable errors