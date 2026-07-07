#!/bin/bash

# Payment API Service - Quickstart Setup Script
# This script sets up the development environment with PostgreSQL and runs migrations

set -e

echo "🚀 Payment API Service - Quickstart Setup"
echo "=========================================="

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker and try again."
    exit 1
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose is not installed. Please install Docker Compose and try again."
    exit 1
fi

echo "✓ Docker and Docker Compose are installed"

# Clean up old containers
echo ""
echo "🧹 Cleaning up old containers..."
docker-compose down 2>/dev/null || true

# Start PostgreSQL
echo ""
echo "📦 Starting PostgreSQL..."
docker-compose up -d postgres

# Wait for PostgreSQL to be ready
echo ""
echo "⏳ Waiting for PostgreSQL to be ready..."
for i in {1..30}; do
    if docker-compose exec -T postgres pg_isready -U payments > /dev/null 2>&1; then
        echo "✓ PostgreSQL is ready"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "❌ PostgreSQL failed to start"
        exit 1
    fi
    sleep 1
done

# Install dependencies
echo ""
echo "📚 Installing dependencies..."
npm install

# Run migrations
echo ""
echo "🔄 Running database migrations..."
export DATABASE_URL=postgres://payments:payments@localhost:5432/payments
npm run migrate

# Start mock provider in background
echo ""
echo "🏢 Starting mock provider service..."
PROVIDER_MODE=success npx ts-node src/provider/server.ts > /tmp/provider.log 2>&1 &
PROVIDER_PID=$!

# Wait for provider to start
sleep 2

# Start API
echo ""
echo "🌐 Starting API server..."
npm run dev &
API_PID=$!

# Display access info
echo ""
echo "=========================================="
echo "✓ Setup complete! Services are running:"
echo "=========================================="
echo ""
echo "📌 API:           http://localhost:3000"
echo "📌 Health:        http://localhost:3000/health"
echo "📌 Metrics:       http://localhost:3000/metrics"
echo "📌 Mock Provider: http://localhost:4000"
echo ""
echo "📝 Logs:"
echo "   Provider:  tail -f /tmp/provider.log"
echo ""
echo "🧪 Run tests:"
echo "   npm test"
echo ""
echo "⚡ Stop services:"
echo "   kill $API_PID $PROVIDER_PID"
echo ""
