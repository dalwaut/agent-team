#!/bin/bash
# Build the OPAI Theia Docker image
#
# Usage:
#   ./scripts/build-image.sh              # Build as opai-theia:latest
#   ./scripts/build-image.sh v1.0.0       # Build as opai-theia:v1.0.0

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DOCKER_DIR="${SERVICE_DIR}/docker"

TAG="${1:-latest}"
IMAGE_NAME="opai-theia:${TAG}"

echo "Building ${IMAGE_NAME}..."
echo "Context: ${DOCKER_DIR}"

docker build \
    -t "$IMAGE_NAME" \
    -f "${DOCKER_DIR}/Dockerfile" \
    "$DOCKER_DIR"

echo ""
echo "Built successfully: ${IMAGE_NAME}"
echo "Test with: docker run --rm -p 9000:3000 ${IMAGE_NAME}"
